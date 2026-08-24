import {
  BadRequestException,
  Body,
  Controller,
  ConflictException,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { z, ZodError } from 'zod';
// sanitize-html ships no types anywhere in this tree — matching the
// established pattern for similarly-untyped packages (e.g. archiver in
// backend/src/worlds/world-archive.service.ts), stays untyped rather than
// fighting for a declaration file that doesn't exist.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const sanitizeHtml = require('sanitize-html');
import { marked } from 'marked';
import { PacksService } from '../packs/packs.service';
import { ServerLifecycleService } from '../servers/server-lifecycle.service';
import { ServerQueryService } from '../servers/server-query.service';
import { ModsService } from '../mods/mods.service';
import { ModrinthApiService } from '../mods/modrinth-api.service';
import { CurseforgeApiService } from '../mods/curseforge-api.service';
import { PackwizApiService } from '../mods/packwiz-api.service';
import { UpdateUpgradeService } from '../updates/update-upgrade.service';
import { TasksService } from '../tasks/tasks.service';
import { DbService } from '../db/db.service';
import { backups } from '../db/schema';
import { and, desc, eq } from 'drizzle-orm';
import type { PackSearchResult } from '../../../shared/types/packs';

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

function sanitizePackHtml(html: unknown): string {
  return sanitizeHtml(String(html || ''), {
    allowedTags: [
      'p',
      'b',
      'strong',
      'i',
      'em',
      'u',
      's',
      'del',
      'code',
      'pre',
      'a',
      'ul',
      'ol',
      'li',
      'br',
      'hr',
      'blockquote',
      'h1',
      'h2',
      'h3',
      'h4',
      'h5',
      'h6',
      'img',
      'span',
      'div',
      'table',
      'thead',
      'tbody',
      'tr',
      'th',
      'td',
      'details',
      'summary',
      'center',
      'figure',
      'figcaption',
    ],
    allowedAttributes: {
      a: ['href', 'rel', 'target'],
      img: ['src', 'alt', 'title', 'width', 'height'],
    },
    allowedSchemes: ['http', 'https'],
    transformTags: {
      a: sanitizeHtml.simpleTransform('a', {
        rel: 'noopener',
        target: '_blank',
      }),
    },
  });
}

const UPGRADE_STEP_LABELS: Record<string, string> = {
  resolving: 'Resolving target version',
  'backing-up': 'Creating pre-update backup',
  stopping: 'Stopping server',
  applying: 'Re-pinning pack version',
  recreating: 'Recreating container',
  monitoring: 'Starting & monitoring the new version',
  overlay: 'Re-applying custom overlay mods',
};

/** Ports the "Modpacks: resolve/preview, install, upgrade, rollback" + "Pack browser" sections of legacy `src/web/routes/api.ts`. */
@Controller('api')
export class PacksController {
  constructor(
    private readonly packs: PacksService,
    private readonly lifecycle: ServerLifecycleService,
    private readonly serverQuery: ServerQueryService,
    private readonly mods: ModsService,
    private readonly modrinth: ModrinthApiService,
    private readonly curseforge: CurseforgeApiService,
    private readonly packwiz: PackwizApiService,
    private readonly upgrade: UpdateUpgradeService,
    private readonly tasks: TasksService,
    private readonly dbService: DbService,
  ) {}

  private get db() {
    return this.dbService.db;
  }

  @Post('packs/resolve')
  async resolve(@Body() body: unknown) {
    const { platform, ref, versionId, mcVersion } = parseBody(
      z.object({
        platform: z.enum(['curseforge', 'modrinth', 'ftb', 'gtnh', 'packwiz']),
        ref: z.string().trim().min(1).max(400),
        versionId: z
          .string()
          .trim()
          .regex(/^[\w.-]{1,64}$/)
          .optional(),
        mcVersion: z.string().trim().max(32).optional(),
      }),
      body,
    );
    return {
      ok: true,
      pack: await this.packs.resolvePack(platform, ref, {
        versionId,
        mcVersion,
      }),
    };
  }

  @Post('servers/:id/pack')
  async applyToServer(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const { platform, ref, versionId, force } = parseBody(
      z.object({
        platform: z.enum(['curseforge', 'modrinth', 'ftb', 'gtnh', 'packwiz']),
        ref: z.string().trim().min(1).max(400),
        versionId: z
          .string()
          .trim()
          .regex(/^[\w.-]{1,64}$/)
          .optional(),
        force: z.coerce.boolean().optional(),
      }),
      body,
    );
    const resolved = await this.packs.resolvePack(platform, ref, { versionId });
    await this.packs.applyPack(id, resolved, {
      actor: req.user!.username,
      force,
    });
    return {
      ok: true,
      pack: resolved,
      note: 'Applied — recreate/restart to install',
    };
  }

  @Post('servers/:id/pack/upgrade')
  @HttpCode(202)
  async upgradePack(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const { versionId, skipBackup } = parseBody(
      z.object({
        versionId: z
          .string()
          .trim()
          .regex(/^[\w.-]{1,64}$/)
          .optional(),
        skipBackup: z.coerce.boolean().optional(),
      }),
      body,
    );
    const server = await this.serverQuery.mustGet(id);
    const actor = req.user!.username;
    const taskId = this.tasks.run(
      `Upgrading pack on ${server.display_name}`,
      { serverId: server.id, actor },
      async (t) => {
        t.step(UPGRADE_STEP_LABELS.resolving!);
        try {
          return await this.upgrade.upgradePack(server.id, {
            versionId,
            skipBackup,
            actor,
            onStep: (s: string) => t.step(UPGRADE_STEP_LABELS[s] || s),
          });
        } catch (err) {
          const e = err as Error & { rollbackAvailable?: boolean };
          if (e.rollbackAvailable)
            return { ok: false, error: e.message, rollbackAvailable: true };
          throw err;
        }
      },
    );
    return { ok: true, taskId };
  }

  @Post('servers/:id/pack/rollback')
  @HttpCode(202)
  async rollbackPack(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const { backupId: backupIdInput } = parseBody(
      z.object({ backupId: z.string().trim().max(40).optional() }),
      body,
    );
    const server = await this.serverQuery.mustGet(id);
    const actor = req.user!.username;
    const [preUpdateBackup] = await this.db
      .select({ id: backups.id })
      .from(backups)
      .where(
        and(eq(backups.serverId, server.id), eq(backups.reason, 'pre-update')),
      )
      .orderBy(desc(backups.createdAt))
      .limit(1);
    const backupId = backupIdInput || preUpdateBackup?.id || null;
    const taskId = this.tasks.run(
      `Rolling back pack on ${server.display_name}`,
      { serverId: server.id, actor },
      async (t) => {
        t.step(
          backupId
            ? 'Restoring pre-update backup & re-pinning'
            : 'Re-pinning previous version',
        );
        return this.upgrade.rollbackPack(server.id, {
          backupId: backupId || undefined,
          actor,
        });
      },
    );
    return { ok: true, taskId };
  }

  @Get('packs/search')
  async search(
    @Query('q') q = '',
    @Query('platform') platform: 'modrinth' | 'curseforge' = 'modrinth',
  ) {
    const { q: qq, platform: p } = parseBody(
      z.object({
        q: z.string().trim().min(1).max(120),
        platform: z.enum(['modrinth', 'curseforge']).default('modrinth'),
      }),
      { q, platform },
    );
    if (p === 'modrinth') {
      const hits = await this.modrinth.search({ query: qq, kind: 'modpack' });
      const results: PackSearchResult[] = hits.map((h) => ({
        platform: p,
        ref: h.slug,
        name: h.title,
        iconUrl: h.iconUrl,
        downloads: h.downloads,
        description: h.description,
      }));
      return { ok: true, results };
    }
    const hits = await this.curseforge.search({ query: qq, kind: 'modpack' });
    const results: PackSearchResult[] = hits.map((m) => ({
      platform: p,
      ref: m.slug,
      name: m.name,
      iconUrl: m.iconUrl,
      downloads: m.downloads,
      description: m.summary,
    }));
    return { ok: true, results };
  }

  @Get('packs/details')
  async details(
    @Query('platform') platformQ?: string,
    @Query('ref') refQ?: string,
    @Query('serverId') serverIdQ?: string,
  ) {
    const query = parseBody(
      z
        .object({
          platform: z.enum(['curseforge', 'modrinth', 'packwiz']).optional(),
          ref: z.string().trim().min(1).max(400).optional(),
          serverId: z.string().trim().max(40).optional(),
        })
        .refine((v) => Boolean(v.serverId) || (v.platform && v.ref), {
          message: 'Provide platform+ref or serverId',
        }),
      { platform: platformQ, ref: refQ, serverId: serverIdQ },
    );
    let platform = query.platform;
    let ref = query.ref;
    let installed: {
      serverId: string;
      serverName: string;
      versionId: string;
      versionName: string;
    } | null = null;
    if (query.serverId) {
      const server = await this.serverQuery.mustGet(query.serverId);
      const pin = await this.packs.getPack(server.id);
      if (!pin)
        throw new NotFoundException('This server has no managed modpack');
      if (pin.platform === 'ftb')
        throw new BadRequestException('FTB pack details are not supported yet');
      if (pin.platform === 'gtnh')
        throw new BadRequestException(
          'GTNH pack details live on the GTNH site',
        );
      platform = pin.platform as 'curseforge' | 'modrinth' | 'packwiz';
      ref = pin.projectRef;
      installed = {
        serverId: server.id,
        serverName: server.display_name,
        versionId: pin.pinnedVersionId,
        versionName: pin.pinnedVersionName,
      };
    }
    const resolved = await this.packs.resolvePack(platform!, ref!, {});
    let description = '';
    let downloads: number | null = null;
    let mods:
      | {
          name: string;
          filename: string;
          side: string;
          updatePlatform: string | null;
        }[]
      | null = null;
    if (platform === 'packwiz') {
      // No description/downloads concept — packwiz has neither. The useful
      // thing to show instead is the mod list itself, straight from the
      // pack's own index.toml (re-fetched here; resolvePack() already fetched
      // it once to compute the pin hash, same double-fetch shape the
      // Modrinth/CurseForge branches below have for their own project calls).
      const raw = await this.packwiz.resolvePack(ref!);
      mods = await this.packwiz.listMods(raw);
    } else if (platform === 'modrinth') {
      const project = await this.modrinth.getProject(resolved.projectRef);
      downloads = project.downloads ?? null;
      description = sanitizePackHtml(
        marked.parse(String(project.body || ''), { async: false }),
      );
    } else {
      const project = await this.curseforge.getMod(Number(resolved.projectId));
      downloads = project.downloads ?? null;
      description = sanitizePackHtml(
        await this.curseforge.getDescription(project.modId),
      );
    }
    return {
      ok: true,
      pack: {
        platform,
        ref: resolved.projectRef,
        projectId: resolved.projectId,
        name: resolved.projectName,
        iconUrl: resolved.iconUrl || null,
        author: null,
        downloads,
        description,
        mcVersion: resolved.mcVersion || null,
        loaders: resolved.loaders || null,
        defaultVersionId: resolved.versionId,
        versions: resolved.allVersions || [],
        mods,
        installed,
      },
    };
  }

  @Get('servers/:id/pack/mods')
  async packMods(@Param('id') id: string) {
    await this.serverQuery.mustGet(id);
    const pin = await this.packs.getPack(id);
    if (!pin) throw new NotFoundException('This server has no managed modpack');
    const all = await this.mods.listContent(id);
    const rows = all
      .filter((m) => m.source === 'pack')
      .map((m) => ({
        name: m.name,
        file: m.file,
        kind: m.kind,
        version: m.version,
        size: m.size,
        enabled: m.enabled,
      }));
    return {
      ok: true,
      pack: { name: pin.projectName, version: pin.pinnedVersionName },
      mods: rows,
    };
  }

  @Post('servers/from-pack')
  @HttpCode(202)
  fromPack(@Req() req: Request, @Body() body: unknown) {
    const input = parseBody(
      z
        .object({
          name: z.string().trim().min(1).max(80),
          description: z.string().max(4000).optional(),
          icon: z.string().max(64).optional(),
          accent: z
            .string()
            .regex(/^#[0-9a-fA-F]{6}$/)
            .optional(),
          platform: z.enum([
            'curseforge',
            'modrinth',
            'ftb',
            'gtnh',
            'packwiz',
          ]),
          ref: z.string().trim().min(1).max(400),
          versionId: z
            .string()
            .trim()
            .regex(/^[\w.-]{1,64}$/)
            .optional(),
          heapMb: z.coerce.number().int().min(512).max(262144).optional(),
          containerMemoryMb: z.coerce
            .number()
            .int()
            .min(1024)
            .max(524288)
            .optional(),
          diskQuotaGb: z.coerce.number().min(0).max(16384).optional(),
          portGame: z.coerce.number().int().min(1024).max(65535).optional(),
          env: z.record(z.string(), z.string()).optional(),
        })
        .refine(
          (v) =>
            !v.containerMemoryMb || !v.heapMb || v.containerMemoryMb > v.heapMb,
          {
            message:
              'Container memory limit must be higher than the Java heap (or the JVM will be OOM-killed)',
          },
        ),
      body,
    );
    const actor = req.user!.username;
    const taskId = this.tasks.run(
      `Creating ${input.name} from a ${input.platform} pack`,
      { actor },
      async (t) => {
        t.step('Resolving pack version (pinned — never "latest")');
        const resolved = await this.packs.resolvePack(
          input.platform,
          input.ref,
          { versionId: input.versionId },
        );
        const type = this.packs.packEnv(resolved).TYPE!;
        t.step('Creating server');
        const server = await this.lifecycle.createServer(
          {
            name: input.name,
            description: input.description,
            icon: input.icon,
            accent: input.accent,
            type,
            mcVersion: resolved.mcVersion || 'LATEST',
            env: input.env || {},
            heapMb: input.heapMb,
            containerMemoryMb: input.containerMemoryMb,
            diskQuotaGb: input.diskQuotaGb,
            portGame: input.portGame,
          } as never,
          {
            actor,
            start: false,
            onProgress: (s: string) => t.step(s),
            javaTagHint: resolved.javaTag,
          } as never,
        );
        t.step(`Pinning ${resolved.projectName} @ ${resolved.versionName}`);
        await this.packs.applyPack(server.id, resolved, { actor, force: true });
        t.step(
          'Starting server — the pack downloads and installs on first boot',
        );
        await this.lifecycle.startServer(server.id, { actor });
        return {
          serverId: server.id,
          name: server.display_name,
          pack: {
            name: resolved.projectName,
            version: resolved.versionName,
            mcVersion: resolved.mcVersion,
          },
        };
      },
    );
    return { ok: true, taskId };
  }
}
