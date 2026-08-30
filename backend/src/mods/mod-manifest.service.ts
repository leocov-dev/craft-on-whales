import { Injectable } from '@nestjs/common';
import * as fs from 'node:fs';
import { z } from 'zod';
import { PathGuardService } from '../storage/path-guard.service';

export interface ManifestEntry {
  slug: string | null;
  projectId: string | null;
}

// Shape of the one kind of leaf object this walk actually extracts data
// from — validated via safeParse instead of ad-hoc `typeof`/`??` chains.
// `.passthrough()` since the manifest carries plenty of other fields per
// entry that are irrelevant here.
const manifestLeafSchema = z
  .object({
    fileName: z.string().optional(),
    filename: z.string().optional(),
    slug: z.string().optional(),
    projectSlug: z.string().optional(),
    projectID: z.union([z.string(), z.number()]).optional(),
    projectId: z.union([z.string(), z.number()]).optional(),
    modId: z.union([z.string(), z.number()]).optional(),
  })
  .passthrough();

// A malicious/corrupt manifest could nest arbitrarily deep or contain huge
// arrays — bound both dimensions of the recursive walk below.
const MAX_VISIT_DEPTH = 32;
const MAX_VISIT_NODES = 50_000;

/**
 * Reads a pack server's `.curseforge-manifest.json` (written by mc-image-helper
 * for CurseForge-sourced packs) and indexes it by jar filename -> {slug,
 * projectId}. Split out of `ModsService` per `.plan/reviews/04-mods.md`
 * ("no sub-collaborators for the manifest-parsing... concerns").
 */
@Injectable()
export class ModManifestService {
  constructor(private readonly pathGuard: PathGuardService) {}

  /** Best-effort filename -> {slug, projectId} map from the pack's CF manifest. */
  index(serverId: string): Map<string, ManifestEntry> {
    const map = new Map<string, ManifestEntry>();
    let data: unknown;
    try {
      data = JSON.parse(
        fs.readFileSync(
          this.pathGuard.dataPath(
            'servers',
            serverId,
            '.curseforge-manifest.json',
          ),
          'utf8',
        ),
      );
    } catch {
      return map;
    }
    let visited = 0;
    const visit = (node: unknown, depth: number): void => {
      if (depth > MAX_VISIT_DEPTH || visited >= MAX_VISIT_NODES) return;
      visited += 1;
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        for (const v of node) visit(v, depth + 1);
        return;
      }
      const parsed = manifestLeafSchema.safeParse(node);
      if (parsed.success) {
        const { fileName, filename, slug, projectSlug } = parsed.data;
        const fname = fileName || filename;
        const pid =
          parsed.data.projectID ?? parsed.data.projectId ?? parsed.data.modId;
        if (
          fname &&
          /\.jar$/i.test(fname) &&
          (slug || projectSlug || pid != null)
        ) {
          map.set(fname, {
            slug: slug || projectSlug || null,
            projectId: pid == null ? null : String(pid),
          });
        }
      }
      for (const v of Object.values(node as Record<string, unknown>))
        visit(v, depth + 1);
    };
    visit(data, 0);
    return map;
  }
}
