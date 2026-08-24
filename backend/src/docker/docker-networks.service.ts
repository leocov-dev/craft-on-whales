import { Injectable } from '@nestjs/common';
import { DockerConnectionService } from './docker-connection.service';

export const ROUTER_NETWORK_NAME = 'msm-router-net';

// Pseudo-networks that aren't valid attach targets for a container's
// NetworkingConfig the way a real bridge/overlay network is.
const HIDDEN_NETWORKS = new Set(['none', 'host']);

export interface NetworkSummary {
  id: string;
  name: string;
  driver?: string;
  scope?: string;
}

/**
 * Host Docker network discovery — lets a server attach to an existing
 * network (e.g. one shared with a reverse proxy like Pangolin or NGINX)
 * instead of the default bridge.
 */
@Injectable()
export class DockerNetworksService {
  constructor(private readonly connection: DockerConnectionService) {}

  async listNetworks(): Promise<NetworkSummary[]> {
    const nets = await this.connection.getDocker().listNetworks();
    return nets
      .filter((n) => !HIDDEN_NETWORKS.has(n.Name))
      .map((n) => ({
        id: n.Id,
        name: n.Name,
        driver: n.Driver,
        scope: n.Scope,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async networkExists(name?: string | null): Promise<boolean> {
    if (!name) return false;
    const nets = await this.listNetworks();
    return nets.some((n) => n.name === name);
  }

  /** Create the panel-owned network if it doesn't exist yet. Idempotent. */
  async ensureNetwork(name: string = ROUTER_NETWORK_NAME): Promise<string> {
    if (await this.networkExists(name)) return name;
    await this.connection.getDocker().createNetwork({
      Name: name,
      Driver: 'bridge',
      Labels: { 'msm.managed': 'true' },
    });
    return name;
  }
}
