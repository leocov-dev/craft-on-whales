import { Injectable } from '@nestjs/common';
import * as os from 'node:os';

const MB = 1024 * 1024;

/**
 * Auto-sized Java heap for a new server: a modest share of host RAM, bounded.
 * The panel is meant to run many servers side by side, and every server gets
 * its own heap and a container limit above it, so the share is deliberately
 * small. A 32 GB host gets 4 GB per server, a 16 GB host 2 GB, an 8 GB host 1 GB.
 * Use DEFAULT_HEAP_MB to pick a different starting point.
 */
export const AUTO_HEAP_HOST_FRACTION = 0.125;
export const AUTO_HEAP_MIN_MB = 1024;
export const AUTO_HEAP_MAX_MB = 4096;

/** The container memory limit is the heap plus this much headroom (a ratio). */
export const CONTAINER_MEMORY_RATIO = 1.5;

/** Heap, in MB, for a host with `hostMb` of RAM; rounded to 512 MB steps. */
export function autoHeapMb(hostMb: number): number {
  const share = Math.round((hostMb * AUTO_HEAP_HOST_FRACTION) / 512) * 512;
  return Math.min(AUTO_HEAP_MAX_MB, Math.max(AUTO_HEAP_MIN_MB, share));
}

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
    const heapMb = envHeap || autoHeapMb(hostMb);
    const containerMemoryMb =
      envContainer || Math.round((heapMb * CONTAINER_MEMORY_RATIO) / 512) * 512;
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
