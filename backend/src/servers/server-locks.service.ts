import { ConflictException, Injectable } from '@nestjs/common';

export type LifecycleOp = 'start' | 'stop' | 'restart' | 'recreate';

interface InFlightEntry {
  op: LifecycleOp;
  promise: Promise<unknown>;
}

/**
 * Concurrency guards for server lifecycle operations, extracted from
 * ServerLifecycleService per the plan's explicit `ServerLocksService` naming.
 *
 * Two independent primitives, both ported verbatim from legacy servers.ts:
 * - `runSerializedCreate`: creates are serialized through one chain so two
 *   concurrent creates can't both probe the same free port before either has
 *   inserted its row (port-allocation TOCTOU → duplicate host ports → one
 *   un-startable server). Creates are rare, so running them one-at-a-time is
 *   cheap insurance.
 * - `guard`: a per-server lifecycle mutex — concurrent start calls share one
 *   promise; any other overlapping lifecycle op is rejected with 409 instead
 *   of racing into container-name collisions and half-recreated states.
 */
@Injectable()
export class ServerLocksService {
  private createChain: Promise<unknown> = Promise.resolve();
  private readonly inFlightOps = new Map<string, InFlightEntry>(); // serverId -> { op, promise }

  runSerializedCreate<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.createChain.then(fn, fn);
    this.createChain = result.then(
      () => {},
      () => {}
    ); // a failed create must not break the chain
    return result;
  }

  async guard<T>(id: string, op: LifecycleOp, fn: (id: string) => Promise<T>): Promise<T> {
    const existing = this.inFlightOps.get(id);
    if (existing) {
      if (existing.op === op && op === 'start') return existing.promise as Promise<T>; // piggyback on the same start
      throw new ConflictException(`Cannot ${op}: a ${existing.op} operation is already in progress for this server`);
    }
    const promise = fn(id);
    const entry: InFlightEntry = { op, promise };
    this.inFlightOps.set(id, entry);
    try {
      return await promise;
    } finally {
      if (this.inFlightOps.get(id) === entry) this.inFlightOps.delete(id);
    }
  }
}
