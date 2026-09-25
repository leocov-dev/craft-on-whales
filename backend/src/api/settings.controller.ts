import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { parseBody } from '../utils/parse-body';
import { ConfigService } from '../config/config.service';
import { SettingsService } from '../settings/settings.service';
import { PanelUpdateService } from '../settings/panel-update.service';
import { ApiKeysService } from '../api-keys/api-keys.service';
import { SchedulerService } from '../scheduler/scheduler.service';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { UseGuards } from '@nestjs/common';
import type {
  SettingsResponseData,
  ServerDefaultsResponseData,
  BackupRetentionResponseData,
  PanelUpdateResponseData,
  Localization,
} from '../../../shared/types/settings';

/** Ports the "Panel settings" + "Localization" sections of legacy `src/web/routes/api.ts`. */
@Controller('api/settings')
export class SettingsController {
  constructor(
    private readonly config: ConfigService,
    private readonly settings: SettingsService,
    private readonly panelUpdate: PanelUpdateService,
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
      defaults: await this.settings.getEffectiveDefaults(),
      defaultsBase: this.config.defaults,
      startingPort: await this.settings.getStartingPort(),
      startingPortOverriddenByEnv: this.config.hasStartingPortEnv,
    };
  }

  @Post()
  @UseGuards(RolesGuard)
  @Roles('admin')
  async set(
    @Body() body: unknown,
  ): Promise<{ ok: true; publicHost: string; startingPort?: number }> {
    const { publicHost, startingPort } = parseBody(
      z.object({
        publicHost: z.string().max(255).optional(),
        startingPort: z.number().int().min(1024).max(65535).optional(),
      }),
      body,
    );
    const saved = await this.settings.setPublicHost(publicHost || '');
    let savedPort: number | undefined;
    if (startingPort !== undefined && !this.config.hasStartingPortEnv) {
      savedPort = await this.settings.setStartingPort(startingPort);
    } else {
      savedPort = await this.settings.getStartingPort();
    }
    return { ok: true, publicHost: saved, startingPort: savedPort };
  }

  @Get('defaults')
  async getDefaults(): Promise<ServerDefaultsResponseData> {
    return {
      ok: true,
      defaults: await this.settings.getEffectiveDefaults(),
      base: this.config.defaults,
    };
  }

  @Post('defaults')
  @UseGuards(RolesGuard)
  @Roles('admin')
  async setDefaults(
    @Body() body: unknown,
  ): Promise<ServerDefaultsResponseData> {
    const parsed = parseBody(
      z.object({
        reset: z.boolean().optional(),
        heapMb: z.coerce.number().optional(),
        containerMemoryMb: z.coerce.number().optional(),
        cpus: z.coerce.number().optional(),
        diskQuotaGb: z.coerce.number().optional(),
        quotaWarnPct: z.coerce.number().optional(),
        quotaCriticalPct: z.coerce.number().optional(),
      }),
      body,
    );
    const defaults = parsed.reset
      ? await this.settings.resetServerDefaults()
      : await this.settings.setServerDefaults(parsed);
    return { ok: true, defaults, base: this.config.defaults };
  }

  @Get('backup-retention')
  async getBackupRetention(): Promise<BackupRetentionResponseData> {
    return {
      ok: true,
      ceilings: await this.settings.getBackupRetentionCeilings(),
    };
  }

  @Post('backup-retention')
  @UseGuards(RolesGuard)
  @Roles('admin')
  async setBackupRetention(
    @Body() body: unknown,
  ): Promise<BackupRetentionResponseData> {
    const parsed = parseBody(
      z.object({
        maxAgeDays: z.coerce.number().optional(),
        maxTotalGb: z.coerce.number().optional(),
      }),
      body,
    );
    const ceilings = await this.settings.setBackupRetentionCeilings(parsed);
    return { ok: true, ceilings };
  }

  // Panel self-update check (upstream-parity item 3.23): compares the
  // running panel version against the newest published GitHub Release of
  // this repo. Purely a read-only lookup — there is no apply/self-update
  // path anywhere in this codebase. Admin-only, matching upstream's own
  // gate on this control (see PanelUpdateService's doc comment /
  // SETTINGS_NOTES.md for the full design).
  @Get('panel-update')
  @UseGuards(RolesGuard)
  @Roles('admin')
  async panelUpdateStatus(
    @Query('refresh') refresh?: string,
  ): Promise<PanelUpdateResponseData> {
    const update = await this.panelUpdate.check({ force: refresh === '1' });
    return { ok: true, update };
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
