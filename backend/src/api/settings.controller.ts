import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
} from '@nestjs/common';
import { z, ZodError } from 'zod';
import { ConfigService } from '../config/config.service';
import { SettingsService } from '../settings/settings.service';
import { ApiKeysService } from '../api-keys/api-keys.service';
import { SchedulerService } from '../scheduler/scheduler.service';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { UseGuards } from '@nestjs/common';
import type {
  SettingsResponseData,
  Localization,
} from '../../../shared/types/settings';

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

/** Ports the "Panel settings" + "Localization" sections of legacy `src/web/routes/api.ts`. */
@Controller('api/settings')
export class SettingsController {
  constructor(
    private readonly config: ConfigService,
    private readonly settings: SettingsService,
    private readonly apiKeys: ApiKeysService,
    private readonly scheduler: SchedulerService,
  ) {}

  @Get()
  async get(): Promise<SettingsResponseData> {
    return {
      ok: true,
      publicHost: await this.settings.getPublicHost(),
      curseforge: { masked: await this.apiKeys.maskedKey('curseforge') },
      panel: { host: this.config.host, port: this.config.port },
      defaults: this.config.defaults,
    };
  }

  @Post()
  @UseGuards(RolesGuard)
  @Roles('admin')
  async set(@Body() body: unknown): Promise<{ ok: true; publicHost: string }> {
    const { publicHost } = parseBody(
      z.object({ publicHost: z.string().max(255).optional() }),
      body,
    );
    const saved = await this.settings.setPublicHost(publicHost || '');
    return { ok: true, publicHost: saved };
  }

  @Get('localization')
  async localization(): Promise<{ ok: true; localization: Localization }> {
    return { ok: true, localization: await this.settings.localization() };
  }

  @Post('localization')
  @UseGuards(RolesGuard)
  @Roles('admin')
  async setLocalization(
    @Body() body: unknown,
  ): Promise<{ ok: true; localization: Localization }> {
    const { timezone, country } = parseBody(
      z.object({
        timezone: z.string().max(64).optional(),
        country: z.string().max(8).optional(),
      }),
      body,
    );
    if (timezone !== undefined) {
      await this.settings.setTimezone(timezone);
      await this.scheduler.rearmAll();
    }
    if (country !== undefined) await this.settings.setCountry(country);
    return { ok: true, localization: await this.settings.localization() };
  }
}
