import { Injectable } from '@nestjs/common';
import { ContainerService } from '../docker/container.service';
import { rcon } from '../utils/rcon';
import { mergeTps, parseTps, type TpsSample } from '../utils/rcon-tps';

/** Fresh reading reused by every viewer within this window. */
const CACHE_MS = 5_000;
/** A server that answered "unknown command" is re-probed rarely, so the console isn't spammed. */
const NEGATIVE_CACHE_MS = 5 * 60_000;
const RCON_TIMEOUT_MS = 5_000;

/** Commands that report tick rate, tried in order until one parses. */
const TPS_COMMANDS: string[][] = [['tps'], ['spark', 'tps'], ['forge', 'tps']];

interface Entry {
  at: number;
  sample: TpsSample | null;
  /** Server answered but has no TPS command; false when RCON was unreachable. */
  answered: boolean;
  /** The command that worked last time; skips the probe ladder next poll. */
  command: string[] | null;
}

/**
 * RCON-based TPS/MSPT probe. Vanilla exposes neither, so `null` is a normal
 * answer ("not available on this server"), not an error. Results are cached
 * per server and concurrent callers share one in-flight probe, so N open
 * browser tabs cost one RCON round-trip per interval, not N.
 */
@Injectable()
export class TpsService {
  private readonly cache = new Map<string, Entry>();
  private readonly inflight = new Map<string, Promise<TpsSample | null>>();

  constructor(private readonly containers: ContainerService) {}

  probe(serverId: string): Promise<TpsSample | null> {
    const hit = this.cache.get(serverId);
    if (hit) {
      const ttl = !hit.sample && hit.answered ? NEGATIVE_CACHE_MS : CACHE_MS;
      if (Date.now() - hit.at < ttl) return Promise.resolve(hit.sample);
    }
    const pending = this.inflight.get(serverId);
    if (pending) return pending;
    const run = this.run(serverId, hit?.command ?? null).finally(() =>
      this.inflight.delete(serverId),
    );
    this.inflight.set(serverId, run);
    return run;
  }

  /** Drop cached state, e.g. when the container restarts and may differ. */
  forget(serverId: string): void {
    this.cache.delete(serverId);
  }

  private async run(
    serverId: string,
    known: string[] | null,
  ): Promise<TpsSample | null> {
    const ladder = known ? [known] : TPS_COMMANDS;
    let sample: TpsSample | null = null;
    let command: string[] | null = null;
    let answered = false;
    for (const args of ladder) {
      const out = await this.exec(serverId, args);
      if (out) answered = true;
      sample = parseTps(out);
      if (sample) {
        command = args;
        break;
      }
    }
    // Paper's `tps` has no MSPT; its separate `mspt` command does.
    if (sample && sample.mspt === null && sample.source === 'paper') {
      sample = mergeTps(sample, parseTps(await this.exec(serverId, ['mspt'])));
    }
    this.cache.set(serverId, { at: Date.now(), sample, answered, command });
    return sample;
  }

  private async exec(serverId: string, args: string[]): Promise<string> {
    try {
      return await rcon(this.containers, serverId, args, {
        timeoutMs: RCON_TIMEOUT_MS,
      });
    } catch {
      return '';
    }
  }
}
