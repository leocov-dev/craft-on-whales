import { Injectable } from '@nestjs/common';
import type { ContainerStats } from 'dockerode';
import { ContainerService } from './container.service';

export interface NormalizedStats {
  cpuPct: number;
  memUsedBytes: number;
  memLimitBytes: number;
  netRx: number;
  netTx: number;
}

/**
 * Live container stats for dashboards/metrics. One-shot and streaming
 * forms; numbers normalized to { cpuPct, memUsedBytes, memLimitBytes, netRx, netTx }.
 */
@Injectable()
export class DockerStatsService {
  constructor(private readonly containers: ContainerService) {}

  normalize(stats: ContainerStats): NormalizedStats {
    // CPU % per Docker's documented formula.
    let cpuPct = 0;
    try {
      const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
      const sysDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
      const online = stats.cpu_stats.online_cpus || (stats.cpu_stats.cpu_usage.percpu_usage || []).length || 1;
      if (sysDelta > 0 && cpuDelta > 0) cpuPct = (cpuDelta / sysDelta) * online * 100;
    } catch {
      /* fields absent on some platforms until second sample */
    }

    // memory_stats is documented as always present, but is defensively
    // guarded here since some platforms (Windows) omit sub-fields.
    const mem: Partial<ContainerStats['memory_stats']> = stats.memory_stats || {};
    // Subtract page cache where reported so numbers match `docker stats`.
    const cache = (mem.stats && (mem.stats.inactive_file ?? mem.stats.cache)) || 0;
    const memUsed = Math.max(0, (mem.usage || 0) - cache);

    let netRx = 0;
    let netTx = 0;
    for (const nic of Object.values(stats.networks || {})) {
      netRx += nic.rx_bytes || 0;
      netTx += nic.tx_bytes || 0;
    }
    return {
      cpuPct: Math.round(cpuPct * 10) / 10,
      memUsedBytes: memUsed,
      memLimitBytes: mem.limit || 0,
      netRx,
      netTx,
    };
  }

  async statsOnce(serverId: string): Promise<NormalizedStats | null> {
    try {
      const stats = (await this.containers.getContainer(serverId).stats({ stream: false })) as unknown as ContainerStats;
      return this.normalize(stats);
    } catch (err: unknown) {
      const statusCode = (err as { statusCode?: number }).statusCode;
      if (statusCode === 404 || statusCode === 409) return null;
      throw err;
    }
  }

  /** Stream stats; onSample(normalized) per tick. Returns stop(). */
  async statsStream(serverId: string, onSample: (stats: NormalizedStats) => void): Promise<() => void> {
    const raw = (await this.containers.getContainer(serverId).stats({ stream: true })) as unknown as NodeJS.ReadableStream;
    let buffer = '';
    // Without this, a container removal mid-stream emits an unhandled
    // 'error' event that would crash the whole panel process.
    raw.on('error', () => {
      /* consumer notices via silence; stop() cleans up */
    });
    raw.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let idx: number;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        try {
          onSample(this.normalize(JSON.parse(line)));
        } catch {
          /* partial frame */
        }
      }
    });
    return () => {
      try {
        (raw as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
      } catch {
        /* closed */
      }
    };
  }
}
