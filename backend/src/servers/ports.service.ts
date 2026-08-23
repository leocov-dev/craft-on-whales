import { Injectable } from '@nestjs/common';
import * as net from 'node:net';
import { and, eq, isNull } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { servers, integrations } from '../db/schema';
import { ConfigService } from '../config/config.service';
import type { SuggestedPorts } from '../../../shared/types/wizard';

export type { SuggestedPorts };

export interface SuggestPortsOptions {
  withBedrock?: boolean;
}

// Host-port allocation. Scheme (user-approved): game ports first-free from
// 25565, RCON = game + 1000, Bedrock UDP first-free from 19132. A port is
// "taken" if any DB server claims it OR the OS reports it in use.
@Injectable()
export class PortsService {
  constructor(
    private readonly dbService: DbService,
    private readonly config: ConfigService
  ) {}

  private probe(port: number, host: string = '0.0.0.0'): Promise<boolean> {
    return new Promise((resolve) => {
      const srv = net.createServer();
      srv.unref();
      srv.once('error', () => resolve(false));
      srv.listen({ port, host, exclusive: true }, () => {
        srv.close(() => resolve(true));
      });
    });
  }

  private dbPortsInUse(): Set<number> {
    const rows = this.dbService.db
      .select({
        portGame: servers.portGame,
        portRcon: servers.portRcon,
        portBedrock: servers.portBedrock,
        extraPortsJson: servers.extraPortsJson,
      })
      .from(servers)
      .where(isNull(servers.deletedAt))
      .all();
    const used = new Set<number>();
    for (const r of rows) {
      used.add(r.portGame);
      used.add(r.portRcon);
      if (r.portBedrock) used.add(r.portBedrock);
      for (const p of JSON.parse(r.extraPortsJson || '[]') as { hostPort?: number }[]) {
        if (p && p.hostPort) used.add(p.hostPort);
      }
    }
    // BlueMap's web-server port lives in `integrations`, not on the server
    // row — it must be unioned in too, or a fresh port allocation could
    // collide with it.
    const integrationRows = this.dbService.db
      .select({ configJson: integrations.configJson })
      .from(integrations)
      .where(and(eq(integrations.kind, 'bluemap'), eq(integrations.enabled, true)))
      .all();
    for (const row of integrationRows) {
      const hostPort = (JSON.parse(row.configJson || '{}') as { hostPort?: number }).hostPort;
      if (hostPort) used.add(hostPort);
    }
    used.add(this.config.port); // never hand out the panel's own port
    return used;
  }

  /**
   * True when `port` is a valid, unclaimed, currently-bindable port. `port`
   * is checked at runtime rather than typed as `number` — callers (including
   * controllers parsing user input) may pass anything.
   */
  async isPortFree(port: unknown): Promise<boolean> {
    // undefined/null/NaN/'25565xyz' must NOT pass as free — that silently
    // skipped RCON collision validation for explicit game ports.
    if (!Number.isInteger(port)) return false;
    const p = port as number;
    if (p < 1024 || p > 65535) return false;
    if (this.dbPortsInUse().has(p)) return false;
    return this.probe(p);
  }

  /** Suggest a { game, rcon } pair (and bedrock when requested). */
  async suggestPorts({ withBedrock = false }: SuggestPortsOptions = {}): Promise<SuggestedPorts> {
    const used = this.dbPortsInUse();
    let game = this.config.ports.gameStart;
    for (;;) {
      const rcon = game + this.config.ports.rconOffset;
      if (!used.has(game) && !used.has(rcon) && (await this.probe(game)) && (await this.probe(rcon))) break;
      game += 1;
      if (game > 65000) throw new Error('No free game ports available');
    }
    const result: SuggestedPorts = { game, rcon: game + this.config.ports.rconOffset, bedrock: null };
    if (withBedrock) {
      let b = this.config.ports.bedrockStart;
      while (used.has(b) || !(await this.probe(b))) {
        b += 1;
        if (b > 65000) throw new Error('No free Bedrock ports available');
      }
      result.bedrock = b;
    }
    return result;
  }
}
