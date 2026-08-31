import { All, Controller, Param, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import * as http from 'node:http';
import * as net from 'node:net';
import { ConfigService } from '../config/config.service';
import { DockerConnectionService } from '../docker/docker-connection.service';
import { ContainerService } from '../docker/container.service';
import { ServerQueryService } from '../servers/server-query.service';
import { MapService, BLUEMAP_CONTAINER_PORT } from './map.service';
import type { Server } from '../servers/types';

const CONTAINER_PORT = parseInt(BLUEMAP_CONTAINER_PORT, 10); // '8100/tcp' -> 8100
const CACHE_TTL_MS = 5 * 60 * 1000;
const PROBE_TIMEOUT_MS = 1500;

interface Target {
  host: string;
  port: number | null;
}

/**
 * Authenticated reverse proxy for BlueMap's web UI. Ports
 * `src/web/routes/mapProxy.ts` verbatim — the map port is never exposed to
 * the browser directly, everything flows through this session-gated
 * `/map/:id/...` path. Plain stdlib `http`, GET/HEAD only.
 */
@Controller('map')
export class MapProxyController {
  // serverId -> { target: {host, port}, expiresAt }
  private readonly targetCache = new Map<
    string,
    { target: Target; expiresAt: number }
  >();

  constructor(
    private readonly config: ConfigService,
    private readonly dockerConnection: DockerConnectionService,
    private readonly containers: ContainerService,
    private readonly serverQuery: ServerQueryService,
    private readonly map: MapService,
  ) {}

  private async containerNetworkTargets(server: Server): Promise<Target[]> {
    const name =
      server.containerName || this.containers.containerName(server.id);
    try {
      const info = await this.dockerConnection
        .getDocker()
        .getContainer(name)
        .inspect();
      const nets = info.NetworkSettings?.Networks || {};
      return Object.values(nets)
        .map((n) => n.IPAddress)
        .filter((ip): ip is string => Boolean(ip))
        .map((ip) => ({ host: ip, port: CONTAINER_PORT }));
    } catch {
      return []; // container gone/uninspectable — fall through to the host-port candidate
    }
  }

  private probeConnect(
    target: Target,
    timeoutMs: number = PROBE_TIMEOUT_MS,
  ): Promise<boolean> {
    const port = target.port;
    if (port === null) return Promise.resolve(false);
    return new Promise((resolve) => {
      const socket = net.connect({ host: target.host, port });
      const timer = setTimeout(() => {
        socket.destroy();
        resolve(false);
      }, timeoutMs);
      socket.once('connect', () => {
        clearTimeout(timer);
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => {
        clearTimeout(timer);
        resolve(false);
      });
    });
  }

  private async resolveTarget(
    server: Server,
    cfg: { enabled: boolean; hostPort: number | null },
  ): Promise<Target> {
    const cached = this.targetCache.get(server.id);
    if (cached && cached.expiresAt > Date.now()) return cached.target;

    const candidates: Target[] = [
      ...(await this.containerNetworkTargets(server)),
      { host: this.config.mapProxyHost, port: cfg.hostPort },
    ];
    for (const target of candidates) {
      if (await this.probeConnect(target)) {
        this.targetCache.set(server.id, {
          target,
          expiresAt: Date.now() + CACHE_TTL_MS,
        });
        return target;
      }
    }
    // Nothing answered — return the last (host-port) candidate uncached so
    // the very next request re-probes everything instead of being stuck.
    return candidates[candidates.length - 1] as Target;
  }

  // path-to-regexp 8's optional-group syntax: matches both the bare
  // `/map/:id` page load and every `/map/:id/...` asset/tile request with
  // one route (stacking two @All() decorators here silently drops one —
  // confirmed live, only the last-registered survived).
  @All(':id{/*path}')
  async proxy(
    @Param('id') id: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.status(405).send('Method not allowed');
      return;
    }
    const server = await this.serverQuery.getServer(id);
    const cfg = server
      ? await this.map.getMapConfig(server.id)
      : { enabled: false, hostPort: null };
    if (!server || !cfg.enabled || !cfg.hostPort) {
      res.status(404).send('Live map is not enabled for this server');
      return;
    }

    const target = await this.resolveTarget(server, cfg);

    // Never forward the panel session cookie (or an Authorization header) to
    // the proxied target — it's just BlueMap's static web UI and doesn't
    // need it, and the target may be reachable by other containers on a
    // shared Docker network.

    /* eslint-disable @typescript-eslint/no-unused-vars */
    const {
      cookie: _cookie,
      authorization: _authorization,
      ...forwardHeaders
    } = req.headers;
    /* eslint-enable @typescript-eslint/no-unused-vars */

    const prefix = `/map/${id}`;
    const upstreamPath =
      (req.url.startsWith(prefix) ? req.url.slice(prefix.length) : req.url) ||
      '/';
    const upstream = http.request(
      {
        host: target.host,
        port: target.port ?? undefined,
        path: upstreamPath,
        method: req.method,
        headers: { ...forwardHeaders, host: `${target.host}:${target.port}` },
        timeout: 20000,
      },
      (up: http.IncomingMessage) => {
        res.status(up.statusCode || 502);
        for (const [k, v] of Object.entries(up.headers)) {
          if (
            v !== undefined &&
            !['transfer-encoding', 'connection'].includes(k.toLowerCase())
          )
            res.setHeader(k, v);
        }
        up.pipe(res);
      },
    );
    upstream.on('timeout', () => upstream.destroy(new Error('timeout')));
    upstream.on('error', (err: NodeJS.ErrnoException) => {
      this.targetCache.delete(server.id); // stale — the next request re-probes every candidate
      if (res.headersSent) {
        res.end();
        return;
      }
      if (err.code === 'ENOTFOUND') {
        res
          .status(502)
          .send(
            `Cannot resolve map-proxy host "${target.host}" — if the panel runs in its own container, ` +
              'add `extra_hosts: ["host.docker.internal:host-gateway"]` to its compose service, or set MAP_PROXY_HOST explicitly.',
          );
        return;
      }
      res
        .status(502)
        .send(
          'The map server is not responding — is the Minecraft server running? BlueMap needs a minute after startup to come up.',
        );
    });
    req.pipe(upstream);
  }
}
