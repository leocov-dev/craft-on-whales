import { z } from 'zod';

// Zod schemas for Spiget v2 responses (https://spiget.org/documentation) —
// only the fields SpigetApiService reads. Resource objects also carry a large
// base64 `description` and `icon.data`; those are deliberately not declared.

export const spigetResourceSchema = z.object({
  id: z.number(),
  name: z.string(),
  tag: z.string().nullable().optional(),
  downloads: z.number().optional(),
  icon: z.object({ url: z.string().nullable().optional() }).optional(),
  testedVersions: z.array(z.string()).optional(),
  external: z.boolean().optional(),
  premium: z.boolean().optional(),
  file: z.object({ type: z.string().nullable().optional() }).optional(),
});

export const spigetResourceListSchema = z.array(spigetResourceSchema);

export const spigetVersionSchema = z.object({
  id: z.number(),
  name: z.string().nullable().optional(),
  // Unix seconds.
  releaseDate: z.number().nullable().optional(),
});

export const spigetVersionListSchema = z.array(spigetVersionSchema);

export type RawSpigetResource = z.infer<typeof spigetResourceSchema>;
