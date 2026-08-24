import {
  ConflictException,
  HttpException,
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { EventsService } from '../events/events.service';
import { ServerQueryService } from '../servers/server-query.service';
import { ServerLifecycleService } from '../servers/server-lifecycle.service';
import { PacksService } from '../packs/packs.service';
import { BackupsService } from '../worlds/backups.service';
import { DockerLogsService } from '../docker/docker-logs.service';
import { ContainerService } from '../docker/container.service';

interface UpgradeState {
  step: string;
  startedAt: number;
}

export interface TaskHandle {
  step(label: string): void;
  progress(current: number, total?: number): void;
}

export interface UpgradePackOptions {
  versionId?: string | null;
  skipBackup?: boolean;
  allowVersionChange?: boolean;
  actor?: string;
  onStep?: (step: string) => void;
  task?: TaskHandle | null;
}

export interface UpgradePackResult {
  ok: true;
  from: string;
  to: string;
  backupId: string | null;
}

export interface RollbackResult {
  ok: true;
  version: string;
}

const STEP_LABELS: Record<string, string> = {
  resolving: 'Resolving target version',
  'backing-up': 'Creating pre-update backup',
  stopping: 'Stopping server',
  applying: 'Applying pack version',
  recreating: 'Recreating container',
  monitoring: 'Waiting for the server to come up',
  overlay: 'Restoring custom mod overlay',
};

/**
 * Controlled upgrade orchestrator: preview → pre-update backup → graceful
 * stop → re-pin → recreate → start → monitor → one-click rollback on
 * failure. Never automatic unless the server's update_policy is 'auto'.
 * Ports `src/updates/upgrade.ts`.
 */
@Injectable()
export class UpdateUpgradeService {
  private readonly activeUpgrades = new Map<string, UpgradeState>();

  constructor(
    private readonly events: EventsService,
    private readonly serverQuery: ServerQueryService,
    private readonly lifecycle: ServerLifecycleService,
    private readonly packs: PacksService,
    private readonly backups: BackupsService,
    private readonly dockerLogs: DockerLogsService,
    private readonly containers: ContainerService,
  ) {}

  upgradeStatus(serverId: string): UpgradeState | null {
    return this.activeUpgrades.get(serverId) || null;
  }

  /**
   * Run the full safe upgrade to a target pack version.
   * onStep(step) is invoked as the flow progresses.
   * opts.allowVersionChange must be true to cross MC versions (409 otherwise).
   * opts.task: optional task handle — step() calls are mirrored to it.
   */
  async upgradePack(
    serverId: string,
    {
      versionId = null,
      skipBackup = false,
      allowVersionChange = false,
      actor = 'system',
      onStep = () => {},
      task = null,
    }: UpgradePackOptions = {},
  ): Promise<UpgradePackResult> {
    if (this.activeUpgrades.has(serverId))
      throw new ConflictException(
        'An upgrade is already running for this server',
      );
    const server = await this.serverQuery.getServer(serverId);
    if (!server) throw new NotFoundException('Server not found');
    const pack = await this.packs.getPack(serverId);
    if (!pack)
      throw new BadRequestException('This server has no managed modpack');

    const step = (s: string) => {
      this.activeUpgrades.set(serverId, {
        step: s,
        startedAt: this.activeUpgrades.get(serverId)?.startedAt || Date.now(),
      });
      if (task) task.step(STEP_LABELS[s] || s);
      onStep(s);
    };

    try {
      step('resolving');
      // Thread the pin's own channel through: without this, an explicit
      // versionId-less upgrade on a beta-pinned GTNH server silently
      // resolves to the newest STABLE (pickLatest's default), while the UI
      // (latestFor) showed the newest BETA — a downgrade the user never
      // confirmed. includeBeta is a no-op for every other platform/branch,
      // which doesn't key off a stored channel.
      const resolved = await this.packs.resolvePack(
        pack.platform as 'curseforge' | 'modrinth' | 'ftb' | 'gtnh',
        pack.projectRef,
        {
          versionId,
          includeBeta: pack.channel === 'beta',
        },
      );
      if (resolved.versionId === pack.pinnedVersionId) {
        throw new BadRequestException(
          `Already on ${pack.pinnedVersionName} — nothing to upgrade`,
        );
      }

      // Cross-MC-version upgrades permanently convert the world — demand
      // explicit confirmation BEFORE any backup/stop work happens.
      if (
        resolved.mcVersion &&
        server.mc_version &&
        !['LATEST', 'SNAPSHOT'].includes(server.mc_version) &&
        resolved.mcVersion !== server.mc_version &&
        !allowVersionChange
      ) {
        throw new HttpException(
          {
            message:
              `${resolved.versionName} runs Minecraft ${resolved.mcVersion} but this server is on ${server.mc_version}. ` +
              'Upgrading will permanently convert the world to the new Minecraft version. Confirm the version change to proceed.',
            requiresVersionConfirm: true,
            fromMcVersion: server.mc_version,
            toMcVersion: resolved.mcVersion,
          },
          409,
        );
      }

      let backupId: string | null = null;
      if (!skipBackup) {
        step('backing-up');
        const backup = await this.backups.createBackup(serverId, {
          reason: 'pre-update',
          actor,
          note: `Before pack ${pack.pinnedVersionName} → ${resolved.versionName}`,
          task,
        });
        backupId = backup.id;
      }

      step('stopping');
      const wasRunning = ['running', 'starting', 'unhealthy'].includes(
        server.status,
      );
      if (wasRunning) await this.lifecycle.stopServer(serverId, { actor });

      step('applying');
      // The pre-update backup above is the safety net; still require the
      // caller to have confirmed cross-MC-version upgrades (checked before
      // backup by the route via resolvePack diff) — here we proceed.
      const { previous } = await this.packs.applyPack(serverId, resolved, {
        actor,
        force: true,
      });

      step('recreating');
      await this.lifecycle.recreateServer(serverId, { actor, quiet: true });
      await this.lifecycle.startServer(serverId, { actor });

      step('monitoring');
      // CF/Modrinth installs download the whole pack on first boot — give
      // them twice the window. GTNH downloads a ~1-2 GB server pack and then
      // builds a 1.7.10 world with several hundred mods, which routinely
      // outlasts both.
      const INSTALL_TIMEOUTS_MS: Record<string, number> = {
        gtnh: 30 * 60 * 1000,
        curseforge: 20 * 60 * 1000,
        modrinth: 20 * 60 * 1000,
      };
      const timeoutMs = INSTALL_TIMEOUTS_MS[pack.platform] || 10 * 60 * 1000;
      const healthy = await this.waitForHealthy(serverId, { timeoutMs });
      const excerpt = await this.dockerLogs
        .fetchLogs(serverId, { tail: 200 })
        .catch(() => '');

      if (!healthy) {
        this.events.recordEvent({
          serverId,
          actor,
          type: 'update-failed',
          summary: `Pack upgrade to ${resolved.versionName} failed to start — rollback available`,
          details: {
            backupId,
            previousVersion: previous ? previous.pinnedVersionId : null,
          },
          logExcerpt: excerpt || null,
        });
        throw new HttpException(
          {
            message: `The server did not come up healthy after the upgrade. Use rollback to restore ${pack.pinnedVersionName}.`,
            rollbackAvailable: Boolean(backupId),
          },
          502,
        );
      }

      step('overlay');
      await this.packs.afterPackOperation(serverId, { actor });

      this.events.recordEvent({
        serverId,
        actor,
        type: 'update-applied',
        summary: `Pack upgraded: ${pack.projectName} ${pack.pinnedVersionName} → ${resolved.versionName}`,
        details: {
          backupId,
          from: pack.pinnedVersionId,
          to: resolved.versionId,
        },
        logExcerpt: excerpt || null,
      });
      return {
        ok: true,
        from: pack.pinnedVersionName,
        to: resolved.versionName,
        backupId,
      };
    } finally {
      this.activeUpgrades.delete(serverId);
    }
  }

  /** Roll back: restore the pre-update backup + re-pin the previous version. */
  async rollbackPack(
    serverId: string,
    {
      backupId,
      actor = 'system',
    }: { backupId?: string | null; actor?: string } = {},
  ): Promise<RollbackResult> {
    const pack = await this.packs.getPack(serverId);
    if (!pack || !pack.previousVersionId)
      throw new BadRequestException('No previous pack version recorded');

    await this.lifecycle.stopServer(serverId, { actor }).catch(() => {});
    if (backupId)
      await this.backups.restoreBackup(serverId, backupId, {
        actor,
        skipSafety: true,
      });

    const resolved = await this.packs.resolvePack(
      pack.platform as 'curseforge' | 'modrinth' | 'ftb' | 'gtnh',
      pack.projectRef,
      {
        versionId: pack.previousVersionId,
      },
    );
    await this.packs.applyPack(serverId, resolved, { actor, force: true }); // backup restore precedes this
    await this.lifecycle.recreateServer(serverId, { actor, quiet: true });
    await this.lifecycle.startServer(serverId, { actor });

    this.events.recordEvent({
      serverId,
      actor,
      type: 'update-rolled-back',
      summary: `Rolled back to ${pack.previousVersionName}${backupId ? ' (backup restored)' : ''}`,
    });
    return { ok: true, version: pack.previousVersionName || '' };
  }

  /**
   * Wait until the server is genuinely up.
   * With a Docker healthcheck: 3 consecutive 'running' (healthy) checks (~15s).
   * WITHOUT one (health null), inspect says 'running' the instant the process
   * starts — require 6 consecutive checks (~30s) AND a 'Done (' line in
   * recent logs, or slow-booting packs get a false OK (and false failures on
   * rollback).
   */
  private async waitForHealthy(
    serverId: string,
    { timeoutMs = 10 * 60 * 1000 }: { timeoutMs?: number } = {},
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    let stableChecks = 0;
    while (Date.now() < deadline) {
      await this.sleep(5000);
      const info = await this.containers
        .inspectStatus(serverId)
        .catch(() => null);
      if (!info || !info.exists) return false;
      if (info.status === 'crashed') return false;
      if (info.status === 'running') {
        stableChecks += 1;
        const hasHealthcheck = info.health != null;
        if (hasHealthcheck && stableChecks >= 3) return true; // ~15s stable + healthy
        if (!hasHealthcheck && stableChecks >= 6) {
          const tail = await this.dockerLogs
            .fetchLogs(serverId, { tail: 100 })
            .catch(() => '');
          if (/Done \(/.test(tail)) return true;
          // keep polling: the process is alive but the MC server isn't done booting
        }
      } else {
        stableChecks = 0;
      }
    }
    return false;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms).unref());
  }
}
