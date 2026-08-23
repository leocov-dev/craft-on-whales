import { defineConfig } from 'drizzle-kit';

// DB_FILE is only read by drizzle-kit itself (generate/migrate CLI), not by
// the running app — DbModule resolves the real path from ConfigService.
export default defineConfig({
  dialect: 'sqlite',
  // Points at sqlite.ts, not index.ts — index.ts is a runtime dispatcher
  // (see src/db/schema/DUAL_DIALECT_NOTES.md) that would resolve to
  // whichever dialect DB_DRIVER happens to be set to in this shell.
  schema: './src/db/schema/sqlite.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DB_FILE ?? './data/panel.db',
  },
});
