import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { ModsService } from './mods.service';
import { LoaderVersionsService } from './loader-versions.service';
import {
  ServerLifecycleService,
  type CreateServerInput,
} from '../servers/server-lifecycle.service';
import { TasksService } from '../tasks/tasks.service';

export const MOD_LOADERS = ['fabric', 'forge', 'neoforge', 'quilt'] as const;

// Shared "Advanced Docker Settings" fields — ports `dockerOverridesSchema.ts`
// (duplicated inline per the established convention in
// `blueprints.controller.ts`: small, single-use, not worth a shared file).
const dockerOverridesSchema = {
  containerName: z
    .union([
      z.literal(''),
      z
        .string()
        .trim()
        .max(63)
        .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/),
    ])
    .optional(),
  networkName: z.string().trim().max(128).optional(),
  extraPorts: z
    .array(
      z.object({
        hostPort: z.coerce.number().int().min(1024).max(65535),
        containerPort: z.coerce.number().int().min(1).max(65535),
        protocol: z.enum(['tcp', 'udp']),
        label: z.string().trim().max(40).optional(),
      }),
    )
    .max(20)
    .optional(),
  extraBinds: z
    .array(
      z.object({
        hostPath: z.string().trim().min(1).max(500),
        containerPath: z.string().trim().min(1).max(300),
        mode: z.enum(['rw', 'ro']).optional(),
      }),
    )
    .max(20)
    .optional(),
};

export const fromModsSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    description: z.string().max(4000).optional(),
    icon: z.string().max(64).optional(),
    accent: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .optional(),
    // 'paper' is accepted for the Auto-detect (solver) path, which can pick
    // a plugin loader; the browse UI only offers the four mod loaders.
    loader: z.enum([...MOD_LOADERS, 'paper']),
    mcVersion: z.string().trim().min(1).max(32),
    loaderVersion: z.string().trim().max(40).optional(),
    mods: z
      .array(
        z.object({
          platform: z.enum(['modrinth', 'curseforge']),
          ref: z.string().trim().min(1).max(200),
          versionId: z.string().trim().min(1).max(60).optional(),
        }),
      )
      .max(100)
      .default([]),
    heapMb: z.coerce.number().int().min(512).max(262144).optional(),
    containerMemoryMb: z.coerce.number().int().min(1024).max(524288).optional(),
    diskQuotaGb: z.coerce.number().min(0).max(16384).optional(),
    portGame: z.coerce.number().int().min(1024).max(65535).optional(),
    env: z.record(z.string(), z.string()).optional(),
    ...dockerOverridesSchema,
  })
  .refine(
    (v) => !v.containerMemoryMb || !v.heapMb || v.containerMemoryMb > v.heapMb,
    {
      message:
        'Container memory limit must be higher than the Java heap (or the JVM will be OOM-killed)',
    },
  );

export type FromModsInput = z.infer<typeof fromModsSchema>;

/**
 * Orchestrates the "From mods" server-creation wizard: builds the
 * create-server payload, creates the server, installs the requested mods
 * (up to 100, sequentially, best-effort) BEFORE first boot, then starts it.
 * Split out of `ModBrowserController.fromMods()` per
 * `.plan/reviews/04-mods.md` ("large inline async task closure... embedded
 * directly in a controller method rather than a dedicated application/
 * orchestration service"). Runs as a tracked background task via
 * `TasksService`; the caller gets the task id back immediately.
 */
@Injectable()
export class ModBrowserOrchestratorService {
  constructor(
    private readonly loaderVersions: LoaderVersionsService,
    private readonly lifecycle: ServerLifecycleService,
    private readonly mods: ModsService,
    private readonly tasks: TasksService,
  ) {}

  /** Kicks off the create-server-from-mods task and returns its task id. */
  createFromMods(input: FromModsInput, actor: string): string {
    const type = input.loader.toUpperCase();

    return this.tasks.run(
      `Creating ${input.name} (${input.loader})`,
      { actor },
      async (t) => {
        const env = { ...(input.env || {}) };
        const envKey = this.loaderVersions.envKeyFor(input.loader);
        if (input.loaderVersion && envKey) env[envKey] = input.loaderVersion;
        t.step('Creating server');
        const createInput: CreateServerInput = {
          name: input.name,
          description: input.description,
          icon: input.icon,
          accent: input.accent,
          type,
          mcVersion: input.mcVersion,
          env,
          heapMb: input.heapMb,
          containerMemoryMb: input.containerMemoryMb,
          diskQuotaGb: input.diskQuotaGb,
          portGame: input.portGame,
          containerName: input.containerName,
          networkName: input.networkName,
          extraPorts: input.extraPorts,
          extraBinds: input.extraBinds,
        };
        const server = await this.lifecycle.createServer(createInput, {
          actor,
          start: false,
          onProgress: (s: string) => t.step(s),
        });

        // Install mods BEFORE first boot so a loader server starts with them present.
        const failed: string[] = [];
        for (let i = 0; i < input.mods.length; i += 1) {
          const m = input.mods[i]!;
          const url = this.mods.refToUrl(m.platform, m.ref, m.versionId);
          t.step(`Installing mod ${i + 1}/${input.mods.length}: ${m.ref}`);
          try {
            await this.mods.installFromUrl(server.id, url, { actor });
          } catch (err) {
            failed.push(`${m.ref} (${(err as Error).message})`);
          }
        }
        t.step('Starting server');
        await this.lifecycle.startServer(server.id, { actor });
        return {
          serverId: server.id,
          name: server.display_name,
          installed: input.mods.length - failed.length,
          total: input.mods.length,
          failed,
        };
      },
    );
  }
}
