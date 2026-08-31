import { z } from 'zod';

// Zod schemas for Modrinth API responses — only the fields this codebase
// actually reads (mirrors the hand-written interfaces in mods.types.ts).
// Validating at the trust boundary means a shape change on Modrinth's end
// surfaces as a clear parse error instead of `undefined` silently
// propagating through `normalizeMod`-style downstream code.

export const searchHitSchema = z.object({
  project_id: z.string(),
  slug: z.string(),
  title: z.string(),
  description: z.string(),
  icon_url: z.string().nullable().optional(),
  downloads: z.number(),
  categories: z.array(z.string()),
  latest_version: z.string(),
});

export const searchResponseSchema = z.object({
  hits: z.array(searchHitSchema),
});

export const projectSchema = z.object({
  id: z.string(),
  slug: z.string(),
  title: z.string(),
  icon_url: z.string().nullable().optional(),
  project_type: z.string(),
  downloads: z.number().optional(),
  body: z.string().optional(),
});

const fileSchema = z.object({
  url: z.string(),
  filename: z.string(),
  primary: z.boolean(),
  hashes: z.object({ sha1: z.string(), sha512: z.string() }),
  size: z.number(),
});

const dependencySchema = z.object({
  project_id: z.string().nullable().optional(),
  dependency_type: z.string().optional(),
});

export const versionSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  version_number: z.string(),
  date_published: z.string().nullable().optional(),
  version_type: z.string().optional(),
  game_versions: z.array(z.string()),
  loaders: z.array(z.string()).optional(),
  files: z.array(fileSchema),
  dependencies: z.array(dependencySchema).optional(),
});

export const versionListSchema = z.array(versionSchema);
