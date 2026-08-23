import { defineConfig } from 'drizzle-kit';

// DB_FILE is only read by drizzle-kit itself (generate/migrate CLI), not by
// the running app — DbModule resolves the real path from ConfigService.
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema/index.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DB_FILE ?? './data/panel.db',
  },
});
