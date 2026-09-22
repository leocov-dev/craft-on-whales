import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { parseBody } from '../utils/parse-body';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { currentUser } from '../auth/current-user';
import { ApiTokensService } from './api-tokens.service';

const createSchema = z.object({
  label: z.string().trim().min(1).max(80),
  serverIds: z.array(z.string()).nullable().default(null),
  expiresAt: z.string().nullable().default(null),
});

/**
 * Admin-only management API for public-API Bearer tokens, behind Settings
 * → Public API. The raw token value is only ever returned by `create()` —
 * see API_TOKENS_NOTES.md.
 */
@Controller('api/api-tokens')
@UseGuards(RolesGuard)
@Roles('admin')
export class ApiTokensController {
  constructor(private readonly apiTokens: ApiTokensService) {}

  @Get()
  async list() {
    return {
      ok: true,
      enabled: await this.apiTokens.isEnabled(),
      tokens: await this.apiTokens.list(),
    };
  }

  @Post('enabled')
  async setEnabled(@Req() req: Request, @Body() body: unknown) {
    const { enabled } = parseBody(z.object({ enabled: z.boolean() }), body);
    const value = await this.apiTokens.setEnabled(enabled, {
      actor: currentUser(req).username,
    });
    return { ok: true, enabled: value };
  }

  @Post()
  async create(@Req() req: Request, @Body() body: unknown) {
    const input = parseBody(createSchema, body);
    const { token, summary } = await this.apiTokens.create(input, {
      actor: currentUser(req).username,
    });
    return { ok: true, token, summary };
  }

  @Delete(':id')
  async revoke(@Req() req: Request, @Param('id') id: string) {
    await this.apiTokens.revoke(id, { actor: currentUser(req).username });
    return { ok: true };
  }
}
