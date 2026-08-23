import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Pool } from 'pg';
import { drizzle as drizzleSqlite } from 'drizzle-orm/node-sqlite';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import { ConfigService, DbDriver } from '../config/config.service';

// drizzle({ client: sqlite }) is required — drizzle(sqlite) silently opens a
// throwaway :memory: DB instead of the real file (see DRIZZLE_NOTES.md).
//
// This RC's config type omits `schema` entirely (relational-query schema is
// now wired via `relations()`/`defineRelations`, not a plain table map), so
// DbService exposes the plain SQL-like query builder (db.select/insert/...)
// against the schema/* table exports directly, not db.query.*.
//
// Connection setup lives in the CONSTRUCTOR, not onModuleInit: it used to be
// onModuleInit, but Nest runs every module's onModuleInit together during
// app.init() — once SchedulerModule's onModuleInit started querying tables
// at boot, it could run before migrations (invoked from main.ts, in between
// app.init() and app.listen(), not as a lifecycle hook) if DbService's
// connection wasn't ready earlier than that. This logic is fully
// synchronous and only depends on ConfigService (already resolved by
// constructor time via DI ordering), so there's no reason it needs to wait
// for the lifecycle phase at all.
@Injectable()
export class DbService implements OnModuleDestroy {
  readonly driver: DbDriver;
  private sqlite?: DatabaseSync;
  private pool?: Pool;
  // Always typed as the SQLite drizzle shape, even in Postgres mode — see
  // schema/DUAL_DIALECT_NOTES.md. The cast below is safe specifically
  // because schema/index.ts performs the matching cast on the table side:
  // in Postgres mode both this client and every table object app code
  // passes to it are genuinely real pg-core/node-postgres instances, just
  // typed as if they were the SQLite ones.
  db: ReturnType<typeof drizzleSqlite>;

  constructor(private readonly config: ConfigService) {
    this.driver = config.dbDriver;
    if (this.driver === 'postgres') {
      this.pool = new Pool({ connectionString: config.databaseUrl });
      this.db = drizzlePg({ client: this.pool }) as unknown as ReturnType<typeof drizzleSqlite>;
      return;
    }

    fs.mkdirSync(this.config.dataDir, { recursive: true });
    const dbFile = path.join(this.config.dataDir, 'panel.db');
    this.sqlite = new DatabaseSync(dbFile);
    this.sqlite.exec('PRAGMA journal_mode = WAL');
    this.sqlite.exec('PRAGMA foreign_keys = ON');
    this.db = drizzleSqlite({ client: this.sqlite });
  }

  async onModuleDestroy(): Promise<void> {
    if (this.driver === 'postgres') {
      await this.pool?.end();
    } else {
      this.sqlite?.close();
    }
  }
}
