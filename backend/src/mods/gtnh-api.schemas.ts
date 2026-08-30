import { z } from 'zod';

// GTNH's versions.json index is an object keyed by version string. Each
// entry's fields are read defensively (typeof/Number.isInteger checks)
// regardless, so this schema only pins down the top-level shape — a record
// of records — replacing the previous unchecked `as Record<...>` cast.
const entrySchema = z.record(z.string(), z.unknown()).nullable();

export const indexSchema = z.record(z.string(), entrySchema);
