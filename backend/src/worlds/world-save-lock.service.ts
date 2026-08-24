import { Injectable } from '@nestjs/common';

/**
 * Shared per-server "world saves paused" lock. Any operation that runs the
 * save-off → copy → save-on dance on a running server (backups, world
 * export, world duplicate, world download) must hold this lock so two of
 * them can't overlap — otherwise one operation's save-on re-enables world
 * writes while the other is still copying region files, producing a
 * silently torn archive.
 *
 * Distinct from `ServerLocksService` (backend/src/servers/server-locks.service.ts),
 * which guards start/stop/restart/recreate lifecycle ops — a different
 * concern. Ports `src/services/serverLocks.ts` + `src/utils/keyedMutex.ts`.
 */
@Injectable()
export class WorldSaveLockService {
  private readonly tails = new Map<string, Promise<void>>();

  withSaveLock<T>(serverId: string, fn: () => T | Promise<T>): Promise<T> {
    const key = `save:${serverId}`;
    const prev = this.tails.get(key) || Promise.resolve();
    const result = prev.then(
      () => fn(),
      () => fn(),
    );
    const tail = result.then(
      () => {},
      () => {},
    );
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }
}
