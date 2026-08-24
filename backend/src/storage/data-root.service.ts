import { Injectable } from '@nestjs/common';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ConfigService } from '../config/config.service';

const LAYOUT: string[] = [
  'servers',
  'backups',
  'blueprints',
  'library/mods',
  'library/modpacks',
  'library/worlds',
  'library/icons',
  'logs',
  'tmp',
];

export interface CleanTmpOptions {
  olderThanMs?: number;
}

/**
 * Bootstraps the ./data layout on boot. Everything the panel persists lives
 * under this one root so copying it migrates the whole panel. Ports
 * src/storage/dataRoot.ts verbatim; `DbService.onModuleInit` only mkdir's
 * the bare dataDir, not this full subdirectory layout, so this must run
 * separately (wired into main.ts's bootstrap, before migrations).
 */
@Injectable()
export class DataRootService {
  constructor(private readonly config: ConfigService) {}

  ensureDataRoot(): void {
    try {
      for (const dir of LAYOUT) {
        fs.mkdirSync(path.join(this.config.dataDir, dir), { recursive: true });
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Could not create the data directory at ${this.config.dataDir}: ${message}. ` +
          `Check that DATA_DIR points somewhere this user can write, then start the panel again.`,
      );
    }
    this.cleanTmp();
  }

  /**
   * Clean tmp/. On boot (no args) everything goes — nothing can be in
   * flight. The scheduled sweep passes { olderThanMs } so in-progress
   * transfers survive.
   */
  cleanTmp({ olderThanMs = 0 }: CleanTmpOptions = {}): void {
    const tmp = path.join(this.config.dataDir, 'tmp');
    const cutoff = Date.now() - olderThanMs;
    for (const entry of fs.readdirSync(tmp)) {
      const abs = path.join(tmp, entry);
      if (olderThanMs > 0) {
        let stat;
        try {
          stat = fs.statSync(abs);
        } catch {
          continue; // vanished mid-scan
        }
        if (stat.mtimeMs > cutoff) continue; // too fresh — may be in flight
      }
      fs.rmSync(abs, { recursive: true, force: true });
    }
  }
}
