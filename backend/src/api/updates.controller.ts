import { Controller, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { UpdateCheckerService } from '../updates/update-checker.service';
import { ServerQueryService } from '../servers/server-query.service';
import { TasksService } from '../tasks/tasks.service';
import type { OutdatedRow } from '../../../shared/types/updates';

/** Ports the "Updates" section of legacy `src/web/routes/api.ts`. */
@Controller('api')
export class UpdatesController {
  constructor(
    private readonly checker: UpdateCheckerService,
    private readonly serverQuery: ServerQueryService,
    private readonly tasks: TasksService,
  ) {}

  @Get('updates')
  async list(): Promise<{
    ok: true;
    updates: OutdatedRow[];
    lastChecked: string | null;
  }> {
    const outdated = await this.checker.listOutdated();
    return {
      ok: true,
      updates: outdated.map(({ changelogUrl, ...u }) => ({
        ...u,
        changelog: /^https?:\/\//i.test(changelogUrl || '')
          ? changelogUrl
          : null,
      })),
      lastChecked: (await this.checker.lastCheckedAt()) || null,
    };
  }

  @Post('updates/check')
  @HttpCode(202)
  check(@Req() req: Request) {
    const actor = req.user!.username;
    const taskId = this.tasks.run(
      'Checking for updates',
      { actor },
      async (t) => {
        t.step('Querying CurseForge, Modrinth and the registry');
        const findings = await this.checker.checkAll({ actor });
        return { findings };
      },
    );
    return { ok: true, taskId };
  }

  @Post('servers/:id/updates/check')
  @HttpCode(202)
  async checkForServer(@Req() req: Request, @Param('id') id: string) {
    const server = await this.serverQuery.mustGet(id);
    const actor = req.user!.username;
    const taskId = this.tasks.run(
      `Checking updates for ${server.display_name}`,
      { serverId: server.id, actor },
      async (t) => {
        t.step('Querying update sources');
        const findings = await this.checker.checkAll({ actor });
        return {
          findings: findings.filter((f) => f.server === server.display_name),
        };
      },
    );
    return { ok: true, taskId };
  }
}
