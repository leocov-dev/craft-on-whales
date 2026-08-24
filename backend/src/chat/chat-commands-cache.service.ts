import { Injectable } from '@nestjs/common';
import type { HydratedCommand } from './chat.types';

const CACHE_MS = 60_000;

export interface RuntimeEntry {
  at: number;
  prefix: string;
  byTrigger: Map<string, HydratedCommand>;
}

/**
 * Shared in-memory runtime cache, split out so `ChatCommandsService`
 * (persistence/CRUD) and `ChatCommandsRuntimeService` (chat dispatcher) don't
 * need a reference to each other just to keep it coherent: persistence calls
 * `invalidate()` after every write, the runtime service calls `get()`/`set()`
 * on the hot chat-message path to rebuild it (60s TTL) from persistence's
 * `listCommands`/`getPrefix` on a miss. This mirrors exactly the single
 * `cache` map the two concerns used to share directly on one class.
 */
@Injectable()
export class ChatCommandsCacheService {
  private readonly cache = new Map<string, RuntimeEntry>();

  get(serverId: string): RuntimeEntry | undefined {
    const hit = this.cache.get(serverId);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit;
    return undefined;
  }

  set(serverId: string, entry: RuntimeEntry): void {
    this.cache.set(serverId, entry);
  }

  invalidate(serverId: string): void {
    this.cache.delete(serverId);
  }
}
