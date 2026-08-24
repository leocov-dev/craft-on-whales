import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Express, Request, Response } from 'express';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { z, ZodError } from 'zod';
import { DbService } from '../db/db.service';
import { servers } from '../db/schema';
import { eq } from 'drizzle-orm';
import { ServerLifecycleService } from '../servers/server-lifecycle.service';
import { ServerQueryService } from '../servers/server-query.service';
import { ServerEnvironmentService } from '../servers/server-environment.service';
import { ServerPreviewService } from '../servers/server-preview.service';
import { PortsService } from '../servers/ports.service';
import { DockerSpecService } from '../servers/docker-spec.service';
import { DockerLogsService } from '../docker/docker-logs.service';
import { DockerStatsService } from '../docker/docker-stats.service';
import { DockerNetworksService } from '../docker/docker-networks.service';
import { DockerConnectionService } from '../docker/docker-connection.service';
import { MojangService } from '../players/mojang.service';
import { SettingsService } from '../settings/settings.service';
import { ConfigService } from '../config/config.service';
import { EventsService } from '../events/events.service';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { UseGuards } from '@nestjs/common';
import { ServerViewModelService } from './server-view-model.service';
import type { Server } from '../servers/types';

const ICON_MAX_BYTES = 512 * 1024;
const ICON_EXTS: Record<string, string> = {
  'image/png': '.png',
  'image/svg+xml': '.svg',
  'image/jpeg': '.jpg',
};

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

interface OverridesInput {
  containerName?: string;
  networkName?: string;
  extraPorts?: unknown;
  extraBinds?: unknown;
}

function requireAdminForOverrides(req: Request, input: OverridesInput): void {
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

function parseBody<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
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

/** Strips secrets before a Server row goes out over the API — ports legacy publicServer(). */
function publicServer(
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

const previewSchema = z.object({
  type: z.string().trim().max(32).optional(),
  mcVersion: z.string().trim().max(32).optional(),
  javaTag: z.string().max(16).optional(),
  env: z.record(z.string(), z.string()).optional(),
  heapMb: z.coerce.number().int().min(512).max(262144).optional(),
  containerMemoryMb: z.coerce.number().int().min(1024).max(524288).optional(),
  containerSwapMb: z.coerce.number().int().min(0).optional(),
  cpus: z.coerce.number().min(0).max(128).optional(),
  portGame: z.coerce.number().int().min(1024).max(65535).optional(),
  portRcon: z.coerce.number().int().min(1024).max(65535).optional(),
  portBedrock: z.coerce.number().int().min(1024).max(65535).optional(),
  withBedrock: z.coerce.boolean().optional(),
  ...dockerOverridesSchema,
});

const LIVE_EMPTY = {
  stats: null as { cpuPct: number; memUsedBytes: number } | null,
  players: null as string[] | null,
  startedAt: null as string | null,
};

/**
 * Ports the `servers`/`docker`/`ports`/`versions` sections of legacy
 * `src/web/routes/api.ts`. The always-warm live-stats cache (`GET
 * /servers/live`'s per-poll hydration) is deliberately deferred — see
 * `API_NOTES.md`.
 */
@Controller('api')
export class ServersController {
  constructor(
    private readonly dbService: DbService,
    private readonly lifecycle: ServerLifecycleService,
    private readonly query: ServerQueryService,
    private readonly environment: ServerEnvironmentService,
    private readonly preview: ServerPreviewService,
    private readonly ports: PortsService,
    private readonly dockerSpec: DockerSpecService,
    private readonly dockerConnection: DockerConnectionService,
    private readonly dockerLogs: DockerLogsService,
    private readonly dockerStats: DockerStatsService,
    private readonly dockerNetworks: DockerNetworksService,
    private readonly mojang: MojangService,
    private readonly settings: SettingsService,
    private readonly vm: ServerViewModelService,
    private readonly config: ConfigService,
    private readonly events: EventsService,
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

  @Get('docker/status')
  async dockerStatus() {
    return { ok: true, docker: await this.dockerConnection.checkDocker() };
  }

  @Get('docker/networks')
  @UseGuards(RolesGuard)
  @Roles('admin')
  async networks() {
    return { ok: true, networks: await this.dockerNetworks.listNetworks() };
  }

  @Post('docker/preview')
  @UseGuards(RolesGuard)
  @Roles('admin')
  dockerPreview(@Body() body: unknown) {
    const input = parseBody(previewSchema, body);
    return {
      ok: true,
      yaml: this.dockerSpec.toYaml(
        this.preview.previewCreateSpec(input) as never,
      ),
    };
  }

  @Post('docker/preview/parse')
  @UseGuards(RolesGuard)
  @Roles('admin')
  dockerPreviewParse(@Body() body: unknown) {
    const { yaml: text } = parseBody(
      z.object({ yaml: z.string().max(20000) }),
      body,
    );
    return { ok: true, spec: this.dockerSpec.fromYaml(text) };
  }

  @Get('servers/:id/docker-spec')
  @UseGuards(RolesGuard)
  @Roles('admin')
  async serverDockerSpec(@Param('id') id: string) {
    await this.query.mustGet(id);
    return {
      ok: true,
      yaml: this.dockerSpec.toYaml(
        (await this.preview.previewServerSpec(id)) as never,
      ),
    };
  }

  // multipart field: 'icon'. Stores <dataDir>/library/icons/custom/<serverId><ext>
  // and sets servers.icon = 'custom:<filename>' (served via GET /api/icons/custom/:file).
  @Post('servers/:id/icon')
  @UseInterceptors(
    FileInterceptor('icon', { limits: { fileSize: ICON_MAX_BYTES, files: 1 } }),
  )
  async uploadIcon(
    @Req() req: Request,
    @Param('id') id: string,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    const server = await this.query.mustGet(id);
    try {
      if (!file)
        throw new BadRequestException('Attach an image (field "icon")');
      const ext = ICON_EXTS[file.mimetype];
      if (!ext)
        throw new BadRequestException(
          'Icons must be PNG, SVG or JPEG (max 512 KB)',
        );
      const filename = `${server.id}${ext}`;
      const destDir = path.join(
        this.config.dataDir,
        'library',
        'icons',
        'custom',
      );
      await fsp.mkdir(destDir, { recursive: true });
      // Drop stale variants with a different extension.
      for (const other of Object.values(ICON_EXTS)) {
        if (other !== ext)
          await fsp
            .rm(path.join(destDir, `${server.id}${other}`), { force: true })
            .catch(() => {});
      }
      await fsp
        .rm(path.join(destDir, filename), { force: true })
        .catch(() => {});
      await fsp
        .rename(file.path, path.join(destDir, filename))
        .catch(async () => {
          await fsp.copyFile(file.path, path.join(destDir, filename));
          await fsp.rm(file.path, { force: true });
        });
      await this.db
        .update(servers)
        .set({ icon: `custom:${filename}` })
        .where(eq(servers.id, server.id));
      this.events.recordEvent({
        serverId: server.id,
        actor: req.user!.username,
        type: 'config-changed',
        summary: 'Custom server icon uploaded',
      });
      return {
        ok: true,
        icon: `custom:${filename}`,
        url: `/api/icons/custom/${filename}`,
      };
    } catch (err) {
      if (file) await fsp.rm(file.path, { force: true }).catch(() => {});
      throw err;
    }
  }

  @Get('icons/custom/:file')
  getIcon(@Res() res: Response, @Param('file') fileParam: string) {
    const file = z
      .string()
      .regex(/^srv_[\w-]+\.(png|svg|jpg)$/, 'Invalid icon file')
      .parse(fileParam);
    const abs = path.join(
      this.config.dataDir,
      'library',
      'icons',
      'custom',
      file,
    );
    if (!fs.existsSync(abs)) throw new NotFoundException('Icon not found');
    // Custom icons may be user-uploaded SVGs (not sanitized). Serve them under a
    // locked-down, sandboxed CSP so a <script> embedded in the SVG can't execute
    // if the file is opened directly, and block content-type sniffing.
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.sendFile(abs);
  }
}
