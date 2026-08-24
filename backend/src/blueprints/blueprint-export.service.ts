import { Injectable, NotFoundException, HttpException } from '@nestjs/common';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { nanoid } from 'nanoid';
import { eq, and } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { EventsService } from '../events/events.service';
import { PathGuardService } from '../storage/path-guard.service';
import { StorageIndexService } from '../storage/storage-index.service';
import { ServerQueryService } from '../servers/server-query.service';
import { ServerLifecycleService } from '../servers/server-lifecycle.service';
import { PacksService } from '../packs/packs.service';
import { WorldPropsService } from '../worlds/world-props.service';
import type { Server } from '../servers/types';
import { blueprints, serverContent, libraryFiles } from '../db/schema';
import { archiver, slugify } from './zip.util';
import {
  PANEL_VERSION,
  SECRET_ENV_RE,
  type BlueprintManifest,
  type ExportOptions,
  type OverlayEntry,
} from './blueprints.types';

/** Export a server's full recipe as a portable `.mcserver.zip` blueprint. */
@Injectable()
export class BlueprintExportService {
  constructor(
    private readonly dbService: DbService,
    private readonly events: EventsService,
    private readonly pathGuard: PathGuardService,
    private readonly storageIndex: StorageIndexService,
    private readonly serverQuery: ServerQueryService,
    private readonly lifecycle: ServerLifecycleService,
    private readonly packs: PacksService,
    private readonly worldProps: WorldPropsService,
  ) {}

  private get db() {
    return this.dbService.db;
  }

  /**
   * Export a server as a .mcserver.zip in data/blueprints.
   * options: { includeConfig (server.properties + config/), embedFiles (bundle
   * overlay jars for offline portability), includeWorld }.
   */
  async exportBlueprint(
    serverId: string,
    options: ExportOptions = {},
    { actor = 'system' }: { actor?: string } = {},
  ) {
    const server = await this.serverQuery.getServer(serverId);
    if (!server) throw new NotFoundException('Server not found');
    const includeConfig = options.includeConfig !== false;
    const embedFiles = Boolean(options.embedFiles);
    const includeWorld = Boolean(options.includeWorld);
    const serverDir = this.pathGuard.dataPath('servers', serverId);

    const pack = await this.packs.getPack(serverId);
    const overlayRows = await this.db
      .select({
        name: serverContent.name,
        kind: serverContent.kind,
        filename: serverContent.filename,
        version: serverContent.version,
        libSourceUrl: libraryFiles.sourceUrl,
        libPlatform: libraryFiles.platform,
        libProjectId: libraryFiles.projectId,
        libFileId: libraryFiles.fileId,
        libSha256: libraryFiles.sha256,
        libVersion: libraryFiles.version,
        libRelPath: libraryFiles.relPath,
      })
      .from(serverContent)
      .leftJoin(libraryFiles, eq(libraryFiles.id, serverContent.libraryId))
      .where(
        and(
          eq(serverContent.serverId, serverId),
          eq(serverContent.managedBy, 'overlay'),
        ),
      );

    const configFiles = includeConfig ? this.collectConfigFiles(serverDir) : [];
    const worldDirs = includeWorld ? this.worldDirsOf(server, serverDir) : [];
    if (includeWorld && worldDirs.length) {
      const needed = worldDirs.reduce(
        (n, d) => n + this.lifecycle.dirSize(d.abs),
        0,
      );
      const { free } = await this.storageIndex.diskFree();
      if (free < needed * 1.1) {
        throw new HttpException(
          `Not enough disk space to embed the world (~${(needed / 1024 ** 3).toFixed(1)} GB needed)`,
          507,
        );
      }
    }

    const manifest: BlueprintManifest = {
      msm: 1,
      name: server.display_name,
      createdAt: new Date().toISOString(),
      panelVersion: PANEL_VERSION,
      notes: server.notes || '',
      identity: {
        name: server.display_name,
        description: server.description || '',
        icon: server.icon || 'grass',
        accent: server.accent || '#3fa62b',
        tags: server.tags || [],
      },
      config: {
        type: server.type,
        mcVersion: server.mc_version,
        javaTag: server.java_tag || '',
        env: this.sanitizeEnv(server.env),
      },
      resources: {
        heapMb: server.heap_mb,
        containerMemoryMb: server.container_memory_mb,
        cpus: server.cpus,
        diskQuotaGb: Math.round(server.disk_quota_bytes / 1024 ** 3),
        quotaStrict: Boolean(server.quota_strict),
        updatePolicy: server.update_policy || 'manual',
      },
      pack: pack
        ? {
            platform: pack.platform as NonNullable<
              BlueprintManifest['pack']
            >['platform'],
            projectRef: pack.projectRef,
            projectName: pack.projectName,
            versionId: pack.pinnedVersionId,
            versionName: pack.pinnedVersionName,
          }
        : null,
      overlay: overlayRows.map((r): OverlayEntry => ({
        name: r.name,
        kind: r.kind as OverlayEntry['kind'],
        filename: r.filename,
        sourceUrl: r.libSourceUrl || null,
        platform: r.libPlatform || null,
        projectId: r.libProjectId || null,
        fileId: r.libFileId || null,
        version: r.libVersion || r.version || null,
        sha256: r.libSha256 || null,
      })),
      configFiles,
      embedFiles,
      world: includeWorld && worldDirs.length > 0,
    };

    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    const filename = `${slugify(server.display_name)}-${stamp}.mcserver.zip`;
    const relPath = `blueprints/${filename}`;
    const absPath = this.pathGuard.dataPath(relPath);
    await fsp.mkdir(path.dirname(absPath), { recursive: true });

    await new Promise<void>((resolve, reject) => {
      const output = fs.createWriteStream(absPath);
      const archive = archiver('zip', { zlib: { level: 6 } });
      output.on('close', resolve);
      archive.on('error', reject);
      archive.pipe(output);
      archive.append(JSON.stringify(manifest, null, 2), {
        name: 'manifest.json',
      });
      for (const rel of configFiles) {
        archive.file(this.pathGuard.safeJoin(serverDir, rel), {
          name: `payload/config/${rel}`,
        });
      }
      if (embedFiles) {
        for (const row of overlayRows) {
          if (
            row.libRelPath &&
            fs.existsSync(this.pathGuard.dataPath(row.libRelPath))
          ) {
            archive.file(this.pathGuard.dataPath(row.libRelPath), {
              name: `payload/overlay/${row.filename}`,
            });
          }
        }
      }
      for (const dir of worldDirs)
        archive.directory(dir.abs, `payload/world/${dir.name}`);
      archive.finalize();
    });

    const size = (await fsp.stat(absPath)).size;
    const id = `bp_${nanoid(8)}`;
    await this.db
      .insert(blueprints)
      .values({
        id,
        name: server.display_name,
        filename,
        relPath,
        sizeBytes: size,
        builtin: false,
        manifestJson: JSON.stringify(manifest),
      });
    this.events.recordEvent({
      serverId,
      actor,
      type: 'blueprint-exported',
      summary: `Blueprint exported: ${server.display_name} (${filename}, ${(size / 1024 ** 2).toFixed(1)} MB)`,
      details: {
        id,
        filename,
        includeConfig,
        embedFiles,
        includeWorld,
        overlayCount: manifest.overlay.length,
      },
    });
    this.storageIndex.scan().catch(() => {});
    const [row] = await this.db
      .select()
      .from(blueprints)
      .where(eq(blueprints.id, id))
      .limit(1);
    return row!;
  }

  collectConfigFiles(serverDir: string): string[] {
    const rels: string[] = [];
    if (fs.existsSync(path.join(serverDir, 'server.properties')))
      rels.push('server.properties');
    const walk = (abs: string, rel: string) => {
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(abs, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const childRel = `${rel}/${entry.name}`;
        if (entry.isDirectory()) walk(path.join(abs, entry.name), childRel);
        else if (entry.isFile()) rels.push(childRel);
      }
    };
    if (fs.existsSync(path.join(serverDir, 'config')))
      walk(path.join(serverDir, 'config'), 'config');
    return rels;
  }

  /** World dirs to embed: the active level dir plus its Bukkit-style split siblings. */
  worldDirsOf(
    server: Server,
    serverDir: string,
  ): { name: string; abs: string }[] {
    // activeLevelName honors LEVEL env AND server.properties level-name — a
    // renamed/activated world would otherwise be silently missing from exports.
    const level = this.worldProps.activeLevelName(server);
    return [level, `${level}_nether`, `${level}_the_end`]
      .map((name) => ({ name, abs: path.join(serverDir, name) }))
      .filter((d) => fs.existsSync(d.abs) && fs.statSync(d.abs).isDirectory());
  }

  sanitizeEnv(
    env: Record<string, string> | null | undefined,
  ): Record<string, string> {
    return Object.fromEntries(
      Object.entries(env || {}).filter(([k]) => !SECRET_ENV_RE.test(k)),
    );
  }
}
