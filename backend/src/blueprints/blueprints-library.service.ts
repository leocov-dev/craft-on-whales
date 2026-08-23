import { Injectable, NotFoundException } from '@nestjs/common';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { nanoid } from 'nanoid';
import { desc, eq } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { EventsService } from '../events/events.service';
import { PathGuardService } from '../storage/path-guard.service';
import { ConfigService } from '../config/config.service';
import { blueprints, settings } from '../db/schema';
import { archiver, slugify } from './zip.util';
import { PANEL_VERSION, type BlueprintManifest, type OverlayEntry } from './blueprints.types';

type BlueprintRow = typeof blueprints.$inferSelect;

export interface DecoratedBlueprint extends BlueprintRow {
  manifest: Partial<BlueprintManifest>;
  notes: string;
  pack: string | null;
  overlayCount: number;
  type: string;
  mcVersion: string;
  world: boolean;
  created: string;
}

/** Blueprint library CRUD + first-run starter seeding. */
@Injectable()
export class BlueprintsLibraryService {
  constructor(
    private readonly dbService: DbService,
    private readonly events: EventsService,
    private readonly pathGuard: PathGuardService,
    private readonly config: ConfigService
  ) {}

  private get db() {
    return this.dbService.db;
  }

  async listBlueprints(): Promise<DecoratedBlueprint[]> {
    const rows = await this.db
      .select()
      .from(blueprints)
      .orderBy(desc(blueprints.builtin), desc(blueprints.createdAt));
    return rows.map((row) => this.decorate(row));
  }

  async getBlueprint(id: string): Promise<DecoratedBlueprint | null> {
    const [row] = await this.db.select().from(blueprints).where(eq(blueprints.id, id)).limit(1);
    return row ? this.decorate(row) : null;
  }

  async getBlueprintPath(id: string): Promise<string> {
    const [row] = await this.db.select().from(blueprints).where(eq(blueprints.id, id)).limit(1);
    if (!row) throw new NotFoundException('Blueprint not found');
    return this.pathGuard.dataPath(row.relPath);
  }

  async deleteBlueprint(id: string, { actor = 'system' }: { actor?: string } = {}): Promise<{ freedBytes: number }> {
    const [row] = await this.db.select().from(blueprints).where(eq(blueprints.id, id)).limit(1);
    if (!row) throw new NotFoundException('Blueprint not found');
    await fsp.rm(this.pathGuard.dataPath(row.relPath), { force: true });
    await this.db.delete(blueprints).where(eq(blueprints.id, id));
    this.events.recordEvent({
      actor,
      type: 'blueprint-deleted',
      summary: `Blueprint deleted: ${row.name} (${(row.sizeBytes / 1024 ** 2).toFixed(1)} MB freed)`,
      details: { id, filename: row.filename },
    });
    return { freedBytes: row.sizeBytes };
  }

  /** Row + fields derived from the cached manifest for lists/cards. */
  private decorate(row: BlueprintRow): DecoratedBlueprint {
    let manifest: Partial<BlueprintManifest> = {};
    try {
      manifest = JSON.parse(row.manifestJson);
    } catch {
      /* corrupt cache — show bare row */
    }
    return {
      ...row,
      manifest,
      notes: manifest.notes || (manifest.identity && manifest.identity.description) || '',
      pack: manifest.pack ? `${manifest.pack.projectName || manifest.pack.projectRef} @ ${manifest.pack.versionName || manifest.pack.versionId}` : null,
      overlayCount: Array.isArray(manifest.overlay) ? manifest.overlay.length : 0,
      type: manifest.config ? manifest.config.type : '',
      mcVersion: manifest.config ? manifest.config.mcVersion : '',
      world: Boolean(manifest.world),
      created: row.createdAt,
    };
  }

  // ---- Starter blueprints (first-run seed) ----

  /** Ship two preset blueprints once. A settings flag prevents re-seeding after the user deletes them. */
  async seedStarters(): Promise<{ seeded: number; blueprints?: unknown[] }> {
    const [seededFlag] = await this.db.select().from(settings).where(eq(settings.key, 'blueprints_seeded')).limit(1);
    if (seededFlag) return { seeded: 0 };
    const [builtinExisting] = await this.db.select().from(blueprints).where(eq(blueprints.builtin, true)).limit(1);
    if (builtinExisting) return { seeded: 0 };

    const created = [];
    for (const manifest of [this.paperStarterManifest(), this.fabricStarterManifest()]) {
      created.push(await this.writeManifestOnlyBlueprint(manifest, { builtin: true }));
    }
    await this.db.insert(settings).values({ key: 'blueprints_seeded', valueJson: 'true' });
    this.events.recordEvent({
      actor: 'system',
      type: 'blueprints-seeded',
      summary: `Starter blueprints installed: ${created.map((c) => c.name).join(', ')}`,
    });
    return { seeded: created.length, blueprints: created };
  }

  private paperStarterManifest(): BlueprintManifest {
    return {
      msm: 1,
      name: 'Optimized Paper Survival',
      createdAt: new Date().toISOString(),
      panelVersion: PANEL_VERSION,
      notes: 'Paper with Aikar JVM flags and sane survival defaults — a fast vanilla-plus base.',
      identity: {
        name: 'Optimized Paper Survival',
        description: 'Paper with Aikar JVM flags and sane survival defaults — a fast vanilla-plus base.',
        icon: 'grass',
        accent: '#3fa62b',
        tags: ['paper', 'survival', 'optimized'],
      },
      config: {
        type: 'PAPER',
        mcVersion: 'LATEST',
        javaTag: '',
        env: { USE_AIKAR_FLAGS: 'true', VIEW_DISTANCE: '12' },
      },
      resources: this.starterResources(),
      pack: null,
      overlay: [],
      configFiles: [],
      embedFiles: false,
      world: false,
    };
  }

  private fabricStarterManifest(): BlueprintManifest {
    // Manifest-only overlay refs: sha256 null = skip verification, the latest
    // compatible build is resolved from the project page at import time.
    const mod = (name: string, slug: string): OverlayEntry => ({
      name,
      kind: 'mod',
      filename: null,
      sourceUrl: `https://modrinth.com/mod/${slug}`,
      platform: 'modrinth',
      projectId: null,
      fileId: null,
      version: null,
      sha256: null,
    });
    return {
      msm: 1,
      name: 'Fabric Performance Base',
      createdAt: new Date().toISOString(),
      panelVersion: PANEL_VERSION,
      notes: 'Fabric with Lithium, FerriteCore, Krypton and Spark — a lean modded starting point.',
      identity: {
        name: 'Fabric Performance Base',
        description: 'Fabric with Lithium, FerriteCore, Krypton and Spark — a lean modded starting point.',
        icon: 'diamond',
        accent: '#21a7ab',
        tags: ['fabric', 'performance'],
      },
      config: { type: 'FABRIC', mcVersion: 'LATEST', javaTag: '', env: {} },
      resources: this.starterResources(),
      pack: null,
      overlay: [mod('Lithium', 'lithium'), mod('FerriteCore', 'ferrite-core'), mod('Krypton', 'krypton'), mod('Spark', 'spark')],
      configFiles: [],
      embedFiles: false,
      world: false,
    };
  }

  // Starter blueprints inherit the panel's host-aware resource defaults so
  // they import cleanly on a small VPS as well as a big workstation.
  private starterResources() {
    const d = this.config.defaults;
    return {
      heapMb: d.heapMb,
      containerMemoryMb: d.containerMemoryMb,
      cpus: d.cpus,
      diskQuotaGb: d.diskQuotaGb,
      quotaStrict: false,
      updatePolicy: 'manual' as const,
    };
  }

  private async writeManifestOnlyBlueprint(manifest: BlueprintManifest, { builtin = false }: { builtin?: boolean } = {}): Promise<BlueprintRow> {
    const filename = `${slugify(manifest.name)}.mcserver.zip`;
    const relPath = `blueprints/${filename}`;
    const absPath = this.pathGuard.dataPath(relPath);
    await fsp.mkdir(path.dirname(absPath), { recursive: true });
    await new Promise<void>((resolve, reject) => {
      const output = fs.createWriteStream(absPath);
      const archive = archiver('zip', { zlib: { level: 6 } });
      output.on('close', resolve);
      archive.on('error', reject);
      archive.pipe(output);
      archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });
      archive.finalize();
    });
    const size = (await fsp.stat(absPath)).size;
    const id = `bp_${nanoid(8)}`;
    await this.db
      .insert(blueprints)
      .values({ id, name: manifest.name, filename, relPath, sizeBytes: size, builtin, manifestJson: JSON.stringify(manifest) });
    const [row] = await this.db.select().from(blueprints).where(eq(blueprints.id, id)).limit(1);
    return row!;
  }
}
