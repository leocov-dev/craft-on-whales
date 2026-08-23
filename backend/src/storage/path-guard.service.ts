import { Injectable, BadRequestException } from '@nestjs/common';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ConfigService } from '../config/config.service';

// Path containment guard. EVERY filesystem operation on user-influenced paths
// must resolve through one of these helpers — nothing may escape DATA_DIR.
// This is the containment primitive only; the rest of the legacy
// `src/storage/` tree (indexer, quotas, dataRoot) is StorageModule's job,
// built later per the plan — ServersModule needs `dataPath`/`safeJoin` now.

export class PathEscapeError extends BadRequestException {
  readonly attempted: string;
  constructor(attempted: string) {
    super('Path escapes the panel data directory');
    this.attempted = attempted;
  }
}

@Injectable()
export class PathGuardService {
  private readonly realBaseCache = new Map<string, string | null>();

  constructor(private readonly config: ConfigService) {}

  private realBaseOf(base: string): string | null {
    const cached = this.realBaseCache.get(base);
    if (cached !== undefined) return cached;
    let real: string | null = null;
    try {
      real = fs.realpathSync.native(base);
    } catch {
      return null; // base doesn't exist yet — don't cache, retry later
    }
    this.realBaseCache.set(base, real);
    return real;
  }

  /**
   * Reject a symlink escape the lexical check in safeJoin can't see: find the
   * deepest component of `resolved` that exists on disk, resolve it through
   * any symlinks, and confirm it's still inside `base`.
   */
  private assertRealContainment(base: string, resolved: string, attempted: string): void {
    const realBase = this.realBaseOf(base);
    if (realBase === null) return; // base doesn't exist yet — nothing to escape

    let dir = resolved;
    for (;;) {
      try {
        fs.lstatSync(dir);
        break;
      } catch {
        const parent = path.dirname(dir);
        if (parent === dir) return; // reached filesystem root without an anchor
        dir = parent;
      }
    }

    let realDir: string;
    try {
      realDir = fs.realpathSync.native(dir);
    } catch {
      try {
        const parentReal = fs.realpathSync.native(path.dirname(dir));
        realDir = path.resolve(parentReal, fs.readlinkSync(dir));
      } catch {
        return; // vanished between checks — the caller's own op will fail
      }
    }
    const rel = path.relative(realBase, realDir);
    if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      throw new PathEscapeError(attempted);
    }
  }

  /**
   * Resolve `parts` under `base` (absolute) and throw unless the result stays
   * within `base`. Rejects NUL bytes and Windows alternate data streams, and
   * rejects symlinks that resolve outside `base`.
   */
  safeJoin(base: string, ...parts: string[]): string {
    const joined = parts.join('/');
    if (joined.includes('\0') || /(^|[\\/])[^\\/]*:[^\\/]*$/.test(joined.replace(/^[a-zA-Z]:/, ''))) {
      throw new PathEscapeError(joined);
    }
    const resolved = path.resolve(base, joined);
    const rel = path.relative(base, resolved);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new PathEscapeError(joined);
    this.assertRealContainment(base, resolved, joined);
    return resolved;
  }

  /** Resolve a path under the panel data root. */
  dataPath(...parts: string[]): string {
    return this.safeJoin(this.config.dataDir, ...parts);
  }

  /** True when `candidate` (absolute) lies inside the data root. */
  isInsideDataDir(candidate: string): boolean {
    const rel = path.relative(this.config.dataDir, path.resolve(candidate));
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  }
}
