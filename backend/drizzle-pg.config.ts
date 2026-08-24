import { defineConfig } from 'drizzle-kit';

// DATABASE_URL is only read by drizzle-kit itself (generate/migrate CLI),
// not by the running app — DbModule resolves the real connection from
// ConfigService. Matches drizzle.config.ts's split for the SQLite side.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema-pg/index.ts',
  out: './drizzle-pg',
  dbCredentials: {
    url:
      process.env.DATABASE_URL ??
      'postgres://postgres:postgres@localhost:5432/panel',
  },
});
