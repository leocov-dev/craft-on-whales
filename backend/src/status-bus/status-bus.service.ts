import { EventEmitter } from 'node:events';
import { Injectable } from '@nestjs/common';

export interface ServerStatusChangedEvent {
  serverId: string;
  status: string;
}

export interface ContainerReplacedEvent {
  serverId: string;
}

/**
 * In-process pub/sub for server status transitions, decoupling
 * ServerLifecycleService (backend/src/servers/) from the WS gateways
 * (backend/src/ws/) that push them to browser clients. A plain EventEmitter
 * rather than a module-to-module dependency: ServersModule and WsModule
 * already have a one-way edge (WsModule -> ServersModule), so injecting a
 * gateway into ServerLifecycleService would require a fresh forwardRef() on
 * both sides. Both modules instead just import StatusBusModule.
 */
@Injectable()
export class StatusBusService extends EventEmitter {
  constructor() {
    super();
    // One listener per open WS connection, on a single process-wide emitter —
    // Node's default cap of 10 would print a MaxListenersExceededWarning at
    // the 11th concurrent server-detail page, which is not a leak here.
    this.setMaxListeners(0);
  }

  emitStatusChanged(event: ServerStatusChangedEvent): void {
    this.emit('status-changed', event);
  }

  onStatusChanged(listener: (event: ServerStatusChangedEvent) => void): void {
    this.on('status-changed', listener);
  }

  offStatusChanged(listener: (event: ServerStatusChangedEvent) => void): void {
    this.off('status-changed', listener);
  }

  /**
   * A server's container was removed and recreated, so anything holding a
   * handle on the old one (the console gateway's log follower) is now stale.
   * Separate from a status change: a plain stop/start reuses the container,
   * and a recreate is not itself a status transition.
   */
  emitContainerReplaced(event: ContainerReplacedEvent): void {
    this.emit('container-replaced', event);
  }

  onContainerReplaced(listener: (event: ContainerReplacedEvent) => void): void {
    this.on('container-replaced', listener);
  }

  offContainerReplaced(
    listener: (event: ContainerReplacedEvent) => void,
  ): void {
    this.off('container-replaced', listener);
  }
}
