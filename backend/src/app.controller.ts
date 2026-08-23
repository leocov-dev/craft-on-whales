import { Controller, Get } from '@nestjs/common';
import { Public } from './auth/public.decorator';

/**
 * `GET /healthz` — the Docker healthcheck target (replaces legacy's
 * `wget .../login`, which no longer makes sense once `/` serves the SPA's
 * `index.html` instead of a server-rendered login page). Deliberately
 * dumb: reaching this handler at all means the HTTP server, DI graph, and
 * DB connection (opened synchronously in `DbService`'s constructor, before
 * any request can be routed) are all up.
 */
@Controller()
export class AppController {
  @Public()
  @Get('healthz')
  healthz(): { ok: true } {
    return { ok: true };
  }
}
