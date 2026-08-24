import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import * as os from 'node:os';
import { z, ZodError } from 'zod';
import { DbService } from '../db/db.service';
import { servers } from '../db/schema';
import { ServerLifecycleService } from '../servers/server-lifecycle.service';
import { ServerQueryService } from '../servers/server-query.service';
import { ServerEnvironmentService } from '../servers/server-environment.service';
import { PortsService } from '../servers/ports.service';
import { DockerSpecService } from '../servers/docker-spec.service';
import { DockerLogsService } from '../docker/docker-logs.service';
import { DockerStatsService } from '../docker/docker-stats.service';
import { MojangService } from '../players/mojang.service';
import { SettingsService } from '../settings/settings.service';
import { ServerViewModelService } from './server-view-model.service';
import type { Server } from '../servers/types';
import { dockerOverridesSchema } from './docker-overrides.schema';

export function parseBody<T extends z.ZodType>(
  schema: T,
  body: unknown,
): z.infer<T> {
  try {
    return schema.parse(body);
  } catch (err) {
    if (err instanceof ZodError)
      throw new BadRequestException(
        err.issues[0]?.message || 'Invalid request',
      );
    throw err;
  }
}

interface OverridesInput {
  containerName?: string;
  networkName?: string;
  extraPorts?: unknown;
  extraBinds?: unknown;
}

/**
 * Hand-rolled admin gate for the docker-override fields embedded in
 * create/patch payloads. NOT replaced with a route-level `@Roles('admin')`
 * guard: create/patch are used by non-admins too whenever the payload
 * doesn't touch containerName/networkName/extraPorts/extraBinds — the
 * guard would have to be conditional on which fields are *present in this
 * particular request body*, which `@Roles()` can't express. See
 * `.plan/reviews/02-api-servers.md` finding #2.
 */
export function requireAdminForOverrides(
  req: Request,
  input: OverridesInput,
): void {
  const present =
    input.containerName !== undefined ||
    input.networkName !== undefined ||
    input.extraPorts !== undefined ||
    input.extraBinds !== undefined;
  if (present && req.user?.role !== 'admin') {
    throw new ForbiddenException(
      'Advanced Docker settings (container name, network, extra ports/binds) require the admin role.',
    );
  }
}

/** Strips secrets before a Server row goes out over the API — ports legacy publicServer(). */
export function publicServer(
  s: Server | null,
): Omit<Server, 'rcon_password_cipher' | 'notes'> | null {
  if (!s) return null;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { rcon_password_cipher, notes, ...rest } = s;
  return rest;
}

const createSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    description: z.string().max(4000).optional(),
    icon: z.string().max(64).optional(),
    accent: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .optional(),
    tags: z.array(z.string().trim().min(1).max(24)).max(16).optional(),
    type: z.string().trim().min(1).max(32),
    mcVersion: z.string().trim().max(32).optional(),
    javaTag: z.string().max(16).optional(),
    env: z.record(z.string(), z.string()).optional(),
    portGame: z.coerce.number().int().min(1024).max(65535).optional(),
    portRcon: z.coerce.number().int().min(1024).max(65535).optional(),
    portBedrock: z.coerce.number().int().min(1024).max(65535).optional(),
    withBedrock: z.coerce.boolean().optional(),
    heapMb: z.coerce.number().int().min(512).max(262144).optional(),
    containerMemoryMb: z.coerce.number().int().min(1024).max(524288).optional(),
    cpus: z.coerce.number().min(0).max(128).optional(),
    diskQuotaGb: z.coerce.number().min(0).max(16384).optional(),
    updatePolicy: z.enum(['manual', 'notify', 'auto']).optional(),
    autoStart: z.coerce.boolean().optional(),
    start: z.coerce.boolean().optional(),
    ...dockerOverridesSchema,
  })
  .refine(
    (v) => !v.containerMemoryMb || !v.heapMb || v.containerMemoryMb > v.heapMb,
    {
      message:
        'Container memory limit must be higher than the Java heap (or the JVM will be OOM-killed)',
    },
  );

const patchSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    description: z.string().max(4000).optional(),
    icon: z.string().max(64).optional(),
    accent: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .optional(),
    tags: z.array(z.string().trim().min(1).max(24)).max(16).optional(),
    notes: z.string().max(8000).optional(),
    mcVersion: z.string().trim().max(32).optional(),
    javaTag: z.string().max(16).optional(),
    heapMb: z.coerce.number().int().min(512).max(262144).optional(),
    containerMemoryMb: z.coerce.number().int().min(1024).max(524288).optional(),
    cpus: z.coerce.number().min(0).max(128).optional(),
    diskQuotaGb: z.coerce.number().min(0).max(16384).optional(),
    quotaStrict: z.coerce.boolean().optional(),
    updatePolicy: z.enum(['manual', 'notify', 'auto']).optional(),
    autoStart: z.coerce.boolean().optional(),
    autoRestart: z.coerce.boolean().optional(),
    env: z.record(z.string(), z.string()).optional(),
    routerHostname: z.string().trim().max(253).optional(),
    routerAutoScale: z.enum(['on', 'off']).nullable().optional(),
    ...dockerOverridesSchema,
  })
  .refine(
    (v) => !v.containerMemoryMb || !v.heapMb || v.containerMemoryMb > v.heapMb,
    {
      message: 'Container memory limit must be higher than the Java heap',
    },
  );

const LIVE_EMPTY = {
  stats: null as { cpuPct: number; memUsedBytes: number } | null,
  players: null as string[] | null,
  startedAt: null as string | null,
};

/**
 * Ports the server-CRUD + ports/versions-lookup slice of legacy
 * `src/web/routes/api.ts`. Docker network/preview/docker-spec admin routes
 * live in `DockerAdminController`; icon upload/serving lives in
 * `IconsController` — both split out of this file to keep it to the core
 * server lifecycle surface (see `.plan/reviews/02-api-servers.md` finding
 * #7). The always-warm live-stats cache (`GET /servers/live`'s per-poll
 * hydration) is deliberately deferred — see `API_NOTES.md`.
 */
@Controller('api')
export class ServersController {
  constructor(
    private readonly dbService: DbService,
    private readonly lifecycle: ServerLifecycleService,
    private readonly query: ServerQueryService,
    private readonly environment: ServerEnvironmentService,
    private readonly ports: PortsService,
    private readonly dockerSpec: DockerSpecService,
    private readonly dockerLogs: DockerLogsService,
    private readonly dockerStats: DockerStatsService,
    private readonly mojang: MojangService,
    private readonly settings: SettingsService,
    private readonly vm: ServerViewModelService,
  ) {}

  private get db() {
    return this.dbService.db;
  }

  @Get('servers')
  async list() {
    const rows = await this.query.listServers();
    const list = await Promise.all(rows.map((s) => this.vm.serverVM(s)));
    return { ok: true, servers: list };
  }

  @Get('servers/live')
  async live() {
    const out: Record<string, unknown> = {};
    for (const row of await this.db
      .select({ id: servers.id, status: servers.status })
      .from(servers)) {
      out[row.id] = { status: row.status, ...LIVE_EMPTY, phase: null };
    }
    return { ok: true, servers: out };
  }

  @Post('servers')
  async create(@Req() req: Request, @Body() body: unknown) {
    const input = parseBody(createSchema, body);
    requireAdminForOverrides(req, input);
    const server = await this.lifecycle.createServer(input, {
      actor: req.user!.username,
      start: input.start !== false,
    });
    return { ok: true, server: publicServer(server) };
  }

  @Post('servers/:id/start')
  async start(@Req() req: Request, @Param('id') id: string) {
    await this.lifecycle.startServer(id, { actor: req.user!.username });
    return { ok: true, server: publicServer(await this.query.getServer(id)) };
  }

  @Post('servers/:id/stop')
  async stop(@Req() req: Request, @Param('id') id: string) {
    await this.lifecycle.stopServer(id, { actor: req.user!.username });
    return { ok: true, server: publicServer(await this.query.getServer(id)) };
  }

  @Post('servers/:id/restart')
  async restart(@Req() req: Request, @Param('id') id: string) {
    await this.lifecycle.restartServer(id, { actor: req.user!.username });
    return { ok: true, server: publicServer(await this.query.getServer(id)) };
  }

  @Post('servers/:id/kill')
  async kill(@Req() req: Request, @Param('id') id: string) {
    await this.lifecycle.killServer(id, { actor: req.user!.username });
    return { ok: true, server: publicServer(await this.query.getServer(id)) };
  }

  @Post('servers/:id/recreate')
  async recreate(@Req() req: Request, @Param('id') id: string) {
    await this.lifecycle.recreateServer(id, { actor: req.user!.username });
    return { ok: true, server: publicServer(await this.query.getServer(id)) };
  }

  @Patch('servers/:id')
  async patch(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const changes = parseBody(patchSchema, body);
    requireAdminForOverrides(req, changes);
    if (
      changes.containerName !== undefined ||
      changes.networkName !== undefined ||
      changes.extraPorts !== undefined ||
      changes.extraBinds !== undefined
    ) {
      const before = await this.query.mustGet(id);
      await this.dockerSpec.validateOverrides(
        {
          containerName: changes.containerName || null,
          networkName: changes.networkName || null,
          extraPorts: changes.extraPorts ?? before.extraPorts,
          extraBinds: changes.extraBinds ?? before.extraBinds,
        },
        { previousExtraPorts: before.extraPorts },
      );
    }
    const { server, needsRecreate } = await this.lifecycle.updateServer(
      id,
      changes,
      { actor: req.user!.username },
    );
    return { ok: true, needsRecreate, server: publicServer(server) };
  }

  @Delete('servers/:id')
  async remove(
    @Req() req: Request,
    @Param('id') id: string,
    @Query('keepWorld') keepWorld?: string,
  ) {
    const { freedBytes } = await this.lifecycle.deleteServer(id, {
      actor: req.user!.username,
      keepWorld: keepWorld === 'true',
    });
    return { ok: true, freedBytes };
  }

  @Get('servers/:id/logs')
  async logs(@Param('id') id: string, @Query('tail') tail?: string) {
    const n = Math.max(1, Math.min(Number(tail) || 500, 5000));
    return this.dockerLogs.fetchLogs(id, { tail: n });
  }

  @Put('servers/:id/console-label')
  async consoleLabel(@Param('id') id: string, @Body() body: unknown) {
    await this.query.mustGet(id);
    const { label } = parseBody(
      z.object({ label: z.string().max(48).optional() }),
      body,
    );
    return {
      ok: true,
      label: await this.environment.setConsoleLabel(id, label),
    };
  }

  @Get('servers/:id/stats')
  async stats(@Param('id') id: string) {
    return { ok: true, stats: await this.dockerStats.statsOnce(id) };
  }

  @Get('servers/:id')
  async detail(@Param('id') id: string) {
    const row = await this.query.mustGet(id);
    const vm = await this.vm.serverVM(row);
    const addrs: string[] = [];
    const publicAddr = await this.settings.publicAddress(row.port_game);
    if (publicAddr) addrs.push(publicAddr);
    for (const nics of Object.values(os.networkInterfaces())) {
      for (const nic of nics || []) {
        if (nic.family === 'IPv4' && !nic.internal)
          addrs.push(`${nic.address}:${row.port_game}`);
      }
    }
    addrs.push(`localhost:${row.port_game}`);
    return {
      ok: true,
      server: {
        ...vm,
        containerName: row.containerName,
        networkName: row.networkName,
        extraPorts: row.extraPorts,
        extraBinds: row.extraBinds,
        addresses: [...new Set(addrs)],
      },
    };
  }

  @Get('ports/check')
  async portCheck(@Query('port') portQ?: string) {
    const port = Number(portQ);
    if (!Number.isInteger(port)) throw new BadRequestException('port required');
    return { ok: true, port, free: await this.ports.isPortFree(port) };
  }

  @Get('ports/suggest')
  async portSuggest(@Query('bedrock') bedrock?: string) {
    return {
      ok: true,
      ports: await this.ports.suggestPorts({ withBedrock: bedrock === 'true' }),
    };
  }

  @Get('versions')
  async versions(@Query('snapshots') snapshots?: string) {
    return {
      ok: true,
      versions: await this.mojang.listVersions({
        includeSnapshots: snapshots === 'true',
      }),
    };
  }
}
