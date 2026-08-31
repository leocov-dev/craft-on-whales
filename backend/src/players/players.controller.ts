import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { parseBody } from '../utils/parse-body';
import { ServerQueryService } from '../servers/server-query.service';
import { ContainerService } from '../docker/container.service';
import { PlayerRosterService } from './player-roster.service';
import { PlayerTeleportService } from './player-teleport.service';
import { StructureRegistryService } from './structure-registry.service';
import { BiomeRegistryService } from './biome-registry.service';
import { biomes } from './biomes';
import { playerNameSchema } from '../utils/player-name';
import { currentUser } from '../auth/current-user';

const RUNNING_STATES = new Set(['running', 'unhealthy']);

const nameSchema = playerNameSchema;
const reasonSchema = z.string().trim().max(256).optional();
const ipSchema = z
  .string()
  .trim()
  .regex(/^[0-9a-fA-F.:]{3,45}$/, 'Enter a valid IPv4 or IPv6 address');

const whitelistSchema = z.object({ name: nameSchema, on: z.coerce.boolean() });
const enforceSchema = z.object({ on: z.coerce.boolean() });
const opSchema = z.object({
  name: nameSchema,
  on: z.coerce.boolean(),
  level: z.coerce.number().int().min(1).max(4).optional(),
});
const banSchema = z.object({ name: nameSchema, reason: reasonSchema });
const pardonSchema = z.object({ name: nameSchema });
const banIpSchema = z.object({ ip: ipSchema, reason: reasonSchema });
const pardonIpSchema = z.object({ ip: ipSchema });
const kickSchema = z.object({
  name: nameSchema,
  message: z.string().trim().max(256).optional(),
});
const teleportSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('coords'),
    player: nameSchema,
    x: z.coerce.number().finite(),
    y: z.preprocess(
      (v: unknown) =>
        v === '' || v === null || v === undefined ? undefined : v,
      z.coerce.number().finite().optional(),
    ),
    z: z.coerce.number().finite(),
    dimension: z
      .enum([
        'minecraft:overworld',
        'minecraft:the_nether',
        'minecraft:the_end',
      ])
      .optional(),
    safe: z.coerce.boolean().optional(),
  }),
  z.object({
    mode: z.literal('player'),
    player: nameSchema,
    target: nameSchema,
  }),
  z.object({
    mode: z.literal('biome'),
    player: nameSchema,
    biome: z
      .string()
      .trim()
      .regex(/^[a-z0-9_.-]+:[a-z0-9_/.-]+$/),
  }),
  z.object({
    mode: z.literal('rtp'),
    player: nameSchema,
    minDistance: z.coerce.number().int().min(0).max(1000000).optional(),
    maxDistance: z.coerce.number().int().min(16).max(1000000).optional(),
    center: z.enum(['player', 'origin']).optional(),
  }),
  z.object({
    mode: z.literal('structure'),
    player: nameSchema,
    structure: z
      .string()
      .trim()
      .regex(/^#?[a-z0-9_.-]+:[a-z0-9_/.-]+$/),
    random: z.coerce.boolean().optional(),
    maxDistance: z.coerce.number().int().min(16).max(1000000).optional(),
  }),
]);

/** Ports legacy `src/web/routes/players.ts`, mounted at /api/servers/:id/players. */
@Controller('api/servers/:id/players')
export class PlayersController {
  constructor(
    private readonly serverQuery: ServerQueryService,
    private readonly containers: ContainerService,
    private readonly roster: PlayerRosterService,
    private readonly teleport: PlayerTeleportService,
    private readonly structureRegistry: StructureRegistryService,
    private readonly biomeRegistry: BiomeRegistryService,
  ) {}

  private async loadContext(id: string, req: Request) {
    const server = await this.serverQuery.getServer(id);
    if (!server) throw new NotFoundException('Server not found');
    let running = false;
    try {
      const info = await this.containers.inspectStatus(server.id);
      running = info.exists && RUNNING_STATES.has(info.status);
    } catch {
      /* docker down — fall back to file edits */
    }
    return { server, ctx: { running, actor: currentUser(req).username } };
  }

  @Get()
  async list(@Param('id') id: string, @Req() req: Request) {
    const { server, ctx } = await this.loadContext(id, req);
    const onlineNames = ctx.running
      ? await this.roster.listOnlineNames(server.id)
      : [];
    return {
      ok: true,
      running: ctx.running,
      players: this.roster.listPlayers(server.id, onlineNames),
      bannedIps: this.roster.listBannedIps(server.id),
      whitelistEnforced: this.roster.getWhitelistEnforced(server.id),
    };
  }

  @Get('structures')
  async structures(@Param('id') id: string, @Req() req: Request) {
    try {
      const { ctx } = await this.loadContext(id, req);
      return {
        ok: true,
        structures: await this.structureRegistry.getServerStructures(id, {
          running: ctx.running,
        }),
      };
    } catch {
      return { ok: true, structures: [] };
    }
  }

  @Get('biomes')
  async biomesList(@Param('id') id: string, @Req() req: Request) {
    try {
      const { ctx } = await this.loadContext(id, req);
      const registry = await this.biomeRegistry.getServerBiomes(id, {
        running: ctx.running,
      });
      const seen = new Map<string, { id: string; dimension: string }>();
      for (const b of registry.biomes) {
        if (seen.has(b.id)) continue;
        const dims = registry.byId.get(b.id) || [b.dimension];
        const primary =
          dims.find((d) => d && d !== 'minecraft:overworld') ||
          dims[0] ||
          'minecraft:overworld';
        seen.set(b.id, { id: b.id, dimension: primary });
      }
      const list = [...seen.values()];
      return {
        ok: true,
        biomes: list,
        source: list.length > 70 ? 'server' : 'bundled',
      };
    } catch {
      return {
        ok: true,
        biomes: biomes.map((id) => ({ id, dimension: 'minecraft:overworld' })),
        source: 'bundled',
      };
    }
  }

  @Post('whitelist')
  async whitelist(@Param('id') id: string, @Req() req: Request) {
    const { name, on } = parseBody(whitelistSchema, req.body);
    const { server, ctx } = await this.loadContext(id, req);
    return {
      ok: true,
      result: await this.roster.setWhitelisted(server.id, name, on, ctx),
    };
  }

  @Post('whitelist-enforce')
  async whitelistEnforce(@Param('id') id: string, @Req() req: Request) {
    const { on } = parseBody(enforceSchema, req.body);
    const { server, ctx } = await this.loadContext(id, req);
    return {
      ok: true,
      result: await this.roster.setWhitelistEnforced(server.id, on, ctx),
    };
  }

  @Post('op')
  async op(@Param('id') id: string, @Req() req: Request) {
    const { name, on, level } = parseBody(opSchema, req.body);
    const { server, ctx } = await this.loadContext(id, req);
    return {
      ok: true,
      result: await this.roster.setOp(server.id, name, on, level ?? 4, ctx),
    };
  }

  @Post('ban')
  async ban(@Param('id') id: string, @Req() req: Request) {
    const { name, reason } = parseBody(banSchema, req.body);
    const { server, ctx } = await this.loadContext(id, req);
    return {
      ok: true,
      result: await this.roster.banPlayer(server.id, name, reason, ctx),
    };
  }

  @Post('pardon')
  async pardon(@Param('id') id: string, @Req() req: Request) {
    const { name } = parseBody(pardonSchema, req.body);
    const { server, ctx } = await this.loadContext(id, req);
    return {
      ok: true,
      result: await this.roster.pardonPlayer(server.id, name, ctx),
    };
  }

  @Post('ban-ip')
  async banIp(@Param('id') id: string, @Req() req: Request) {
    const { ip, reason } = parseBody(banIpSchema, req.body);
    const { server, ctx } = await this.loadContext(id, req);
    return {
      ok: true,
      result: await this.roster.banIp(server.id, ip, reason, ctx),
    };
  }

  @Post('pardon-ip')
  async pardonIp(@Param('id') id: string, @Req() req: Request) {
    const { ip } = parseBody(pardonIpSchema, req.body);
    const { server, ctx } = await this.loadContext(id, req);
    return { ok: true, result: await this.roster.pardonIp(server.id, ip, ctx) };
  }

  @Post('kick')
  async kick(@Param('id') id: string, @Req() req: Request) {
    const { name, message } = parseBody(kickSchema, req.body);
    const { server, ctx } = await this.loadContext(id, req);
    return {
      ok: true,
      result: await this.roster.kickPlayer(server.id, name, message, ctx),
    };
  }

  @Post('teleport')
  async teleport_(@Param('id') id: string, @Req() req: Request) {
    const body = parseBody(teleportSchema, req.body);
    const { server, ctx } = await this.loadContext(id, req);
    const result = await this.teleport.withTeleportSlot(server.id, async () => {
      if (body.mode === 'coords') {
        return this.teleport.tpToCoords(
          server.id,
          body.player,
          {
            x: body.x,
            y: body.y,
            z: body.z,
            dimension: body.dimension,
            safe: body.safe !== false,
          },
          ctx,
        );
      }
      if (body.mode === 'player') {
        return this.teleport.tpToPlayer(
          server.id,
          body.player,
          body.target,
          ctx,
        );
      }
      if (body.mode === 'rtp') {
        return this.teleport.rtpPlayer(
          server.id,
          body.player,
          {
            minDistance: body.minDistance,
            maxDistance: body.maxDistance,
            center: body.center,
          },
          ctx,
        );
      }
      if (body.mode === 'structure') {
        return this.teleport.tpToStructure(
          server.id,
          body.player,
          body.structure,
          { random: body.random !== false, maxDistance: body.maxDistance },
          ctx,
        );
      }
      return this.teleport.tpToBiome(server.id, body.player, body.biome, ctx);
    });
    return { ok: true, result };
  }
}
