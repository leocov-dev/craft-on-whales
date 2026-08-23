import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { IoAdapter } from '@nestjs/platform-socket.io';
import session from 'express-session';
import { AppModule } from './app.module';
import { ConfigService } from './config/config.service';
import { DbService } from './db/db.service';
import { runMigrations } from './db/migrate';
import { SessionService } from './auth/session.service';
import { DataRootService } from './storage/data-root.service';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.enableShutdownHooks();

  // Nest's default WS adapter speaks raw `ws`, not socket.io — installing
  // @nestjs/platform-socket.io alone doesn't change that. @WebSocketGateway()
  // gateways (ConsoleGateway/StatsGateway) only bind over socket.io once this
  // is set explicitly. See src/ws/WS_NOTES.md.
  app.useWebSocketAdapter(new IoAdapter(app));

  const config = app.get(ConfigService);
  if (config.trustProxy !== false) app.set('trust proxy', config.trustProxy);

  // Registered before app.init() deliberately: init() is what mounts Nest's
  // router onto the underlying Express app, so any app.use() added after it
  // would run AFTER route dispatch in the middleware stack — guards and
  // controllers would see an empty req.session. ConfigService resolves
  // sessionSecret synchronously in its constructor for exactly this reason.
  const sessionService = app.get(SessionService);
  app.use(
    session({
      store: sessionService.store,
      secret: config.sessionSecret,
      name: sessionService.cookieName,
      resave: false,
      saveUninitialized: false,
      rolling: true,
      cookie: {
        httpOnly: true,
        sameSite: 'strict',
        maxAge: 7 * 24 * 3600 * 1000,
        // Default false (plain-HTTP localhost/LAN). Set COOKIE_SECURE=true (or
        // 'auto' with TRUST_PROXY set) when serving over HTTPS behind a TLS proxy.
        secure: config.cookieSecure,
      },
    })
  );

  // Data root + migrations run BEFORE app.init() deliberately: init() fires
  // every module's onModuleInit together (e.g. SchedulerModule's, which
  // queries the `schedules` table to arm cron jobs) — if migrations ran
  // after init() like they used to, a module with DB-touching boot logic
  // could run before the schema exists. DbService's connection is a plain
  // constructor side effect now (not onModuleInit) specifically so it's
  // ready this early, right after NestFactory.create()'s DI graph resolves.
  app.get(DataRootService).ensureDataRoot();
  await runMigrations(app.get(DbService));

  await app.init();

  await app.listen(config.port, config.host);
}
bootstrap();
