import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { Public } from '../auth/public.decorator';
import { SkipOriginCheck } from '../auth/skip-origin-check.decorator';
import { BearerAuthGuard } from './bearer-auth.guard';
import { ApiTokensService } from './api-tokens.service';
import { ServerQueryService } from '../servers/server-query.service';
import type { Server } from '../servers/types';

interface PublicServerSummary {
  id: string;
  name: string;
  type: string;
  mcVersion: string;
  status: string;
  online: boolean;
}

function toSummary(s: Server): PublicServerSummary {
  return {
    id: s.id,
    name: s.display_name,
    type: s.type,
    mcVersion: s.mc_version,
    status: s.status,
    online: s.status === 'running',
  };
}

/**
 * The public read-only API (upstream parity item 3.17) — `GET /api/v1/*`.
 * `@Public()` skips `SessionAuthGuard`, `@SkipOriginCheck()` skips
 * `OriginGuard` (both are cookie-session-shaped checks that don't apply to
 * a Bearer-authenticated caller — see AUTH_NOTES.md), and `BearerAuthGuard`
 * is this controller's own route-scoped replacement for both: it resolves
 * the token, rate-limits, and scopes every response to what the token may
 * see. A server outside the token's scope, or a request that would reveal
 * whether one exists, answers 404 — matches the permissions module's
 * hidden-vs-404 contract for the same reason (no distinguishable signal
 * for a caller probing ids). See API_TOKENS_NOTES.md.
 */
@Controller('api/v1')
@Public()
@SkipOriginCheck()
@UseGuards(BearerAuthGuard)
export class PublicApiController {
  constructor(
    private readonly apiTokens: ApiTokensService,
    private readonly query: ServerQueryService,
  ) {}

  @Get('servers')
  async list(@Req() req: Request) {
    const token = req.apiToken;
    if (!token) throw new NotFoundException(); // unreachable — BearerAuthGuard always sets this
    const visible = await this.apiTokens.visibleServerIds(token);
    const all = await this.query.listServers();
    const servers = all.filter((s) => visible.has(s.id)).map(toSummary);
    const online = servers.filter((s) => s.online).length;
    return {
      ok: true,
      summary: {
        total: servers.length,
        online,
        offline: servers.length - online,
      },
      servers,
    };
  }

  @Get('servers/:id')
  async get(@Req() req: Request, @Param('id') id: string) {
    const token = req.apiToken;
    if (!token) throw new NotFoundException(); // unreachable — BearerAuthGuard always sets this
    if (!this.apiTokens.canSeeServer(token, id)) {
      throw new NotFoundException('Server not found');
    }
    const server = await this.query.getServer(id);
    if (!server) throw new NotFoundException('Server not found');
    return { ok: true, server: toSummary(server) };
  }
}
