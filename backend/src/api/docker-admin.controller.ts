import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { ServerQueryService } from '../servers/server-query.service';
import { ServerPreviewService } from '../servers/server-preview.service';
import { DockerSpecService } from '../servers/docker-spec.service';
import { DockerConnectionService } from '../docker/docker-connection.service';
import { DockerNetworksService } from '../docker/docker-networks.service';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { dockerOverridesSchema } from './docker-overrides.schema';
import { parseBody } from './servers.controller';

const previewSchema = z.object({
  type: z.string().trim().max(32).optional(),
  mcVersion: z.string().trim().max(32).optional(),
  javaTag: z.string().max(16).optional(),
  env: z.record(z.string(), z.string()).optional(),
  heapMb: z.coerce.number().int().min(512).max(262144).optional(),
  containerMemoryMb: z.coerce.number().int().min(1024).max(524288).optional(),
  containerSwapMb: z.coerce.number().int().min(0).optional(),
  cpus: z.coerce.number().min(0).max(128).optional(),
  portGame: z.coerce.number().int().min(1024).max(65535).optional(),
  portRcon: z.coerce.number().int().min(1024).max(65535).optional(),
  portBedrock: z.coerce.number().int().min(1024).max(65535).optional(),
  withBedrock: z.coerce.boolean().optional(),
  ...dockerOverridesSchema,
});

/**
 * Docker network/preview/docker-spec admin routes, split out of
 * `ServersController` (see `.plan/reviews/02-api-servers.md` finding #7).
 * `dockerStatus` is intentionally not admin-gated — it mirrors the original
 * file, where it carried no `@Roles` guard.
 */
@Controller('api')
export class DockerAdminController {
  constructor(
    private readonly query: ServerQueryService,
    private readonly preview: ServerPreviewService,
    private readonly dockerSpec: DockerSpecService,
    private readonly dockerConnection: DockerConnectionService,
    private readonly dockerNetworks: DockerNetworksService,
  ) {}

  @Get('docker/status')
  async dockerStatus() {
    return { ok: true, docker: await this.dockerConnection.checkDocker() };
  }

  @Get('docker/networks')
  @UseGuards(RolesGuard)
  @Roles('admin')
  async networks() {
    return { ok: true, networks: await this.dockerNetworks.listNetworks() };
  }

  @Post('docker/preview')
  @UseGuards(RolesGuard)
  @Roles('admin')
  dockerPreview(@Body() body: unknown) {
    const input = parseBody(previewSchema, body);
    return {
      ok: true,
      yaml: this.dockerSpec.toYaml(this.preview.previewCreateSpec(input)),
    };
  }

  @Post('docker/preview/parse')
  @UseGuards(RolesGuard)
  @Roles('admin')
  dockerPreviewParse(@Body() body: unknown) {
    const { yaml: text } = parseBody(
      z.object({ yaml: z.string().max(20000) }),
      body,
    );
    return { ok: true, spec: this.dockerSpec.fromYaml(text) };
  }

  @Get('servers/:id/docker-spec')
  @UseGuards(RolesGuard)
  @Roles('admin')
  async serverDockerSpec(@Param('id') id: string) {
    await this.query.mustGet(id);
    return {
      ok: true,
      yaml: this.dockerSpec.toYaml(await this.preview.previewServerSpec(id)),
    };
  }
}
