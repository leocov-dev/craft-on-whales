import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { z, ZodError } from 'zod';
import { ServerQueryService } from '../servers/server-query.service';
import { ContainerService } from '../docker/container.service';
import { ItemRegistryService } from '../items/item-registry.service';
import { InventoryService } from './inventory.service';

const RUNNING_STATES = new Set(['running', 'unhealthy']);

const uuidSchema = z
  .string()
  .trim()
  .regex(
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/,
    'Invalid player UUID',
  );
const nameSchema = z
  .string()
  .trim()
  .regex(
    /^[.*A-Za-z0-9_]{1,16}$/,
    'Player names are 1-16 letters, digits or _ (a leading . or * for Bedrock players is fine)',
  );
const itemSchema = z
  .string()
  .trim()
  .regex(
    /^([a-z0-9_.-]+:)?[a-z0-9_./-]{1,120}$/,
    'Enter a valid item id (e.g. minecraft:diamond_sword)',
  );
const snapshotFileSchema = z.string().trim().min(1).max(300);
const querySchema = z
  .string()
  .trim()
  .min(1, 'Enter something to search for')
  .max(100);

const giveSchema = z.object({
  player: nameSchema,
  item: itemSchema,
  count: z.coerce.number().int().min(1).max(6400).optional(),
});
const clearSchema = z.object({
  player: nameSchema,
  item: itemSchema.optional(),
});

const containerSchema = z.enum([
  'hotbar',
  'inventory',
  'enderchest',
  'armor',
  'offhand',
]);
const slotRefSchema = z.object({
  container: containerSchema,
  slot: z.coerce.number().int().min(0).max(26),
});
const nestedSchema = z.object({
  path: z
    .array(
      z.union([
        z.string().regex(/^[A-Za-z0-9_:./ -]{1,80}$/, 'Invalid nested path'),
        z.number().int().min(0).max(255),
      ]),
    )
    .min(1)
    .max(10),
  index: z.number().int().min(0).max(255),
});
const slotEditSchema = z
  .object({
    container: containerSchema,
    slot: z.coerce.number().int().min(0).max(26),
    op: z.enum(['set', 'delete', 'count']),
    item: itemSchema.optional(),
    count: z.coerce.number().int().min(1).max(99).optional(),
    nested: nestedSchema.optional(),
  })
  .superRefine((v, ctx) => {
    if (v.op === 'set' && !v.item)
      ctx.addIssue({ code: 'custom', message: 'op "set" needs an item id' });
    if (v.op === 'count' && v.count === undefined)
      ctx.addIssue({ code: 'custom', message: 'op "count" needs a count' });
  });
const moveSchema = z.object({ from: slotRefSchema, to: slotRefSchema });
const addSchema = z.object({
  item: itemSchema,
  count: z.coerce.number().int().min(1).max(99).optional(),
});

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
function parseValue<T extends z.ZodType>(
  schema: T,
  value: unknown,
): z.infer<T> {
  try {
    return schema.parse(value);
  } catch (err) {
    if (err instanceof ZodError)
      throw new BadRequestException(
        err.issues[0]?.message || 'Invalid request',
      );
    throw err;
  }
}

function actorOf(req: Request): string {
  return req.user ? req.user.username : 'admin';
}

/** Ports legacy `src/web/routes/inventory.ts`, mounted at /api/servers/:id/inventory. */
@Controller('api/servers/:id/inventory')
export class InventoryController {
  constructor(
    private readonly serverQuery: ServerQueryService,
    private readonly containers: ContainerService,
    private readonly inventory: InventoryService,
    private readonly itemRegistry: ItemRegistryService,
  ) {}

  private async loadContext(id: string) {
    const server = await this.serverQuery.getServer(id);
    if (!server) throw new NotFoundException('Server not found');
    let running = false;
    try {
      const info = await this.containers.inspectStatus(server.id);
      running = info.exists && RUNNING_STATES.has(info.status);
    } catch {
      /* docker down — offline reads still work */
    }
    return { server, running };
  }

  @Get('players')
  async players(@Param('id') id: string) {
    const { server, running } = await this.loadContext(id);
    return {
      ok: true,
      running,
      players: await this.inventory.listPlayersWithData(server.id),
    };
  }

  @Get('player/:uuid')
  async player(
    @Param('id') id: string,
    @Param('uuid') uuidRaw: string,
    @Query('fresh') fresh?: string,
  ) {
    const uuid = parseValue(uuidSchema, uuidRaw);
    const { server, running } = await this.loadContext(id);
    if (running && fresh === '1')
      await this.inventory.flushPlayerData(server.id);
    const player = await this.inventory.readPlayerData(server.id, uuid);
    const ctx = await this.inventory.editContext(server.id, uuid);
    return {
      ok: true,
      running,
      player,
      iconBase: this.itemRegistry.iconBaseUrl(),
      edit: {
        online: ctx.online,
        mechanism: ctx.mechanism,
        nestedEditable: ctx.mechanism === 'file',
      },
    };
  }

  @Post('player/:uuid/slot')
  async slot(
    @Param('id') id: string,
    @Param('uuid') uuidRaw: string,
    @Req() req: Request,
  ) {
    const uuid = parseValue(uuidSchema, uuidRaw);
    const body = parseBody(slotEditSchema, req.body);
    const { server } = await this.loadContext(id);
    return {
      ok: true,
      result: await this.inventory.editSlot(server.id, uuid, body, {
        actor: actorOf(req),
      }),
    };
  }

  @Post('player/:uuid/move')
  async move(
    @Param('id') id: string,
    @Param('uuid') uuidRaw: string,
    @Req() req: Request,
  ) {
    const uuid = parseValue(uuidSchema, uuidRaw);
    const { from, to } = parseBody(moveSchema, req.body);
    const { server } = await this.loadContext(id);
    return {
      ok: true,
      result: await this.inventory.moveItem(server.id, uuid, from, to, {
        actor: actorOf(req),
      }),
    };
  }

  @Post('player/:uuid/add')
  async add(
    @Param('id') id: string,
    @Param('uuid') uuidRaw: string,
    @Req() req: Request,
  ) {
    const uuid = parseValue(uuidSchema, uuidRaw);
    const { item, count } = parseBody(addSchema, req.body);
    const { server } = await this.loadContext(id);
    return {
      ok: true,
      result: await this.inventory.addItem(server.id, uuid, item, count ?? 1, {
        actor: actorOf(req),
      }),
    };
  }

  @Get('player/:uuid/snapshots')
  async snapshots(@Param('id') id: string, @Param('uuid') uuidRaw: string) {
    const uuid = parseValue(uuidSchema, uuidRaw);
    const { server } = await this.loadContext(id);
    return {
      ok: true,
      snapshots: await this.inventory.listSnapshots(server.id, uuid),
    };
  }

  @Post('player/:uuid/snapshot')
  async takeSnapshot(@Param('id') id: string, @Param('uuid') uuidRaw: string) {
    const uuid = parseValue(uuidSchema, uuidRaw);
    const { server } = await this.loadContext(id);
    const snap = await this.inventory.snapshot(server.id, uuid, 'manual');
    await this.inventory.pruneSnapshots(server.id);
    return { ok: true, snapshot: snap };
  }

  @Get('snapshot')
  async getSnapshot(@Param('id') id: string, @Query('file') file: string) {
    const f = parseValue(snapshotFileSchema, file);
    await this.loadContext(id);
    return { ok: true, snapshot: this.inventory.getSnapshot(f) };
  }

  @Get('diff')
  async diff(
    @Param('id') id: string,
    @Query('a') a: string,
    @Query('b') b: string,
  ) {
    const av = parseValue(snapshotFileSchema, a);
    const bv = parseValue(snapshotFileSchema, b);
    await this.loadContext(id);
    return { ok: true, diff: this.inventory.diffSnapshots(av, bv) };
  }

  @Get('search')
  async search(@Param('id') id: string, @Query('q') q: string) {
    const query = parseValue(querySchema, q);
    const { server } = await this.loadContext(id);
    return {
      ok: true,
      results: await this.inventory.searchItems(server.id, query),
    };
  }

  @Post('give')
  async give(@Param('id') id: string, @Req() req: Request) {
    const { player, item, count } = parseBody(giveSchema, req.body);
    const { server } = await this.loadContext(id);
    return {
      ok: true,
      result: await this.inventory.giveItem(
        server.id,
        player,
        item,
        count ?? 1,
        { actor: actorOf(req) },
      ),
    };
  }

  @Post('clear')
  async clear(@Param('id') id: string, @Req() req: Request) {
    const { player, item } = parseBody(clearSchema, req.body);
    const { server } = await this.loadContext(id);
    return {
      ok: true,
      result: await this.inventory.clearItem(server.id, player, item || null, {
        actor: actorOf(req),
      }),
    };
  }
}

/** Global cross-server item search, mounted at /api/inventory (ports `router.globalSearch`). */
@Controller('api/inventory')
export class InventoryGlobalController {
  constructor(private readonly inventory: InventoryService) {}

  @Get('search')
  async search(@Query('q') q: string) {
    const query = parseValue(querySchema, q);
    return { ok: true, results: await this.inventory.searchAllServers(query) };
  }
}
