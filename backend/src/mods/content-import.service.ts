import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import * as fsp from 'node:fs/promises';
import { nanoid } from 'nanoid';
import { and, desc, eq, sql, type SQL } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import {
  contentImportOverrides,
  contentImports,
  serverContent,
} from '../db/schema';
import { PathGuardService } from '../storage/path-guard.service';
import { StorageIndexService } from '../storage/storage-index.service';
import { EventsService } from '../events/events.service';
import {
  LibraryService,
  type LibraryFileRow,
} from '../library/library.service';
import { ServerQueryService } from '../servers/server-query.service';
import { extractZipSafely } from '../utils/safe-zip-extractor';
import { JarIdentifierService } from './jar-identifier.service';
import { ModsService } from './mods.service';
import { PackOverridesService } from './pack-overrides.service';
import {
  contentJarName,
  describeStagedPack,
  overrideJarName,
  type MrpackFile,
  type StagedPack,
} from './pack-archive';
import type { IdentifiedJar } from './mods.types';
import type { Server } from '../servers/types';
import type {
  ContentImportRemoval,
  ContentImportReport,
  ContentImportSkipped,
  ContentImportSummary,
} from '../../../shared/types/mods';

/** Upload cap. A jar zip bundles whole mods (a .mrpack is small: its jars are downloaded). */
export const IMPORT_MAX_BYTES = 1024 ** 3;
/** Same ceiling blueprint import uses for an extracted archive. */
const MAX_EXTRACT_BYTES = 8 * 1024 ** 3;
/** Parallel .mrpack downloads. */
const DOWNLOAD_CONCURRENCY = 4;
const MOD_LOADERS = new Set(['fabric', 'quilt', 'forge', 'neoforge']);

/** A jar headed for install: bundled in the archive, or listed in a .mrpack index. */
interface Candidate {
  path: string;
  filename: string;
  origin: 'bundled' | 'download';
  /** Bundled: the extracted copy in the staging dir. */
  abs?: string;
  /** Download: the index entry, then the library row once fetched. */
  file?: MrpackFile;
  lib?: LibraryFileRow;
}

export interface ImportOptions {
  actor?: string;
  /** Copy override trees into the server. Default true. */
  applyOverrides?: boolean;
  /** Progress label for the task that runs the import. */
  onStep?: (label: string) => void;
}

/** An archive extracted into `data/tmp/`, from `ContentImportService.stage()`. */
export interface StagedArchive {
  staging: string;
  pack: StagedPack;
  /** Bundled jars already identified, by archive path (see `identifyBundled`). */
  identified?: Map<string, IdentifiedJar>;
}

/** Run `fn` over `items`, at most `limit` at a time. */
async function forEachLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]!);
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
}

/**
 * Why a jar doesn't belong on this server, or null if it may. Only positive
 * evidence counts: an unidentified jar, or one with no loader data, installs.
 * Quilt loads Fabric mods, so a Fabric jar fits a Quilt server.
 */
export function jarMisfit(
  jar: Pick<IdentifiedJar, 'kind' | 'loaders'>,
  serverKind: 'mod' | 'plugin',
  serverLoader: string | null,
): Pick<ContentImportSkipped, 'reason' | 'detail'> | null {
  if (jar.kind && jar.kind !== serverKind)
    return {
      reason: 'wrong-kind',
      detail: `a ${jar.kind}; this server loads ${serverKind}s`,
    };
  if (serverKind !== 'mod' || !serverLoader) return null;
  const loaders = jar.loaders.filter((l) => MOD_LOADERS.has(l));
  const accepts =
    serverLoader === 'quilt' ? ['quilt', 'fabric'] : [serverLoader];
  if (loaders.length && !loaders.some((l) => accepts.includes(l)))
    return {
      reason: 'wrong-loader',
      detail: `built for ${loaders.join('/')}; this server runs ${serverLoader}`,
    };
  return null;
}

/**
 * The Mods-tab zip / .mrpack import (upstream parity 4.30): unpack, find the
 * jars, identify them in one batch, install them as overlay content tied to
 * a `content_imports` row, then apply the override trees reversibly. See
 * MODS_NOTES.md, "Zip / .mrpack import".
 */
@Injectable()
export class ContentImportService {
  private readonly logger = new Logger(ContentImportService.name);
  /** Servers with an import or import removal running. */
  private readonly busy = new Set<string>();

  constructor(
    private readonly dbService: DbService,
    private readonly pathGuard: PathGuardService,
    private readonly indexer: StorageIndexService,
    private readonly events: EventsService,
    private readonly library: LibraryService,
    private readonly query: ServerQueryService,
    private readonly identifier: JarIdentifierService,
    private readonly mods: ModsService,
    private readonly overrides: PackOverridesService,
  ) {}

  private get db() {
    return this.dbService.db;
  }

  /** The server, if it can take an import at all. Cheap: for the controller to call before queuing a task. */
  async assertImportable(serverId: string): Promise<Server> {
    const server = await this.assertServer(serverId);
    if (this.busy.has(serverId))
      throw new ConflictException(
        'Another import is already running on this server',
      );
    return server;
  }

  private async exclusive<T>(serverId: string, fn: () => Promise<T>) {
    if (this.busy.has(serverId))
      throw new ConflictException(
        'Another import is already running on this server',
      );
    this.busy.add(serverId);
    try {
      return await fn();
    } finally {
      this.busy.delete(serverId);
    }
  }

  /**
   * Import an uploaded archive into a server. `archivePath` must be a trusted
   * temp path (the multer upload); `originalName` is only used as the name of
   * a plain jar zip.
   */
  async importArchive(
    serverId: string,
    archivePath: string,
    originalName: string,
    opts: ImportOptions = {},
  ): Promise<ContentImportReport> {
    await this.assertImportable(serverId);
    return this.exclusive(serverId, async () => {
      const staged = await this.stage(archivePath, opts.onStep);
      try {
        return await this.install(serverId, staged, originalName, opts);
      } finally {
        await this.discard(staged);
      }
    });
  }

  /**
   * Extract an archive into a scratch dir under `data/tmp/` and work out what
   * it is. Throws 400 for anything that isn't an importable archive, having
   * removed the scratch dir. The caller owns the result and must `discard()` it.
   */
  async stage(
    archivePath: string,
    onStep: (label: string) => void = () => {},
  ): Promise<StagedArchive> {
    const staging = this.pathGuard.dataPath('tmp', `import-${nanoid(10)}`);
    try {
      onStep('Unpacking archive');
      await extractZipSafely(this.pathGuard, archivePath, staging, {
        maxTotalBytes: MAX_EXTRACT_BYTES,
      });
      return { staging, pack: await describeStagedPack(staging) };
    } catch (err) {
      await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
  }

  async discard(staged: StagedArchive): Promise<void> {
    await fsp
      .rm(staged.staging, { recursive: true, force: true })
      .catch(() => {});
  }

  /**
   * Identify the archive's bundled jars, and remember the results on
   * `staged` so a later install doesn't look them up again. For callers
   * that need to know what's inside before there's a server to install into.
   */
  async identifyBundled(staged: StagedArchive): Promise<IdentifiedJar[]> {
    const jars = staged.pack.jars;
    const identities = await this.identifier.identifyMany(
      await Promise.all(
        jars.map(async (j) => ({
          filename: j.filename,
          data: await fsp.readFile(j.abs),
        })),
      ),
    );
    staged.identified = new Map(jars.map((j, i) => [j.path, identities[i]!]));
    return identities;
  }

  /** Install an already-staged archive into a server. The caller still owns `staged`. */
  async importStaged(
    serverId: string,
    staged: StagedArchive,
    originalName: string,
    opts: ImportOptions = {},
  ): Promise<ContentImportReport> {
    await this.assertImportable(serverId);
    return this.exclusive(serverId, () =>
      this.install(serverId, staged, originalName, opts),
    );
  }

  private async install(
    serverId: string,
    staged: StagedArchive,
    originalName: string,
    {
      actor = 'system',
      applyOverrides = true,
      onStep = () => {},
    }: ImportOptions,
  ): Promise<ContentImportReport> {
    const server = await this.assertServer(serverId);
    return this.run(server, staged, originalName, {
      actor,
      applyOverrides,
      onStep,
    });
  }

  private async assertServer(serverId: string): Promise<Server> {
    const server = await this.query.getServer(serverId);
    if (!server) throw new NotFoundException('Server not found');
    this.mods.assertAcceptsManualContent(server);
    return server;
  }

  private async run(
    server: Server,
    { pack, staging, identified }: StagedArchive,
    originalName: string,
    { actor, applyOverrides, onStep }: Required<ImportOptions>,
  ): Promise<ContentImportReport> {
    const kind = this.mods.jarKindFor(server);
    const serverLoader = this.mods.loaderOf(server);
    const index = pack.index;
    const report: ContentImportReport = {
      import: null,
      pack: {
        format: pack.format,
        name:
          index?.name ??
          (originalName.replace(/\.(zip|mrpack)$/i, '').slice(0, 120) ||
            'Imported jars'),
        version: index?.version ?? null,
        mcVersion: index?.mcVersion ?? null,
        loader: index?.loader ?? null,
        loaderVersion: index?.loaderVersion ?? null,
      },
      installed: [],
      skipped: [],
      failed: [],
      overrides: { applied: false, written: [], skipped: [] },
      warnings: this.packWarnings(server, pack, serverLoader),
    };

    // 1. Pick the candidates: bundled jars first (an override copy of a jar
    //    wins, as in a launcher), then the index's files.
    const taken = await this.existingFilenames(server, kind);
    const claimed = new Set<string>();
    const candidates: Candidate[] = [];
    const claim = (c: Candidate) => {
      const skip = (reason: ContentImportSkipped['reason']) =>
        report.skipped.push({ name: c.filename, path: c.path, reason });
      if (claimed.has(c.filename)) return skip('duplicate');
      claimed.add(c.filename);
      if (taken.has(c.filename)) return skip('already-installed');
      candidates.push(c);
    };
    for (const j of pack.jars)
      claim({
        path: j.path,
        filename: j.filename,
        origin: 'bundled',
        abs: j.abs,
      });
    for (const f of index?.files ?? []) {
      const name = f.path.split('/').pop() || f.path;
      if (f.serverEnv === 'unsupported') {
        report.skipped.push({ name, path: f.path, reason: 'client-only' });
        continue;
      }
      const filename = contentJarName(f.path);
      if (!filename) {
        report.skipped.push({ name, path: f.path, reason: 'not-a-mod' });
        continue;
      }
      claim({ path: f.path, filename, origin: 'download', file: f });
    }

    // 2. Fetch the index's files into the library, hash-verified.
    const toFetch = candidates.filter((c) => c.origin === 'download');
    if (toFetch.length) {
      let done = 0;
      onStep(`Downloading ${toFetch.length} files`);
      await forEachLimit(toFetch, DOWNLOAD_CONCURRENCY, async (c) => {
        try {
          c.lib = await this.download(c.file!, c.filename, kind, actor);
        } catch (err) {
          report.failed.push({
            name: c.filename,
            path: c.path,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        onStep(`Downloading files (${++done}/${toFetch.length})`);
      });
    }
    const ready = candidates.filter((c) => c.origin === 'bundled' || c.lib);

    // 3. Identify every jar in one batch (skipping any identifyBundled() already did).
    const known = (c: Candidate) =>
      c.origin === 'bundled' ? identified?.get(c.path) : undefined;
    const unknown = ready.filter((c) => !known(c));
    onStep(`Identifying ${unknown.length} jars`);
    const looked = await this.identifier.identifyMany(
      await Promise.all(
        unknown.map(async (c) => ({
          filename: c.filename,
          data: await fsp.readFile(
            c.abs ?? this.pathGuard.dataPath(c.lib!.relPath),
          ),
        })),
      ),
    );
    const lookedUp = new Map(unknown.map((c, i) => [c, looked[i]!]));
    const identities = ready.map((c) => known(c) ?? lookedUp.get(c)!);

    // 4. Install what fits, tied to a new import row.
    const importId = `imp_${nanoid(10)}`;
    await this.db.insert(contentImports).values({
      id: importId,
      serverId: server.id,
      format: pack.format,
      name: report.pack.name,
      version: report.pack.version,
      actor,
    });
    for (const [i, c] of ready.entries()) {
      const jar = identities[i]!;
      const misfit = jarMisfit(jar, kind, serverLoader);
      if (misfit) {
        report.skipped.push({ name: jar.name, path: c.path, ...misfit });
        continue;
      }
      onStep(`Installing ${i + 1}/${ready.length}: ${jar.name}`);
      try {
        let lib =
          c.lib ??
          (await this.library.importFile(
            c.abs!,
            {
              category: kind,
              filename: c.filename,
              name: jar.name,
              version: jar.version,
            },
            { actor },
          ));
        if (jar.platform)
          lib = await this.library.fillMissingProvenance(lib.id, {
            platform: jar.platform,
            projectId: jar.projectId,
            fileId: jar.versionId,
            name: jar.name,
            version: jar.version,
            mcVersions: jar.mcVersions,
            loaders: jar.loaders,
            iconUrl: jar.iconUrl,
          });
        const row = await this.mods.addLibraryContent(server, lib, kind, {
          importId,
        });
        report.installed.push({
          contentId: row.id,
          filename: row.filename,
          path: c.path,
          name: lib.name,
          version: lib.version,
          kind,
          origin: c.origin,
          source: jar.source,
          platform: jar.platform,
          projectId: jar.projectId,
          iconUrl: jar.iconUrl,
        });
      } catch (err) {
        report.failed.push({
          name: jar.name,
          path: c.path,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 5. Overrides. Jars in an override tree's mods/ or plugins/ were handled above.
    if (pack.overrideRoots.length) {
      const roots = pack.overrideRoots;
      const plan = await this.overrides.plan(
        staging,
        roots,
        (p) => overrideJarName(p, roots) !== null,
      );
      report.overrides.skipped.push(...plan.skipped);
      if (!applyOverrides) {
        for (const p of plan.files.keys())
          report.overrides.skipped.push({ path: p, reason: 'disabled' });
      } else {
        onStep(`Applying ${plan.files.size} override files`);
        try {
          const res = await this.overrides.apply(server, importId, plan.files);
          report.overrides.applied = true;
          report.overrides.written = res.written;
          report.overrides.skipped.push(...res.skipped);
        } catch (err) {
          report.warnings.push(
            `Override files were not applied (nothing was left changed): ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }

    // 6. Keep the import row only if it owns something.
    if (report.installed.length || report.overrides.written.length) {
      report.import = await this.summary(importId);
    } else {
      await this.db
        .delete(contentImports)
        .where(eq(contentImports.id, importId));
    }
    this.events.recordEvent({
      serverId: server.id,
      actor,
      type: 'mod-installed',
      summary: `Imported ${report.pack.name}: ${report.installed.length} installed, ${report.skipped.length} skipped, ${report.failed.length} failed, ${report.overrides.written.length} override files`,
      details: {
        importId: report.import?.id ?? null,
        format: pack.format,
        installed: report.installed.length,
        skipped: report.skipped.length,
        failed: report.failed.length,
        overrides: report.overrides.written.length,
      },
    });
    this.indexer
      .scan()
      .catch((err: unknown) =>
        this.logger.warn(
          `background storage-index scan failed: ${String(err)}`,
        ),
      );
    return report;
  }

  private packWarnings(
    server: Server,
    pack: StagedPack,
    serverLoader: string | null,
  ): string[] {
    const index = pack.index;
    if (!index) return [];
    const warnings: string[] = [];
    const mc = server.mc_version;
    if (
      index.mcVersion &&
      mc &&
      !/^(LATEST|SNAPSHOT)$/.test(mc) &&
      index.mcVersion !== mc
    )
      warnings.push(
        `The pack targets Minecraft ${index.mcVersion}; this server runs ${mc}`,
      );
    if (index.loader && serverLoader && index.loader !== serverLoader)
      warnings.push(
        `The pack targets ${index.loader}; this server runs ${serverLoader}`,
      );
    if (index.invalidFiles)
      warnings.push(
        `${index.invalidFiles} entries in the pack index were unusable (no path, download or hash) and were ignored`,
      );
    return warnings;
  }

  /** Filenames already in the server's content dir, on disk or tracked. */
  private async existingFilenames(
    server: Server,
    kind: 'mod' | 'plugin',
  ): Promise<Set<string>> {
    const names = new Set<string>();
    const rows = await this.db
      .select({ filename: serverContent.filename })
      .from(serverContent)
      .where(eq(serverContent.serverId, server.id));
    for (const r of rows) names.add(r.filename.replace(/\.disabled$/, ''));
    const dir = this.pathGuard.dataPath(
      'servers',
      server.id,
      this.mods.contentDir(server, kind),
    );
    for (const f of await fsp.readdir(dir).catch(() => [] as string[]))
      names.add(f.replace(/\.disabled$/, ''));
    return names;
  }

  /** Download one index entry into the library, trying each listed URL in turn. */
  private async download(
    file: MrpackFile,
    filename: string,
    kind: 'mod' | 'plugin',
    actor: string,
  ): Promise<LibraryFileRow> {
    let lastErr: unknown;
    for (const url of file.downloads) {
      try {
        return await this.library.downloadToLibrary(
          url,
          {
            category: kind,
            filename,
            name: filename.replace(/\.jar$/i, ''),
            platform: 'url',
            expectedHash: file.expectedHash,
          },
          { actor },
        );
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  private async summary(importId: string): Promise<ContentImportSummary> {
    const [row] = await this.summaries(eq(contentImports.id, importId));
    if (!row) throw new NotFoundException('Import not found');
    return row;
  }

  /** A server's imports, newest first. */
  list(serverId: string): Promise<ContentImportSummary[]> {
    return this.summaries(eq(contentImports.serverId, serverId));
  }

  private async summaries(where: SQL): Promise<ContentImportSummary[]> {
    const rows = await this.db
      .select({
        id: contentImports.id,
        format: contentImports.format,
        name: contentImports.name,
        version: contentImports.version,
        actor: contentImports.actor,
        createdAt: contentImports.createdAt,
        contentCount: sql<number>`(select count(*) from ${serverContent} where ${serverContent.importId} = ${contentImports.id})`,
        overrideCount: sql<number>`(select count(*) from ${contentImportOverrides} where ${contentImportOverrides.importId} = ${contentImports.id})`,
      })
      .from(contentImports)
      .where(where)
      .orderBy(desc(contentImports.createdAt));
    return rows.map((r) => ({
      ...r,
      format: r.format as ContentImportSummary['format'],
      contentCount: Number(r.contentCount),
      overrideCount: Number(r.overrideCount),
    }));
  }

  /**
   * Remove an import: every server_content row still tied to it, then its
   * override writes reverted. Rows the user already removed are simply gone;
   * override files edited since the import are kept.
   */
  async remove(
    serverId: string,
    importId: string,
    { actor = 'system' }: { actor?: string } = {},
  ): Promise<ContentImportRemoval> {
    return this.exclusive(serverId, async () => {
      const [imp] = await this.db
        .select()
        .from(contentImports)
        .where(
          and(
            eq(contentImports.id, importId),
            eq(contentImports.serverId, serverId),
          ),
        )
        .limit(1);
      if (!imp) throw new NotFoundException('Import not found');

      const rows = await this.db
        .select({ filename: serverContent.filename })
        .from(serverContent)
        .where(
          and(
            eq(serverContent.serverId, serverId),
            eq(serverContent.importId, importId),
          ),
        );
      const removedContent: string[] = [];
      for (const r of rows) {
        await this.mods.removeContent(serverId, r.filename, { actor });
        removedContent.push(r.filename);
      }
      const overrides = await this.overrides.revert(serverId, importId);
      await this.db
        .delete(contentImports)
        .where(eq(contentImports.id, importId));
      this.events.recordEvent({
        serverId,
        actor,
        type: 'mod-removed',
        summary: `Removed import ${imp.name}: ${removedContent.length} jars, ${overrides.restored.length} files restored, ${overrides.deleted.length} deleted, ${overrides.kept.length} kept (changed since import)`,
        details: { importId, removedContent, overrides },
      });
      return { removedContent, overrides };
    });
  }
}
