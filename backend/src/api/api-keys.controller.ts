import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { z, ZodError } from 'zod';
import { ApiKeysService } from '../api-keys/api-keys.service';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';

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
