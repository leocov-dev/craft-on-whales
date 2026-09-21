import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'node:fs';
import { PathGuardService } from '../storage/path-guard.service';
import { ServerQueryService } from './server-query.service';
import { ServerLifecycleService } from './server-lifecycle.service';
import { envVarForProperty } from './server-properties.map';

export interface SetPropertyOptions {
  actor?: string;
  /**
   * Skip the env unlock. For the two callers that deliberately keep a
   * property and its env var in step (`LEVEL` on an active-level switch,
   * `SEED`/`LEVEL_TYPE` on a world reset) — clearing the var there would
   * undo the very thing they just set.
   */
  unlockEnv?: boolean;
}

export interface SetPropertyResult {
  /** Env vars cleared so the on-disk value wins from the next start. */
  unlocked: string[];
}

/** How long to wait for Minecraft to finish rewriting server.properties. */
const REWRITE_SETTLE_MS = 2000;
const REWRITE_POLL_MS = 100;

/**
 * The single choke point for `server.properties`.
 *
 * Two problems live here, and both are about the file not being the source
 * of truth it looks like:
 *
 * 1. **The image re-applies env on every start.** itzg/minecraft-server
 *    writes every property it has an env var for each time the container
 *    boots, so a panel edit to PvP, difficulty, the whitelist or anything
 *    else env-backed was silently reverted on the next restart. Writing a
 *    property therefore also clears its env var and flags the container for
 *    recreate, handing the file authority over that key for good. Values
 *    chosen in the wizard still apply at creation — this only fires on a
 *    later edit.
 * 2. **Minecraft rewrites the file from its boot-time values.** Toggling the
 *    whitelist live makes the game rewrite the whole file from what it
 *    loaded at startup, wiping a PvP or difficulty edit made moments
 *    earlier. `preserveEdits()` wraps such a command and puts our own values
 *    back.
 */
@Injectable()
export class ServerPropertiesService {
  private readonly logger = new Logger(ServerPropertiesService.name);

  constructor(
    private readonly pathGuard: PathGuardService,
    private readonly query: ServerQueryService,
    private readonly lifecycle: ServerLifecycleService,
  ) {}

  private file(serverId: string): string {
    return this.pathGuard.dataPath('servers', serverId, 'server.properties');
  }

  /** Parse server.properties into a Map (empty when the file is missing). */
  read(serverId: string): Map<string, string> {
    const map = new Map<string, string>();
    let text: string;
    try {
      text = fs.readFileSync(this.file(serverId), 'utf8');
    } catch {
      return map; // fresh server — no file yet
    }
    for (const line of text.split(/\r?\n/)) {
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq > 0) map.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
    }
    return map;
  }

  /** One property's current value, or undefined when unset. */
  get(serverId: string, key: string): string | undefined {
    return this.read(serverId).get(key);
  }

  /**
   * Write one or more properties to disk, atomically, preserving comments,
   * ordering and any key we don't touch. Does not unlock env — callers go
   * through `setProperties()` for that.
   */
  write(serverId: string, patch: Record<string, string>): void {
    const dir = this.pathGuard.dataPath('servers', serverId);
    let text = '';
    try {
      text = fs.readFileSync(this.file(serverId), 'utf8');
    } catch {
      /* fresh server — create the file */
    }
    for (const [key, value] of Object.entries(patch)) {
      const re = new RegExp(
        `^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=.*$`,
        'm',
      );
      if (re.test(text)) text = text.replace(re, `${key}=${value}`);
      else
        text += `${text && !text.endsWith('\n') ? '\n' : ''}${key}=${value}\n`;
    }
    const tmp = this.pathGuard.dataPath(
      'servers',
      serverId,
      'server.properties.tmp',
    );
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, this.file(serverId));
  }

  /** Write one property and hand the file authority over it. */
  async setProperty(
    serverId: string,
    key: string,
    value: string,
    options: SetPropertyOptions = {},
  ): Promise<SetPropertyResult> {
    return this.setProperties(serverId, { [key]: value }, options);
  }

  /**
   * Write properties and clear the env vars backing them, so the image stops
   * overwriting those keys on every start. One `updateServer` call covers the
   * whole patch, which also flags `pending_recreate` exactly once.
   */
  async setProperties(
    serverId: string,
    patch: Record<string, string>,
    { actor = 'system', unlockEnv = true }: SetPropertyOptions = {},
  ): Promise<SetPropertyResult> {
    this.write(serverId, patch);
    if (!unlockEnv) return { unlocked: [] };
    return {
      unlocked: await this.unlockEnv(serverId, Object.keys(patch), { actor }),
    };
  }

  /**
   * Clear the env vars backing `keys` so the on-disk values win. Safe to call
   * with keys that have no env var, or whose var isn't set — it only touches
   * the server row when something actually changes.
   */
  async unlockEnv(
    serverId: string,
    keys: string[],
    { actor = 'system' }: { actor?: string } = {},
  ): Promise<string[]> {
    const server = await this.query.getServer(serverId);
    if (!server) return [];
    const env = { ...server.env };
    const unlocked: string[] = [];
    for (const key of keys) {
      const envVar = envVarForProperty(key);
      if (!envVar || env[envVar] === undefined) continue;
      delete env[envVar];
      unlocked.push(envVar);
    }
    if (!unlocked.length) return [];
    await this.lifecycle.updateServer(serverId, { env }, { actor });
    this.logger.log(
      `${serverId}: server.properties now owns ${unlocked.join(', ')} (env cleared, recreate pending)`,
    );
    return unlocked;
  }

  /**
   * Run something that makes Minecraft rewrite server.properties from its
   * boot-time values (the live whitelist toggle is the one we hit), then put
   * our own edits back. Keys in `except` are left as the game wrote them —
   * that's the value the command was supposed to change.
   */
  async preserveEdits<T>(
    serverId: string,
    except: string[],
    run: () => Promise<T>,
  ): Promise<T> {
    const before = this.read(serverId);
    const mtimeBefore = this.mtime(serverId);
    const result = await run();
    if (!before.size) return result; // nothing of ours to lose

    await this.waitForRewrite(serverId, mtimeBefore);
    const after = this.read(serverId);
    const skip = new Set(except);
    const restore: Record<string, string> = {};
    for (const [key, value] of before) {
      if (skip.has(key)) continue;
      if (after.get(key) !== value) restore[key] = value;
    }
    if (Object.keys(restore).length) {
      this.write(serverId, restore);
      this.logger.log(
        `${serverId}: restored ${Object.keys(restore).join(', ')} after the game rewrote server.properties`,
      );
    }
    return result;
  }

  private mtime(serverId: string): number {
    try {
      return fs.statSync(this.file(serverId)).mtimeMs;
    } catch {
      return 0;
    }
  }

  /** Poll for the game's rewrite; give up quietly if it never comes. */
  private async waitForRewrite(serverId: string, since: number): Promise<void> {
    const deadline = Date.now() + REWRITE_SETTLE_MS;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, REWRITE_POLL_MS));
      if (this.mtime(serverId) !== since) return;
    }
  }
}
