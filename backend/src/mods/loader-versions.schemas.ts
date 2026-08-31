import { z } from 'zod';

// Zod schemas for the loader-version endpoints (Fabric/Quilt/NeoForge/Forge).
// `getBuilds()`'s callers already wrap each of these in a try/catch that
// degrades to a "Latest"-only result on any failure, so parse errors here
// don't need their own handling — they just join the existing best-effort path.

const fabricLoaderVersionSchema = z.object({
  version: z.string().optional(),
  stable: z.boolean().optional(),
});
export const fabricLoaderListSchema = z
  .array(fabricLoaderVersionSchema)
  .nullable()
  .optional();

export const neoforgeVersionsSchema = z.object({
  versions: z.array(z.string()).optional(),
});

export const forgePromotionsSchema = z.object({
  promos: z.record(z.string(), z.string()).optional(),
});
