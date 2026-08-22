'use strict';

// Host Docker network discovery — lets a server attach to an existing network
// (e.g. one shared with a reverse proxy like Pangolin or NGINX) instead of
// the default bridge.

const { getDocker } = require('./connect') as typeof import('./connect');

// Pseudo-networks that aren't valid attach targets for a container's
// NetworkingConfig the way a real bridge/overlay network is.
const HIDDEN_NETWORKS = new Set(['none', 'host']);

interface NetworkSummary {
  id: string;
  name: string;
  driver?: string;
  scope?: string;
}

async function listNetworks(): Promise<NetworkSummary[]> {
  const nets = await getDocker().listNetworks();
  return nets
    .filter((n) => !HIDDEN_NETWORKS.has(n.Name))
    .map((n) => ({ id: n.Id, name: n.Name, driver: n.Driver, scope: n.Scope }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function networkExists(name?: string | null): Promise<boolean> {
  if (!name) return false;
  const nets = await listNetworks();
  return nets.some((n) => n.name === name);
}

export = { listNetworks, networkExists };
