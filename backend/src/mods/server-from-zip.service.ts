import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import * as fsp from 'node:fs/promises';
import { z } from 'zod';
import { ServerLifecycleService } from '../servers/server-lifecycle.service';
import { TasksService } from '../tasks/tasks.service';
import { LoaderVersionsService } from './loader-versions.service';
import {
  ContentImportService,
  type StagedArchive,
} from './content-import.service';
import { MOD_LOADERS } from './mod-browser-orchestrator.service';
import type { IdentifiedJar } from './mods.types';
import type { StagedPack } from './pack-archive';
import type {
  ContentImportReport,
  ServerFromZipResult,
  ZipServerLoader,
  ZipServerTarget,
} from '../../../shared/types/mods';

export const ZIP_SERVER_LOADERS = [
  ...MOD_LOADERS,
  'paper',
] as const satisfies readonly ZipServerLoader[];

// Multipart fields arrive as strings; empty means "not set".
const blankToUndefined = (v: unknown) => (v === '' ? undefined : v);
const optionalInt = (min: number, max: number) =>
  z.preprocess(
    blankToUndefined,
    z.coerce.number().int().min(min).max(max).optional(),
  );

export const fromZipSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    // 'auto': take it from the archive (see inferZipTarget).
    loader: z.preprocess(
      blankToUndefined,
      z.enum([...ZIP_SERVER_LOADERS, 'auto']).default('auto'),
    ),
    mcVersion: z.preprocess(
      blankToUndefined,
      z.string().trim().min(1).max(32).optional(),
    ),
    applyOverrides: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),
    heapMb: optionalInt(512, 262144),
    containerMemoryMb: optionalInt(1024, 524288),
    diskQuotaGb: z.preprocess(
      blankToUndefined,
      z.coerce.number().min(0).max(16384).optional(),
    ),
    portGame: optionalInt(1024, 65535),
  })
  .refine(
    (v) => !v.containerMemoryMb || !v.heapMb || v.containerMemoryMb > v.heapMb,
    {
      message:
        'Container memory limit must be higher than the Java heap (or the JVM will be OOM-killed)',
    },
  );

export type FromZipInput = z.infer<typeof fromZipSchema>;

const RELEASE_RE = /^\d+(\.\d+)+$/;

function compareRelease(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** The most common value, ties broken by `tieBreak` (higher wins), or null. */
function vote(
  values: string[],
  tieBreak: (a: string, b: string) => number,
): string | null {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: string | null = null;
  for (const [v, n] of counts) {
    const bn = best === null ? -1 : counts.get(best)!;
    if (n > bn || (n === bn && tieBreak(v, best!) > 0)) best = v;
  }
  return best;
}

// Fabric first on a tie: Quilt runs Fabric mods, not the reverse.
const LOADER_PRIORITY: readonly string[] = [
  'quilt',
  'neoforge',
  'forge',
  'fabric',
];

/**
 * Work out the loader and Minecraft version a new server needs for an
 * archive, where the user left them on auto. A `.mrpack` names both in its
 * index. For a plain jar zip it's a majority vote over the identified jars:
 * plugins win → Paper; otherwise the most common mod loader, and the release
 * the most jars list as supported (registry matches only; ties go to the
 * newest). A plugin zip with no version data runs on LATEST, since plugins
 * are mostly version-tolerant; a mod zip with none is an error, not a guess.
 * Throws 400 when something needed can't be determined.
 */
export function inferZipTarget(
  pack: Pick<StagedPack, 'format' | 'index'>,
  jars: Pick<IdentifiedJar, 'kind' | 'loaders' | 'mcVersions'>[],
  chosen: { loader: ZipServerLoader | 'auto'; mcVersion?: string },
): ZipServerTarget {
  let loader: ZipServerLoader | null =
    chosen.loader === 'auto' ? null : chosen.loader;
  let mcVersion = chosen.mcVersion ?? null;
  const index = pack.index;

  if (index) {
    if (!loader && index.loader) loader = index.loader as ZipServerLoader;
    mcVersion ??= index.mcVersion;
  } else {
    if (!loader) {
      const kind = vote(
        jars.flatMap((j) => (j.kind ? [j.kind] : [])),
        (a) => (a === 'mod' ? 1 : -1),
      );
      if (kind === 'plugin') loader = 'paper';
      else
        loader = vote(
          jars.flatMap((j) =>
            j.loaders.filter((l) =>
              (MOD_LOADERS as readonly string[]).includes(l),
            ),
          ),
          (a, b) => LOADER_PRIORITY.indexOf(a) - LOADER_PRIORITY.indexOf(b),
        ) as ZipServerLoader | null;
    }
    mcVersion ??= vote(
      jars.flatMap((j) => j.mcVersions.filter((v) => RELEASE_RE.test(v))),
      compareRelease,
    );
    if (!mcVersion && loader === 'paper') mcVersion = 'LATEST';
  }

  if (!loader)
    throw new BadRequestException(
      index
        ? 'This pack doesn’t name a mod loader. Pick one.'
        : 'Couldn’t tell which loader these jars are for. Pick one.',
    );
  if (!mcVersion)
    throw new BadRequestException(
      index
        ? 'This pack doesn’t name a Minecraft version. Pick one.'
        : 'Couldn’t tell which Minecraft version these jars are for. Pick one.',
    );
  return {
    loader,
    mcVersion,
    // Only the pack's own loader build fits the pack's loader.
    loaderVersion:
      index?.loader && index.loader === loader ? index.loaderVersion : null,
  };
}

/**
 * The "create a server from an uploaded zip" flow (upstream parity 4.31),
 * the Modpacks page's "Upload zip" tab. One task: unpack and check the
 * archive, create the server (not started), install the archive through
 * `ContentImportService` exactly as the Mods-tab import does, then start.
 * See MODS_NOTES.md, "Create a server from a zip".
 */
@Injectable()
export class ServerFromZipService {
  private readonly logger = new Logger(ServerFromZipService.name);

  constructor(
    private readonly imports: ContentImportService,
    private readonly lifecycle: ServerLifecycleService,
    private readonly loaderVersions: LoaderVersionsService,
    private readonly tasks: TasksService,
  ) {}

  /**
   * Queue the task and return its id. `archivePath` is the multer temp file;
   * the task removes it when it ends.
   */
  createFromZip(
    input: FromZipInput,
    archivePath: string,
    originalName: string,
    actor: string,
  ): string {
    return this.tasks.run(
      `Creating ${input.name} from ${originalName}`,
      { actor },
      async (t): Promise<ServerFromZipResult> => {
        try {
          return await this.run(input, archivePath, originalName, actor, (s) =>
            t.step(s),
          );
        } finally {
          await fsp.rm(archivePath, { force: true }).catch(() => {});
        }
      },
    );
  }

  async run(
    input: FromZipInput,
    archivePath: string,
    originalName: string,
    actor: string,
    onStep: (label: string) => void,
  ): Promise<ServerFromZipResult> {
    // Everything that can reject the archive happens before the server exists.
    const staged = await this.imports.stage(archivePath, onStep);
    try {
      const target = await this.target(input, staged, onStep);
      onStep('Creating server');
      const env: Record<string, string> = {};
      const envKey = this.loaderVersions.envKeyFor(target.loader);
      if (target.loaderVersion && envKey) env[envKey] = target.loaderVersion;
      const server = await this.lifecycle.createServer(
        {
          name: input.name,
          type: target.loader.toUpperCase(),
          mcVersion: target.mcVersion,
          env,
          heapMb: input.heapMb,
          containerMemoryMb: input.containerMemoryMb,
          diskQuotaGb: input.diskQuotaGb,
          portGame: input.portGame,
        },
        { actor, start: false, onProgress: onStep },
      );

      // Content goes in before first boot so the loader starts with it. A
      // failure here that isn't per-jar (those are in the report) would leave
      // a half-filled server nobody asked for, so it's deleted again.
      let report: ContentImportReport;
      try {
        report = await this.imports.importStaged(
          server.id,
          staged,
          originalName,
          { actor, applyOverrides: input.applyOverrides, onStep },
        );
      } catch (err) {
        onStep('Import failed, removing the new server');
        await this.lifecycle
          .deleteServer(server.id, { actor })
          .catch((e: unknown) =>
            this.logger.error(
              `could not remove server ${server.id} after a failed import: ${String(e)}`,
            ),
          );
        throw err;
      }

      // A failed start keeps the server: it's complete, and the report says
      // what went in. The user can fix and start it from its page.
      let startError: string | null = null;
      onStep('Starting server');
      try {
        await this.lifecycle.startServer(server.id, { actor });
      } catch (err) {
        startError = err instanceof Error ? err.message : String(err);
      }
      return {
        serverId: server.id,
        name: server.display_name,
        target,
        report,
        startError,
      };
    } finally {
      await this.imports.discard(staged);
    }
  }

  private async target(
    input: FromZipInput,
    staged: StagedArchive,
    onStep: (label: string) => void,
  ): Promise<ZipServerTarget> {
    const needsJars =
      !staged.pack.index && (input.loader === 'auto' || !input.mcVersion);
    let jars: IdentifiedJar[] = [];
    if (needsJars) {
      onStep(`Identifying ${staged.pack.jars.length} jars`);
      jars = await this.imports.identifyBundled(staged);
    }
    return inferZipTarget(staged.pack, jars, {
      loader: input.loader,
      mcVersion: input.mcVersion,
    });
  }
}
