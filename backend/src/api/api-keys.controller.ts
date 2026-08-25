import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { parseBody } from '../utils/parse-body';
import { ApiKeysService } from '../api-keys/api-keys.service';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';

/** Ports the "API keys" section of legacy `src/web/routes/api.ts`. */
@Controller('api/keys')
export class ApiKeysController {
  constructor(private readonly apiKeys: ApiKeysService) {}

  @Get()
  async get() {
    return {
      ok: true,
      curseforge: { masked: await this.apiKeys.maskedKey('curseforge') },
    };
  }

  @Post('curseforge')
  @UseGuards(RolesGuard)
  @Roles('admin')
  async set(@Req() req: Request, @Body() body: unknown) {
    const { key } = parseBody(
      z.object({ key: z.string().trim().min(10).max(200) }),
      body,
    );
    const test = await this.apiKeys.testCurseForgeKey(key);
    if (!test.ok) return { ok: false, error: test.error };
    await this.apiKeys.setKey('curseforge', key, { actor: req.user!.username });
    return { ok: true };
  }

  @Post('curseforge/test')
  @UseGuards(RolesGuard)
  @Roles('admin')
  async test() {
    return this.apiKeys.testCurseForgeKey();
  }
}
