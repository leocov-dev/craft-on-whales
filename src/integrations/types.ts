'use strict';

// Shared types for src/integrations. Extracted to their own file (rather than
// living alongside a CommonJS `export =` in discord.ts/statusPage.ts) because
// tsx's esbuild-based CJS loader transforms each file independently and can
// silently drop type-only exports mixed into a file that also has an
// `export =` value statement (see src/db/types.ts).

/** An `integrations` row (see db/migrations/002_parity.ts). */
export interface IntegrationRow {
  server_id: string;
  kind: string;
  enabled: number;
  config_cipher: string | null;
  config_json: string;
  updated_at: string;
}
