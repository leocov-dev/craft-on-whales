import { Injectable } from '@nestjs/common';
import * as os from 'node:os';

const MB = 1024 * 1024;

export interface ResourceDefaults {
  heapMb: number;
  containerMemoryMb: number;
  cpus: number;
  diskQuotaGb: number;
  quotaWarnPct: number;
  quotaCriticalPct: number;
}

/**
 * Derives resource defaults (heap/container memory/disk quota) from host
 * memory + optional env overrides. Split out of `ConfigService` for
 * isolated testability (SRP finding, `.plan/reviews/01-core-infra.md`).
 */
@Injectable()
export class ResourceDefaultsResolver {
  private numFromEnv(
    name: string,
    fallback: number,
    { min = 0, max = Number.MAX_SAFE_INTEGER } = {},
  ): number {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === '') return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) {
      throw new Error(
        `${name} must be an integer between ${min} and ${max} — got "${raw}". Fix it in your .env (or leave it blank for the default ${fallback}).`,
      );
    }
    return n;
  }

  resolve(): ResourceDefaults {
    const envHeap = this.numFromEnv('DEFAULT_HEAP_MB', 0, {
      min: 0,
      max: 1024 * 1024,
    });
    const envContainer = this.numFromEnv('DEFAULT_CONTAINER_MEMORY_MB', 0, {
      min: 0,
      max: 1024 * 1024,
    });
    const envQuota = this.numFromEnv('DEFAULT_DISK_QUOTA_GB', 0, {
      min: 0,
      max: 1024 * 1024,
    });
    const hostMb = os.totalmem() / MB;
    const autoHeap = Math.min(
      8192,
      Math.max(1024, Math.round((hostMb * 0.25) / 512) * 512),
    );
    const heapMb = envHeap || autoHeap;
    const containerMemoryMb =
      envContainer || Math.round((heapMb * 1.5) / 512) * 512;
    return {
      heapMb,
      containerMemoryMb,
      cpus: 0,
      diskQuotaGb: envQuota || 25,
      quotaWarnPct: 80,
      quotaCriticalPct: 95,
    };
  }
}
