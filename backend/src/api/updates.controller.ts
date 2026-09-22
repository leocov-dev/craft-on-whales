import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { eq } from 'drizzle-orm';
import { serverContent } from '../db/schema';
import { UpdateCheckerService } from '../updates/update-checker.service';
import { ServerQueryService } from '../servers/server-query.service';
import { TasksService } from '../tasks/tasks.service';
import type { OutdatedRow } from '../../../shared/types/updates';
import type { OutdatedRow as CheckerOutdatedRow } from '../updates/updates.types';
import { currentUser } from '../auth/current-user';
import { ServerPermissionGuard } from '../permissions/server-permission.guard';
import { RequireServerPermission } from '../permissions/require-server-permission.decorator';
import type { ServerIdResolver } from '../permissions/require-server-permission.decorator';

const SUBJECT_TYPES = new Set(['pack', 'content']);

/** Server id behind an `updates/:subjectType/:subjectId` ignore route. */
const updateSubjectServerId: ServerIdResolver = async (req, { db }) => {
  const subjectType = req.params?.subjectType;
  const subjectId = req.params?.subjectId;
  if (
    typeof subjectId !== 'string' ||
    typeof subjectType !== 'string' ||
    !SUBJECT_TYPES.has(subjectType)
  )
    return null;
  if (subjectType === 'pack') return subjectId;
  const [row] = await db.db
    .select({ serverId: serverContent.serverId })
    .from(serverContent)
    .where(eq(serverContent.id, subjectId))
    .limit(1);
  return row ? row.serverId : null;
};

function normalizeOutdated(rows: CheckerOutdatedRow[]) {
  return rows.map(({ changelogUrl, ...u }) => ({
    ...u,
    changelog: /^https?:\/\//i.test(changelogUrl || '') ? changelogUrl : null,
  }));
}

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
    ignored: OutdatedRow[];
    lastChecked: string | null;
  }> {
    const [outdated, ignored] = await Promise.all([
      this.checker.listOutdated(),
      this.checker.listIgnored(),
    ]);
    return {
      ok: true,
      updates: normalizeOutdated(outdated),
      ignored: normalizeOutdated(ignored),
      lastChecked: (await this.checker.lastCheckedAt()) || null,
    };
  }

  /** Dismiss the currently-known latest build/version for one subject. */
  @Post('updates/:subjectType/:subjectId/ignore')
  @UseGuards(ServerPermissionGuard)
  @RequireServerPermission('content', updateSubjectServerId)
  async ignore(
    @Req() req: Request,
    @Param('subjectType') subjectType: string,
    @Param('subjectId') subjectId: string,
  ) {
    if (subjectType !== 'pack' && subjectType !== 'content')
      throw new BadRequestException('Invalid subject type');
    const result = await this.checker.ignoreUpdate(subjectType, subjectId, {
      actor: currentUser(req).username,
    });
    return { ok: true, ...result };
  }

  /** Clear a previously-ignored build so it counts as available again. */
  @Delete('updates/:subjectType/:subjectId/ignore')
  @UseGuards(ServerPermissionGuard)
  @RequireServerPermission('content', updateSubjectServerId)
  async unignore(
    @Req() req: Request,
    @Param('subjectType') subjectType: string,
    @Param('subjectId') subjectId: string,
  ) {
    if (subjectType !== 'pack' && subjectType !== 'content')
      throw new BadRequestException('Invalid subject type');
    await this.checker.clearIgnoredUpdate(subjectType, subjectId, {
      actor: currentUser(req).username,
    });
    return { ok: true };
  }

  @Post('updates/check')
  @HttpCode(202)
  check(@Req() req: Request) {
    const actor = currentUser(req).username;
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
  @UseGuards(ServerPermissionGuard)
  @RequireServerPermission('content')
  async checkForServer(@Req() req: Request, @Param('id') id: string) {
    const server = await this.serverQuery.mustGet(id);
    const actor = currentUser(req).username;
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
