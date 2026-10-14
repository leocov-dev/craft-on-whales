import { Injectable } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import * as os from 'node:os';
import type { HostUsage } from '../../../shared/types/monitoring';

interface CpuSnapshot {
  busy: number;
  total: number;
}

/** Calls closer together than this reuse the last CPU reading (deltas get noisy). */
const MIN_CPU_WINDOW_MS = 1000;

/**
 * Raw host CPU/memory. Inside the panel container `/proc/meminfo` and
 * `os.cpus()` report the host (the Linux VM on Docker Desktop), not a cgroup.
 */
@Injectable()
export class HostStatsService {
  private lastCpu: CpuSnapshot = this.cpuSnapshot();
  private lastCpuAt = Date.now();
  private lastCpuFraction = 0;

  async current(): Promise<HostUsage> {
    const ncpu = os.cpus().length;
    const memTotalBytes = os.totalmem();
    return {
      // Same unit as the per-server charts: 100% = one core.
      cpuPct: Math.round(this.cpuFraction() * ncpu * 1000) / 10,
      ncpu,
      memUsedBytes: memTotalBytes - (await this.memAvailableBytes()),
      memTotalBytes,
    };
  }

  private cpuSnapshot(): CpuSnapshot {
    let busy = 0;
    let total = 0;
    for (const { times } of os.cpus()) {
      const all = times.user + times.nice + times.sys + times.idle + times.irq;
      total += all;
      busy += all - times.idle;
    }
    return { busy, total };
  }

  /** Busy fraction (0-1) of all cores since the previous reading. */
  private cpuFraction(): number {
    const now = Date.now();
    if (now - this.lastCpuAt < MIN_CPU_WINDOW_MS) return this.lastCpuFraction;
    const snap = this.cpuSnapshot();
    const total = snap.total - this.lastCpu.total;
    if (total > 0) {
      this.lastCpuFraction = Math.min(
        Math.max((snap.busy - this.lastCpu.busy) / total, 0),
        1,
      );
    }
    this.lastCpu = snap;
    this.lastCpuAt = now;
    return this.lastCpuFraction;
  }

  /** `MemAvailable` counts reclaimable page cache as free, unlike `os.freemem()`. */
  private async memAvailableBytes(): Promise<number> {
    try {
      const meminfo = await readFile('/proc/meminfo', 'utf8');
      const kb = /^MemAvailable:\s+(\d+) kB/m.exec(meminfo)?.[1];
      if (kb) return Number(kb) * 1024;
    } catch {
      /* not Linux; fall through */
    }
    return os.freemem();
  }
}
