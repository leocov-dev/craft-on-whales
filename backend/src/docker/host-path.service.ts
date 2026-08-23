import { Injectable } from '@nestjs/common';
import * as path from 'node:path';
import { ConfigService } from '../config/config.service';

/**
 * Re-roots panel-local paths into HOST paths for Docker bind mounts. The
 * daemon resolves every bind against the host filesystem — when the panel
 * itself runs inside a container (DATA_DIR_HOST set), its local view of the
 * data directory (e.g. /data/servers/abc) does not exist on the host, so any
 * path handed to the daemon must be rewritten under DATA_DIR_HOST first.
 * Bare metal, where DATA_DIR_HOST is unset, this is the identity function.
 */
@Injectable()
export class HostPathService {
  constructor(private readonly config: ConfigService) {}

  private hostSep(): '\\' | '/' {
    // DATA_DIR_HOST describes the host's filesystem, which may use a
    // different separator than the panel's runtime (Linux container
    // managing a Windows Docker Desktop host, or vice versa) — so the
    // joined suffix must follow the host path's own convention, not
    // path.sep.
    return /^[A-Za-z]:/.test(this.config.dataDirHost) || this.config.dataDirHost.includes('\\') ? '\\' : '/';
  }

  /**
   * Translate an absolute panel-local path under DATA_DIR into the
   * equivalent host path under DATA_DIR_HOST. Throws on paths outside
   * DATA_DIR — those have no host equivalent and binding them would
   * silently mount the wrong directory.
   */
  toHostPath(abs: string): string {
    if (this.config.dataDirHost === this.config.dataDir) return abs;
    const rel = path.relative(this.config.dataDir, path.resolve(abs));
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(
        `Cannot bind ${abs}: it is outside DATA_DIR (${this.config.dataDir}), so it has no host-side equivalent under DATA_DIR_HOST.`
      );
    }
    if (rel === '') return this.config.dataDirHost;
    const hostSep = this.hostSep();
    const suffix = rel.split(path.sep).join(hostSep);
    const base = this.config.dataDirHost === '/' ? '' : this.config.dataDirHost;
    return `${base}${hostSep}${suffix}`;
  }
}
