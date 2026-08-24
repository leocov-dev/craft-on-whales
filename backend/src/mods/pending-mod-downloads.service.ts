import { Injectable } from '@nestjs/common';
import * as fs from 'node:fs';
import { PathGuardService } from '../storage/path-guard.service';
import type { PendingDownload } from '../../../shared/types/mods';

export type { PendingDownload };

/**
 * Parses/manages `MODS_NEED_DOWNLOAD.txt` — a CurseForge pack can pin mods
 * whose authors disallow automated download (or that were pulled from CF).
 * mc-image-helper then writes this file and the pack install FAILS until
 * each entry is excluded or supplied by hand; this turns that dead-end into
 * guided actions. Split out of `ModsService` per `.plan/reviews/04-mods.md`
 * ("no sub-collaborators for... pending-download parsing").
 */
@Injectable()
export class PendingModDownloadsService {
  constructor(private readonly pathGuard: PathGuardService) {}

  /** Parse MODS_NEED_DOWNLOAD.txt text → [{ name, versionName, filename, url, slug, fileId }]. */
  private parse(text: string | null | undefined): PendingDownload[] {
    const out: PendingDownload[] = [];
    for (const line of String(text || '').split(/\r?\n/)) {
      const m = /(https?:\/\/\S*curseforge\.com\/\S+)/i.exec(line); // only data rows carry a URL
      if (!m) continue;
      const cols = line
        .slice(0, m.index)
        .split(/\s{2,}/)
        .map((s) => s.trim())
        .filter(Boolean);
      const filename = cols[cols.length - 1] || '';
      const versionName = cols.length > 1 ? cols[cols.length - 2]! : '';
      const name =
        cols.length > 2 ? cols.slice(0, -2).join(' ') : cols[0] || filename;
      const slug =
        (/curseforge\.com\/minecraft\/mc-mods\/([^/]+)/i.exec(m[1]!) ||
          [])[1] || null;
      const fileId = (/\/download\/(\d+)/.exec(m[1]!) || [])[1] || null;
      out.push({ name, versionName, filename, url: m[1]!, slug, fileId });
    }
    return out;
  }

  /** Mods a CF pack needs supplied by hand, parsed from the server's MODS_NEED_DOWNLOAD.txt. */
  pendingDownloads(serverId: string): PendingDownload[] {
    try {
      return this.parse(
        fs.readFileSync(
          this.pathGuard.dataPath(
            'servers',
            serverId,
            'MODS_NEED_DOWNLOAD.txt',
          ),
          'utf8',
        ),
      );
    } catch {
      return [];
    }
  }

  /** The exclusion token (slug preferred) for a pending mod identified by filename. */
  pendingExcludeToken(serverId: string, filename: string): string {
    const entry = this.pendingDownloads(serverId).find(
      (p) => p.filename === filename,
    );
    return (entry && entry.slug) || filename.replace(/(-[\d.]+.*)?\.jar$/, '');
  }

  /** Drop a resolved mod's line from MODS_NEED_DOWNLOAD.txt (best-effort). */
  clearPendingLine(
    serverId: string,
    filename: string | null | undefined,
  ): void {
    const file = this.pathGuard.dataPath(
      'servers',
      serverId,
      'MODS_NEED_DOWNLOAD.txt',
    );
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      return;
    }
    const kept = text
      .split(/\r?\n/)
      .filter((l) => !filename || !l.includes(filename));
    try {
      if (kept.some((l) => /curseforge\.com/i.test(l)))
        fs.writeFileSync(file, kept.join('\n'));
      else fs.rmSync(file, { force: true });
    } catch {
      /* ownership not aligned yet — the banner clears on the next successful start */
    }
  }
}
