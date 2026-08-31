import { z } from 'zod';

// Zod schemas for CurseForge API responses — only the fields this codebase
// actually reads (mirrors the hand-written Raw* interfaces previously local
// to curseforge-api.service.ts).

const logoSchema = z.object({
  thumbnailUrl: z.string().nullable().optional(),
  url: z.string().nullable().optional(),
});

const dependencySchema = z.object({
  modId: z.number(),
  relationType: z.number(),
});

const fileSchema = z.object({
  id: z.number(),
  displayName: z.string(),
  fileName: z.string(),
  downloadUrl: z.string().nullable().optional(),
  gameVersions: z.array(z.string()).optional(),
  releaseType: z.number().optional(),
  fileDate: z.string(),
  fileLength: z.number(),
  hashes: z.array(z.unknown()).optional(),
  serverPackFileId: z.number().nullable().optional(),
  dependencies: z.array(dependencySchema).optional(),
});

const modSchema = z.object({
  id: z.number(),
  slug: z.string(),
  name: z.string(),
  summary: z.string(),
  logo: logoSchema.nullable().optional(),
  downloadCount: z.number(),
  classId: z.number(),
  latestFiles: z.array(fileSchema).optional(),
});

export const modSearchResponseSchema = z.object({
  data: z.array(modSchema),
});

export const modResponseSchema = z.object({
  data: modSchema,
});

export const fileListResponseSchema = z.object({
  data: z.array(fileSchema),
});

export const fileResponseSchema = z.object({
  data: fileSchema,
});

export const descriptionResponseSchema = z.object({
  data: z.unknown(),
});

export type RawCfMod = z.infer<typeof modSchema>;
export type RawCfFile = z.infer<typeof fileSchema>;
