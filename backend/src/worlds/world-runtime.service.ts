import { Injectable } from '@nestjs/common';
import { ContainerService } from '../docker/container.service';
import { WorldArchiveService } from './world-archive.service';
import { WorldSaveLockService } from './world-save-lock.service';

/**
 * Shared "is the server running, and if so pause its saves around a disk
 * copy" primitive used by every world workflow that touches a live server's
 * world files (extract, install, duplicate, download-prep).
 */
@Injectable()
export class WorldRuntimeService {
  constructor(
    private readonly containers: ContainerService,
    private readonly archive: WorldArchiveService,
    private readonly saveLock: WorldSaveLockService,
  ) {}

  async isRunning(serverId: string): Promise<boolean> {
    const info = await this.containers
      .inspectStatus(serverId)
      .catch(() => ({ exists: false, status: 'stopped' as const }));
    return (
      info.exists && ['running', 'starting', 'unhealthy'].includes(info.status)
    );
  }

  // Run the save-off/flush -> copy -> save-on dance under the shared
  // per-server save lock when running; when stopped, just run the copy directly.
  async withPausedSaves<T>(
    serverId: string,
    running: boolean,
    copy: () => Promise<T>,
  ): Promise<T> {
    if (!running) return copy();
    return this.saveLock.withSaveLock(serverId, async () => {
      await this.containers
        .execCapture(serverId, ['rcon-cli', 'save-off'])
        .catch(() => {});
      await this.containers
        .execCapture(serverId, ['rcon-cli', 'save-all', 'flush'])
        .catch(() => {});
      await this.archive.sleep(2000);
      try {
        return await copy();
      } finally {
        await this.containers
          .execCapture(serverId, ['rcon-cli', 'save-on'])
          .catch(() => {});
      }
    });
  }
}
