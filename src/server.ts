'use strict';

// Preflight FIRST — fail clearly on an unsupported Node runtime before anything
// else (config, DB, the runtime error net) can turn it into a cryptic crash.
require('./preflight');

import type { Server as HttpServer } from 'node:http';

function installRuntimeGuards(): void {
  // Last-resort safety net: a control panel must stay up. The specific fixes (e.g.
  // WebSocket 'error' handlers) prevent the known crash paths; this backstop keeps
  // a stray uncaught error or rejected promise from taking the whole panel down.
  // Installed only AFTER a successful boot, so startup errors stay fatal and
  // visible instead of being silently swallowed.
  process.on('uncaughtException', (err) => {
    console.error('[fatal] uncaughtException (kept alive):', err);
  });
  process.on('unhandledRejection', (reason) => {
    console.error('[fatal] unhandledRejection (kept alive):', reason);
  });
}

try {
  const config = require('./config') as typeof import('./config');
  const { ensureDataRoot } = require('./storage/dataRoot') as typeof import('./storage/dataRoot');
  const { migrate } = require('./db/migrate') as typeof import('./db/migrate');

  // Boot order matters: data root first (the DB lives inside it), then schema.
  ensureDataRoot();
  migrate();
  (require('./services/apiKeys') as typeof import('./services/apiKeys')).importFromEnvOnce();
  (require('./blueprints') as typeof import('./blueprints'))
    .seedStarters()
    .catch((err: unknown) => console.error('[boot] starter blueprints seed failed:', err));

  const { createApp } = require('./web/app') as typeof import('./web/app');
  const app = createApp();

  const httpServer: HttpServer = app.listen(config.port, config.host, () => {
    const shownHost = config.host === '0.0.0.0' || config.host === '::' ? 'localhost' : config.host;
    console.log(`Minecraft Server Manager listening on http://${shownHost}:${config.port}`);
    console.log(`Data root: ${config.dataDir}`);
    if (config.isExposedBind) {
      console.warn(
        `[security] PANEL_HOST=${config.host} exposes the panel beyond this machine. ` +
          `Until the admin account exists, anyone who can reach it can claim it — finish ` +
          `first-run setup now, and only put it on the internet behind a reverse proxy with TLS.`
      );
    }
    installRuntimeGuards();
    startBackgroundServices(httpServer);
  });

  httpServer.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(
        `\n[boot] Port ${config.port} is already in use. Stop whatever is using it, or set PANEL_PORT in your .env to a free port.\n`
      );
    } else if (err.code === 'EACCES') {
      console.error(
        `\n[boot] Not allowed to bind ${config.host}:${config.port}. Ports below 1024 need elevated privileges — pick a higher PANEL_PORT.\n`
      );
    } else {
      console.error('\n[boot] HTTP server error:', err.message, '\n');
    }
    process.exit(1);
  });
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error('\n[boot] Startup failed:\n  ' + message + '\n');
  process.exit(1);
}

// Everything that runs once the panel is listening. Split out so a throw here is
// clearly a post-boot background failure, not a startup failure.
function startBackgroundServices(httpServer: HttpServer): void {
  (require('./ws') as typeof import('./ws')).attachWebSockets(httpServer);
  (require('./storage/indexer') as typeof import('./storage/indexer')).startIndexer();
  (require('./crashes') as typeof import('./crashes')).startCrashWatcher({});
  (require('./services/scheduler') as typeof import('./services/scheduler')).startScheduler();
  (require('./integrations/discord') as typeof import('./integrations/discord')).startEventBridge();
  (require('./services/inventory') as typeof import('./services/inventory')).startSnapshotWatcher();

  // Daily maintenance: prune old analytics timeline rows + closed sessions so the
  // DB doesn't grow without bound over months of uptime. Runs shortly after boot,
  // then every 24h.
  const ANALYTICS_RETENTION_DAYS = 90;
  function runMaintenance(): void {
    try {
      const ingest = require('./analytics/ingest') as typeof import('./analytics/ingest');
      const r = ingest.pruneOlderThan(ANALYTICS_RETENTION_DAYS);
      if (r.events || r.sessions) {
        console.log(
          `[maintenance] pruned ${r.events} timeline rows, ${r.sessions} sessions older than ${ANALYTICS_RETENTION_DAYS}d`
        );
      }
    } catch (err) {
      console.error('[maintenance] analytics prune failed:', err instanceof Error ? err.message : String(err));
    }
  }
  setTimeout(runMaintenance, 60_000).unref();
  setInterval(runMaintenance, 24 * 3600 * 1000).unref();

  // Docker integration comes up in the background — the panel must stay usable
  // when the daemon is down (setup wizard handles that state).
  (async () => {
    const { checkDocker } = require('./docker/connect') as typeof import('./docker/connect');
    const status = await checkDocker();
    if (!status.available) {
      console.warn(`[docker] daemon unavailable (${status.error}) — lifecycle features disabled until it comes up`);
      return;
    }
    console.log(`[docker] connected: ${status.os} (Docker ${status.version})`);
    const { startWatcher } = require('./docker/watcher') as typeof import('./docker/watcher');
    const serversService = require('./services/servers') as typeof import('./services/servers');
    await startWatcher().catch((err: unknown) =>
      console.error('[watcher] failed to start:', err instanceof Error ? err.message : String(err))
    );
    await serversService.refreshStatuses();
    // Periodic reconcile: without it, cached statuses drift after any missed
    // docker event and healthcheck-less servers stay 'starting' forever.
    const statusTimer = setInterval(
      () =>
        serversService
          .refreshStatuses()
          .catch((err: unknown) =>
            console.error('[status] refresh failed:', err instanceof Error ? err.message : String(err))
          ),
      60_000
    );
    statusTimer.unref();
    (require('./analytics/ingest') as typeof import('./analytics/ingest'))
      .startIngest()
      .catch((err: unknown) => console.error('[boot] analytics ingest failed:', err));
    (require('./analytics/stats') as typeof import('./analytics/stats')).startStatsIngest({});
    (require('./services/liveCache') as typeof import('./services/liveCache')).startLiveCache({});
    // Honor "start on panel boot"
    for (const s of serversService.listServers()) {
      if (s.auto_start && s.status !== 'running' && s.status !== 'starting') {
        serversService
          .startServer(s.id, { actor: 'system' })
          .catch((err: unknown) =>
            console.error(`[boot] auto-start ${s.id} failed:`, err instanceof Error ? err.message : String(err))
          );
      }
    }
  })().catch((err: unknown) => console.error('[boot] docker background init failed:', err));
}
