import { Injectable } from '@nestjs/common';
import * as fs from 'node:fs';
import { PathGuardService } from '../storage/path-guard.service';

export interface ManifestEntry {
  slug: string | null;
  projectId: string | null;
}

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
    const visit = (node: unknown): void => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        node.forEach(visit);
        return;
      }
      const obj = node as Record<string, unknown>;
      const fname = obj.fileName || obj.filename;
      const slug = obj.slug || obj.projectSlug;
      const pid = obj.projectID ?? obj.projectId ?? obj.modId;
      if (
        typeof fname === 'string' &&
        /\.jar$/i.test(fname) &&
        (slug || pid != null)
      ) {
        let projectId: string | null = null;
        if (typeof pid === 'string' || typeof pid === 'number') {
          projectId = String(pid);
        } else if (pid != null) {
          projectId = JSON.stringify(pid);
        }
        map.set(fname, {
          slug: (slug as string) || null,
          projectId,
        });
      }
      for (const v of Object.values(obj)) visit(v);
    };
    visit(data);
    return map;
  }
}
