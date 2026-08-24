import { Injectable } from '@nestjs/common';
import { ConfigService } from '../config/config.service';
import { PathGuardService } from '../storage/path-guard.service';
import { DockerImagesService } from '../docker/docker-images.service';
import { ContainerService } from '../docker/container.service';
import { JavaMatrixService } from './java-matrix.service';
import { ServerQueryService } from './server-query.service';
import { ServerEnvironmentService } from './server-environment.service';
import type { ServerExtraPort, ServerExtraBind } from './types';

export interface PreviewCreateSpecInput {
  javaTag?: string;
  mcVersion?: string;
  type?: string;
  env?: Record<string, string>;
  heapMb?: number;
  containerName?: string | null;
  networkName?: string | null;
  containerMemoryMb?: number;
  containerSwapMb?: number;
  cpus?: number;
  portGame?: number;
  portRcon?: number;
  withBedrock?: boolean;
  portBedrock?: number;
  extraPorts?: ServerExtraPort[];
  extraBinds?: ServerExtraBind[];
}

export interface PreviewSpec {
  containerName: string | null;
  network: string | null;
  image: string;
  resources: { memoryMb: number; swapMb: number; cpus: number };
  ports: {
    game: number | string;
    rcon: number | string;
    bedrock: number | string | null;
    extra: ServerExtraPort[];
  };
  volumes: {
    data: string;
    extra: ServerExtraBind[];
  };
  env: Record<string, string>;
}

/**
 * Best-effort preview of the container params a create/existing server would
 * produce — feeds the wizard's "Advanced Docker Settings" YAML preview.
 * Thin per the plan's note ("if it's thin, fold it... or keep separate,
 * your call") — kept as its own service since it's a distinct read-only
 * concern (dry-run vs. mutating lifecycle ops) even though it's small.
 */
@Injectable()
export class ServerPreviewService {
  constructor(
    private readonly config: ConfigService,
    private readonly pathGuard: PathGuardService,
    private readonly images: DockerImagesService,
    private readonly containers: ContainerService,
    private readonly javaMatrix: JavaMatrixService,
    private readonly query: ServerQueryService,
    private readonly environment: ServerEnvironmentService,
  ) {}

  /**
   * Best-effort preview of the container params a `createServer(input)`
   * call would produce — no persistence, no port allocation (unassigned
   * ports show as a placeholder since the real ones aren't claimed until
   * creation).
   */
  previewCreateSpec(input: PreviewCreateSpecInput): PreviewSpec {
    const javaTag =
      input.javaTag ||
      this.javaMatrix.pickJavaTag(
        input.mcVersion || 'LATEST',
        input.type || 'VANILLA',
      );
    const image = this.images.imageRef(javaTag);
    const defaults = this.config.defaults;
    const env: Record<string, string> = { ...(input.env || {}) };
    env.EULA = 'TRUE';
    env.TYPE = input.type || 'VANILLA';
    if (input.mcVersion && input.mcVersion !== 'LATEST')
      env.VERSION = input.mcVersion;
    env.MEMORY = `${input.heapMb ?? defaults.heapMb}M`;
    env.ENABLE_RCON = 'true';
    env.RCON_PASSWORD = '(generated at creation)';
    return {
      containerName: input.containerName || null,
      network: input.networkName || null,
      image,
      resources: {
        memoryMb: input.containerMemoryMb ?? defaults.containerMemoryMb,
        swapMb: input.containerSwapMb ?? 0,
        cpus: input.cpus ?? defaults.cpus,
      },
      ports: {
        game: input.portGame || '(auto-assigned)',
        rcon:
          input.portRcon ||
          (input.portGame
            ? input.portGame + this.config.ports.rconOffset
            : '(auto-assigned)'),
        bedrock: input.withBedrock
          ? input.portBedrock || '(auto-assigned)'
          : null,
        extra: input.extraPorts || [],
      },
      volumes: {
        data: '<panel data dir>/servers/<server id> -> /data',
        extra: input.extraBinds || [],
      },
      env,
    };
  }

  /** Same shape as previewCreateSpec, but from a real, already-created server. */
  async previewServerSpec(id: string): Promise<PreviewSpec> {
    const server = await this.query.mustGet(id);
    const env = await this.environment.assembleEnv(server);
    env.RCON_PASSWORD = '(hidden)';
    if (env.CF_API_KEY) env.CF_API_KEY = '(hidden)';
    return {
      containerName:
        server.containerName || this.containers.containerName(server.id),
      network: server.networkName || null,
      image: await this.environment.resolveImage(server),
      resources: {
        memoryMb: server.container_memory_mb,
        swapMb: server.container_swap_mb,
        cpus: server.cpus,
      },
      ports: {
        game: server.port_game,
        rcon: server.port_rcon,
        bedrock: server.port_bedrock,
        extra: server.extraPorts,
      },
      volumes: {
        data: `${this.pathGuard.dataPath('servers', id)} -> /data`,
        extra: server.extraBinds,
      },
      env,
    };
  }
}
