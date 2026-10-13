import {
  Controller,
  HttpCode,
  Logger,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Public } from '../auth/public.decorator';
import { SkipOriginCheck } from '../auth/skip-origin-check.decorator';
import { ServerLifecycleService } from '../servers/server-lifecycle.service';
import { EventsService } from '../events/events.service';
import { RestartHookGuard } from './restart-hook.guard';

/**
 * Inbound restart webhook for other services. `@Public()` +
 * `@SkipOriginCheck()` skip the cookie-session guards (same pattern as the
 * public API, see API_TOKENS_NOTES.md); `RestartHookGuard` is the auth. The
 * restart runs in the background — a Minecraft stop can outlast a webhook
 * caller's timeout — and failures land in the server's history.
 */
@Controller('api/hooks/servers/:id/restart')
@Public()
@SkipOriginCheck()
@UseGuards(RestartHookGuard)
export class RestartHookController {
  private readonly logger = new Logger(RestartHookController.name);

  constructor(
    private readonly lifecycle: ServerLifecycleService,
    private readonly events: EventsService,
  ) {}

  @Post()
  @HttpCode(202)
  restart(@Param('id') id: string) {
    this.lifecycle
      .restartServer(id, { actor: 'restart-webhook' })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Webhook restart of ${id} failed: ${message}`);
        this.events.recordEvent({
          serverId: id,
          actor: 'restart-webhook',
          type: 'restart-hook-failed',
          summary: `Restart via webhook failed: ${message}`,
        });
      });
    return { ok: true, accepted: true };
  }
}
