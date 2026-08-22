'use strict';

// Host Docker network discovery — lets a server attach to an existing network
// (e.g. one shared with a reverse proxy like Pangolin or NGINX) instead of
// the default bridge.

const { getDocker } = require('./connect') as typeof import('./connect');

// Pseudo-networks that aren't valid attach targets for a container's
// NetworkingConfig the way a real bridge/overlay network is.
const HIDDEN_NETWORKS = new Set(['none', 'host']);

// Panel-owned network for the mc-router integration — mc-router and any
// routed server containers share it so mc-router can proxy traffic to them.
const ROUTER_NETWORK_NAME = 'msm-router-net';

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

/** Create the panel-owned network if it doesn't exist yet. Idempotent. */
async function ensureNetwork(name: string = ROUTER_NETWORK_NAME): Promise<string> {
  if (await networkExists(name)) return name;
  await getDocker().createNetwork({ Name: name, Driver: 'bridge', Labels: { 'msm.managed': 'true' } });
  return name;
}

export { listNetworks, networkExists, ensureNetwork, ROUTER_NETWORK_NAME };
