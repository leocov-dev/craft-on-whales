import { Injectable } from '@nestjs/common';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Docker, { type DockerOptions } from 'dockerode';

export interface DockerStatus {
  available: boolean;
  installed: boolean | null;
  version: string | null;
  os: string | null;
  ncpu: number | null;
  memTotal: number | null;
  isDockerDesktop: boolean;
  error: string | null;
}

/**
 * Docker connection management. Auto-detects the right endpoint per platform:
 *   Windows  → \\.\pipe\docker_engine (Docker Desktop named pipe)
 *   Unix     → /var/run/docker.sock, falling back to rootless / newer Docker
 *              Desktop socket locations under the user's home.
 *   DOCKER_HOST env var wins when set.
 * Exposes availability state the UI uses for the setup wizard. Never throws
 * on a missing/unreachable daemon — the panel must stay usable while Docker
 * is down (setup wizard, settings, etc.), matching legacy connect.ts.
 */
@Injectable()
export class DockerConnectionService {
  private client: Docker | null = null;

  private detectOptions(): DockerOptions {
    if (process.env.DOCKER_HOST) return {}; // dockerode reads DOCKER_HOST itself
    if (process.platform === 'win32')
      return { socketPath: '//./pipe/docker_engine' };
    // Prefer the classic system socket, but recent Docker Desktop (macOS) and
    // rootless Docker/Podman only expose a per-user socket — probe those too
    // so a stranger with a default install isn't told "daemon unavailable".
    const candidates: string[] = [
      '/var/run/docker.sock',
      path.join(os.homedir(), '.docker', 'run', 'docker.sock'),
      process.env.XDG_RUNTIME_DIR
        ? path.join(process.env.XDG_RUNTIME_DIR, 'docker.sock')
        : null,
    ].filter((p): p is string => Boolean(p));
    const found = candidates.find((p) => {
      try {
        return fs.existsSync(p);
      } catch {
        return false;
      }
    });
    return { socketPath: found || '/var/run/docker.sock' };
  }

  getDocker(): Docker {
    if (!this.client) this.client = new Docker(this.detectOptions());
    return this.client;
  }

  /**
   * The host-side Docker socket path the panel itself connects through, for
   * bind-mounting into a container that needs its own Docker API access
   * (e.g. mc-router's auto-scale). Null when connecting via DOCKER_HOST
   * (nothing to bind-mount) or on Windows (named-pipe mounting isn't
   * supported here — v1 mc-router auto-scale is Unix/Docker-Desktop-macOS
   * only).
   */
  getSocketPath(): string | null {
    if (process.env.DOCKER_HOST || process.platform === 'win32') return null;
    return this.detectOptions().socketPath || null;
  }

  /** Probe the daemon. Never throws — returns a status object the setup wizard renders directly. */
  async checkDocker(): Promise<DockerStatus> {
    const status: DockerStatus = {
      available: false,
      installed: null, // best-effort; null = unknown
      version: null,
      os: null,
      ncpu: null,
      memTotal: null,
      isDockerDesktop: false,
      error: null,
    };
    try {
      const docker = this.getDocker();
      const [version, info] = await Promise.all([
        docker.version(),
        docker.info() as Promise<{
          OperatingSystem?: string;
          NCPU?: number;
          MemTotal?: number;
        }>,
      ]);
      status.available = true;
      status.installed = true;
      status.version = version.Version;
      status.os = info.OperatingSystem || '';
      status.ncpu = info.NCPU ?? null;
      status.memTotal = info.MemTotal ?? null;
      status.isDockerDesktop = /docker desktop/i.test(status.os || '');
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException & { message?: string };
      status.error = e.code || e.message || String(err);
      if (process.platform === 'win32') {
        status.installed = fs.existsSync(
          process.env.ProgramFiles + '\\Docker\\Docker\\Docker Desktop.exe',
        );
      }
    }
    return status;
  }
}
