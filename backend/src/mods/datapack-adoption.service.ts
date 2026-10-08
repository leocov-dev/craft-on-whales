import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import * as fsp from 'node:fs/promises';
import { and, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { DbService } from '../db/db.service';
import { serverContent } from '../db/schema';
import { EventsService } from '../events/events.service';
import {
  LibraryService,
  type LibraryFileRow,
} from '../library/library.service';
import { ServerQueryService } from '../servers/server-query.service';
import type { Server } from '../servers/types';
import type {
  DatapackAdoptionDetail,
  DatapackAdoptionReport,
} from '../../../shared/types/mods';
import { DatapackIconService } from './datapack-icon.service';
import { DatapacksService, type DiskPack } from './datapacks.service';
import { JarIdentifierService } from './jar-identifier.service';
import type { IdentifiedJar } from './mods.types';

/**
 * Zips are hashed in memory, a batch at a time. Peak memory is at most
 * IDENTIFY_BATCH x MAX_IDENTIFY_BYTES (64 MB); keep MODS_NOTES.md in step.
 */
const IDENTIFY_BATCH = 4;
/** A datapack zip bigger than this is adopted by file name only (not read into memory to hash). */
const MAX_IDENTIFY_BYTES = 16 * 1024 * 1024;

type ContentRow = typeof serverContent.$inferSelect;
/** Library rows of this run's content rows, fetched once (one query) and read synchronously. */
type LibraryRows = Map<string, LibraryFileRow>;
type RegistryMatch = IdentifiedJar & { platform: 'modrinth' | 'curseforge' };

function isRegistryMatch(jar: IdentifiedJar | undefined): jar is RegistryMatch {
  return (
    !!jar &&
    !!jar.projectId &&
    (jar.platform === 'modrinth' || jar.platform === 'curseforge')
  );
}

/** One pack to work on: its disk entry, the row it already has (if any), and the registry match (zips only). */
interface Target {
  pack: DiskPack;
  row: ContentRow | undefined;
  match?: RegistryMatch;
}

/**
 * Adopts datapacks the panel did not install (found on disk, no
 * `server_content` row) and repairs rows that lack a name, version or icon.
 * Never moves or rewrites a pack file. See MODS_NOTES.md, "Datapacks".
 */
@Injectable()
export class DatapackAdoptionService {
  private readonly logger = new Logger(DatapackAdoptionService.name);

  constructor(
    private readonly dbService: DbService,
    private readonly query: ServerQueryService,
    private readonly datapacks: DatapacksService,
    private readonly identifier: JarIdentifierService,
    private readonly library: LibraryService,
    private readonly icons: DatapackIconService,
    private readonly events: EventsService,
  ) {}

  private get db() {
    return this.dbService.db;
  }

  /** Adopt every orphan and repair every incomplete overlay row of the active world. Idempotent. */
  async adoptAndRepair(
    serverId: string,
    { actor = 'system' }: { actor?: string } = {},
  ): Promise<DatapackAdoptionReport> {
    const server = await this.query.getServer(serverId);
    if (!server) throw new NotFoundException('Server not found');
    const packs = await this.datapacks.diskPacks(server);
    const rows = await this.db
      .select()
      .from(serverContent)
      .where(
        and(
          eq(serverContent.serverId, serverId),
          eq(serverContent.kind, 'datapack'),
        ),
      );
    const libs = await this.library.getLibraryFiles([
      ...new Set(rows.flatMap((r) => (r.libraryId ? [r.libraryId] : []))),
    ]);
    const byFile = new Map(
      rows.map((r) => [r.filename.replace(/\.disabled$/, ''), r]),
    );

    const report: DatapackAdoptionReport = {
      adopted: 0,
      repaired: 0,
      skipped: 0,
      failed: 0,
      details: [],
    };
    const note = (d: DatapackAdoptionDetail) => {
      report[d.outcome] += 1;
      report.details.push(d);
    };

    const targets: Target[] = [];
    const seen = new Set<string>();
    for (const pack of packs) {
      // A pack present in both dirs (hand-copied) is one pack: the enabled copy, listed first, represents it.
      if (seen.has(pack.file)) {
        note({
          file: pack.file,
          outcome: 'skipped',
          reason: 'A copy of this pack is also in the other list',
        });
        continue;
      }
      seen.add(pack.file);
      const row = byFile.get(pack.file);
      if (!row) targets.push({ pack, row });
      else if (row.managedBy !== 'overlay')
        continue; // pack-managed rows belong to the pack installer
      else if (this.needsRepair(row, pack, libs)) targets.push({ pack, row });
    }

    await this.identifyZips(targets, libs);
    for (const target of targets) {
      try {
        note(
          target.row
            ? await this.repair(target.row, target, libs, actor)
            : await this.adopt(server, target, actor),
        );
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `Datapack ${target.pack.file} on ${serverId}: ${reason}`,
        );
        note({ file: target.pack.file, outcome: 'failed', reason });
      }
    }

    if (report.adopted + report.repaired > 0)
      this.events.recordEvent({
        serverId,
        actor,
        type: 'datapacks-adopted',
        summary: `Datapacks: ${report.adopted} adopted, ${report.repaired} repaired`,
      });
    return report;
  }

  /**
   * Missing an icon (own, registry URL or library), or, for a zip with no
   * registry provenance yet, a version or a real name (the only fields a
   * registry match can fill). A directory pack can only ever gain an icon.
   */
  private needsRepair(
    row: ContentRow,
    pack: DiskPack,
    libs: LibraryRows,
  ): boolean {
    if (!this.hasIcon(row, libs)) return true;
    if (pack.isDirectory || this.hasProvenance(row, libs)) return false;
    return !row.version || this.hasDefaultName(row);
  }

  private hasProvenance(row: ContentRow, libs: LibraryRows): boolean {
    return !!row.libraryId && !!libs.get(row.libraryId)?.projectId;
  }

  /** A name still equal to the file-name fallback was never set by anyone. */
  private hasDefaultName(row: ContentRow): boolean {
    const file = row.filename.replace(/\.disabled$/, '');
    return !row.name.trim() || row.name === this.datapacks.prettify(file);
  }

  private hasIcon(row: ContentRow, libs: LibraryRows): boolean {
    if (row.iconRelPath || row.iconUrl) return true;
    const lib = row.libraryId ? libs.get(row.libraryId) : undefined;
    return !!(lib?.iconRelPath || lib?.iconUrl);
  }

  /** Registry lookup for the zip targets that have no library provenance yet, in bounded batches. Fails soft. */
  private async identifyZips(
    targets: Target[],
    libs: LibraryRows,
  ): Promise<void> {
    const zips: Target[] = [];
    for (const t of targets) {
      if (t.pack.isDirectory || t.pack.size > MAX_IDENTIFY_BYTES) continue;
      if (t.row && this.hasProvenance(t.row, libs)) continue;
      zips.push(t);
    }
    for (let i = 0; i < zips.length; i += IDENTIFY_BATCH) {
      const batch = zips.slice(i, i + IDENTIFY_BATCH);
      try {
        const jars = await Promise.all(
          batch.map(async (t) => ({
            filename: t.pack.file,
            data: await this.readPlainFile(t.pack.abs),
          })),
        );
        const results = await this.identifier.identifyMany(jars);
        batch.forEach((t, j) => {
          if (isRegistryMatch(results[j])) t.match = results[j];
        });
      } catch (err) {
        // identifyMany swallows registry errors itself; this is a disk read failing.
        this.logger.warn(`Datapack identification skipped: ${String(err)}`);
      }
    }
  }

  /** A zip pack must still be a regular file right before it is read or linked (not swapped for a symlink since the scan). */
  private async assertRegularZip(pack: DiskPack): Promise<void> {
    if (!pack.isDirectory && !(await fsp.lstat(pack.abs)).isFile())
      throw new Error('Not a regular file');
  }

  /** Read a regular file only; a symlink swapped in after the scan is refused. */
  private async readPlainFile(abs: string): Promise<Buffer> {
    if (!(await fsp.lstat(abs)).isFile()) throw new Error('Not a regular file');
    return fsp.readFile(abs);
  }

  /** Link the pack's file into the library (hard link, no second copy) so the row carries registry provenance. */
  private async linkLibrary(
    target: Target,
    match: RegistryMatch,
    actor: string,
  ) {
    const lib = await this.library.importFile(
      target.pack.abs,
      {
        category: 'datapack',
        filename: target.pack.file,
        name: match.name,
        version: match.version,
      },
      { hardlink: true, actor },
    );
    return this.library.fillMissingProvenance(lib.id, {
      platform: match.platform,
      projectId: match.projectId,
      fileId: match.versionId,
      name: match.name,
      version: match.version,
      mcVersions: match.mcVersions,
      loaders: match.loaders,
      iconUrl: match.iconUrl,
    });
  }

  private async adopt(
    server: Server,
    target: Target,
    actor: string,
  ): Promise<DatapackAdoptionDetail> {
    const { pack, match } = target;
    await this.assertRegularZip(pack);
    const id = `sc_${nanoid(8)}`;
    const fields: string[] = [];
    const lib = match
      ? await this.linkLibrary(target, match, actor).catch((err: unknown) => {
          this.logger.warn(
            `Datapack ${pack.file}: library link failed: ${String(err)}`,
          );
          return undefined;
        })
      : undefined;
    if (lib) fields.push('library');
    const iconUrl = match?.iconUrl ?? null;
    const iconRelPath = iconUrl ? null : await this.extractIcon(id, pack);
    if (iconUrl || iconRelPath) fields.push('icon');
    const inserted = await this.db
      .insert(serverContent)
      .values({
        id,
        serverId: server.id,
        libraryId: lib?.id ?? null,
        kind: 'datapack',
        managedBy: 'overlay',
        name: match?.name ?? this.datapacks.prettify(pack.file),
        filename: pack.file,
        version: match?.version ?? null,
        iconUrl,
        iconRelPath,
        enabled: pack.enabled,
      })
      .onConflictDoNothing({
        target: [serverContent.serverId, serverContent.filename],
      })
      .returning({ id: serverContent.id })
      .catch(async (err: unknown) => {
        // The row never landed: drop the icon written for it.
        await this.icons.remove(iconRelPath);
        throw err;
      });
    if (inserted.length === 0) {
      // A concurrent adopt won: drop the icon written for the row that never landed.
      await this.icons.remove(iconRelPath);
      return {
        file: pack.file,
        outcome: 'skipped',
        reason: 'Already adopted',
      };
    }
    return {
      file: pack.file,
      outcome: 'adopted',
      source: match?.platform ?? 'metadata',
      fields,
    };
  }

  /** Fill only what is missing; name/version/icon already set are never overwritten. */
  private async repair(
    row: ContentRow,
    target: Target,
    libs: LibraryRows,
    actor: string,
  ): Promise<DatapackAdoptionDetail> {
    const { pack, match } = target;
    await this.assertRegularZip(pack);
    const hasIcon = this.hasIcon(row, libs);
    const set: Partial<typeof serverContent.$inferInsert> = {};
    const fields: string[] = [];
    if (match) {
      if (this.hasDefaultName(row)) {
        set.name = match.name;
        fields.push('name');
      }
      if (!row.version && match.version) {
        set.version = match.version;
        fields.push('version');
      }
      if (!row.libraryId) {
        const lib = await this.linkLibrary(target, match, actor).catch(
          (err: unknown) => {
            this.logger.warn(
              `Datapack ${pack.file}: library link failed: ${String(err)}`,
            );
            return undefined;
          },
        );
        if (lib) {
          set.libraryId = lib.id;
          fields.push('library');
        }
      }
      if (!hasIcon && match.iconUrl) {
        set.iconUrl = match.iconUrl;
        fields.push('icon');
      }
    }
    if (!fields.includes('icon') && !hasIcon) {
      const rel = await this.extractIcon(row.id, pack);
      if (rel) {
        set.iconRelPath = rel;
        fields.push('icon');
      }
    }
    if (fields.length === 0)
      return {
        file: pack.file,
        outcome: 'skipped',
        reason: 'Nothing more could be found for this pack',
      };
    await this.db
      .update(serverContent)
      .set(set)
      .where(eq(serverContent.id, row.id));
    return {
      file: pack.file,
      outcome: 'repaired',
      source: match?.platform ?? 'metadata',
      fields,
    };
  }

  private async extractIcon(
    rowId: string,
    pack: DiskPack,
  ): Promise<string | null> {
    const png = await this.icons.read(pack.abs, pack.isDirectory);
    return png ? this.icons.store(rowId, png) : null;
  }
}
