import { Injectable } from '@nestjs/common';

/**
 * JVM heap sizing: what a size field means to Java, and what the number the
 * panel shows actually represents. See SERVERS_NOTES.md ("Heap sizing and the
 * idle-memory question") for the measurements behind the wording here.
 */

/** Env keys the itzg image reads as a JVM memory size. */
export const MEMORY_SIZE_ENV_KEYS = [
  'MEMORY',
  'INIT_MEMORY',
  'MAX_MEMORY',
] as const;

/** `4096`, `512M`, `2g`, ` 1024m `. Not `75%`, not `-Xmx2G`, not junk. */
const SIZE_RE = /^\s*(\d+(?:\.\d+)?)\s*([kmgt]?)b?\s*$/i;
const UNIT_MB: Record<string, number> = {
  '': 1,
  k: 1 / 1024,
  m: 1,
  g: 1024,
  t: 1024 * 1024,
};

export interface HeapPlan {
  /** The maximum heap Java will be given, in MB (0 when unknown). */
  heapMb: number;
  /** The heap Java starts with, in MB — equal to `heapMb` unless overridden. */
  initMb: number;
  /** True when the starting heap is smaller than the maximum. */
  growsOnDemand: boolean;
  /** One sentence for the meters, or null when there's no heap to describe. */
  note: string | null;
}

@Injectable()
export class JvmMemoryService {
  /**
   * A JVM memory size in megabytes, or null when it cannot be read (empty, a
   * percentage, junk). A bare number is taken as MB — that is how the panel's
   * own size fields store values, and what a user typing "512" into an env
   * field means.
   */
  parseMemMb(raw: unknown): number | null {
    if (typeof raw !== 'string' && typeof raw !== 'number') return null;
    const m = SIZE_RE.exec(String(raw));
    if (!m) return null;
    const mb = Number(m[1]) * (UNIT_MB[m[2]!.toLowerCase()] ?? 1);
    return Number.isFinite(mb) && mb > 0 ? Math.round(mb) : null;
  }

  /**
   * Normalise one size value for the container env. A bare number gets its
   * `M` (Java reads a suffix-less `-Xms512` as 512 **bytes** and refuses to
   * start: "Too small initial heap"). An explicit unit, a percentage, or
   * anything unrecognised is passed through untouched — the image and the JVM
   * are better placed to reject it than we are to guess.
   */
  normalizeSize(raw: string): string {
    const trimmed = raw.trim();
    if (!/^\d+(?:\.\d+)?$/.test(trimmed)) return raw;
    const mb = Number(trimmed);
    if (!Number.isFinite(mb) || mb <= 0) return raw;
    return `${trimmed}M`;
  }

  /**
   * Repair every size-bearing key in a container env in place-safe fashion
   * (returns a new object). Also fixes values already stored from before this
   * normalisation existed.
   */
  normalizeSizeEnv(env: Record<string, string>): Record<string, string> {
    const out = { ...env };
    for (const key of MEMORY_SIZE_ENV_KEYS) {
      const value = out[key];
      if (typeof value === 'string' && value !== '')
        out[key] = this.normalizeSize(value);
    }
    return out;
  }

  /**
   * How the JVM will treat its heap, from a server's env plus the panel's
   * "Java heap" setting. The note keys on "starting heap equals maximum heap",
   * not on which flag preset is on — the presets make no measurable difference
   * to idle memory (SERVERS_NOTES.md).
   */
  heapPlan(
    env: Record<string, string> | null | undefined,
    heapMb: number | null | undefined,
  ): HeapPlan {
    const e = env || {};
    const maxMb = this.parseMemMb(e.MAX_MEMORY) || Number(heapMb) || 0;
    const initMb = this.parseMemMb(e.INIT_MEMORY) || maxMb;
    const growsOnDemand = initMb < maxMb;
    let note: string | null = null;
    if (maxMb > 0) {
      note = growsOnDemand
        ? `Java starts with ${initMb} MB and grows toward its ${maxMb} MB heap as the world needs it.`
        : `Java is given the whole ${maxMb} MB heap up front, so memory settles near that figure even with nobody playing. Set a smaller INIT_MEMORY to let it grow on demand instead.`;
    }
    return { heapMb: maxMb, initMb, growsOnDemand, note };
  }
}
