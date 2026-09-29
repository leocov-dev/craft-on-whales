import { z } from 'zod';

// Zod schemas for Hangar API v1 responses (https://hangar.papermc.io/api-docs)
// — only the fields HangarApiService reads.

export const hangarProjectSchema = z.object({
  name: z.string(),
  namespace: z.object({ owner: z.string(), slug: z.string() }),
  description: z.string().nullable().optional(),
  avatarUrl: z.string().nullable().optional(),
  stats: z.object({ downloads: z.number().optional() }).optional(),
});

export const hangarProjectListSchema = z.object({
  result: z.array(hangarProjectSchema),
});

const hangarDownloadSchema = z.object({
  fileInfo: z
    .object({
      name: z.string(),
      sizeBytes: z.number().nullable().optional(),
      sha256Hash: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  downloadUrl: z.string().nullable().optional(),
  externalUrl: z.string().nullable().optional(),
});

export const hangarVersionSchema = z.object({
  name: z.string(),
  createdAt: z.string().nullable().optional(),
  channel: z.object({ name: z.string() }).nullable().optional(),
  // Keyed by platform: PAPER / VELOCITY / WATERFALL.
  downloads: z.record(z.string(), hangarDownloadSchema).optional(),
  platformDependencies: z.record(z.string(), z.array(z.string())).optional(),
});

export const hangarVersionListSchema = z.object({
  result: z.array(hangarVersionSchema),
});

export type RawHangarProject = z.infer<typeof hangarProjectSchema>;
export type RawHangarVersion = z.infer<typeof hangarVersionSchema>;
