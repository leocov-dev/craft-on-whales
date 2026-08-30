import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { PathGuardService } from '../storage/path-guard.service';
import {
  PlayerDataFileService,
  iterateItems,
} from './player-data-file.service';
import { assertUuid, UUID_RE } from './nbt-codec';
import type { PlayerInventoryData } from '../../../shared/types/inventory';

// Same reasoning as inventory.service.ts / player-data-file.service.ts: this
// file touches untyped on-disk JSON snapshot blobs.
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */

const SNAPSHOT_FILE_RE =
  /^logs\/([A-Za-z0-9_-]{1,40})\/inventories\/([0-9a-f-]{36})\/(\d{10,16})-([a-z0-9_-]{1,32})\.json$/;

export interface SnapshotMeta {
  file: string;
  ts: number;
  reason: string;
}

export interface SnapshotMetaWithSize extends SnapshotMeta {
  size: number;
}

export interface LoadedSnapshot extends SnapshotMeta {
  uuid: string;
  data: PlayerInventoryData;
}

interface TallyEntry {
  id: string;
  displayName: string | null;
  count: number;
}

export interface SnapshotDiff {
  a: SnapshotMeta;
  b: SnapshotMeta;
  added: TallyEntry[];
  removed: TallyEntry[];
  changed: {
    id: string;
    displayName: string | null;
    from: number;
    to: number;
  }[];
}

/**
 * Point-in-time JSON inventory snapshots: write/list/load/prune, plus
 * diffing two snapshots. Extracted from InventoryService (see
 * `.plan/reviews/05-inventory-blueprints-items.md`, "InventoryService is a
 * God class").
 *
 * SNAPSHOT STORAGE: snapshots are stored as small JSON files under
 * data/logs/<serverId>/inventories/<uuid>/<ts>-<reason>.json instead of DB
 * rows — point-in-time blobs that are never queried relationally, pruned
 * like every other log artifact, and every path resolves through
 * PathGuardService so nothing escapes the data root.
 */
@Injectable()
export class InventorySnapshotService {
  constructor(
    private readonly pathGuard: PathGuardService,
    private readonly playerDataFiles: PlayerDataFileService,
  ) {}

  private snapshotDir(serverId: string, uuid: string): string {
    return this.pathGuard.dataPath(
      'logs',
      serverId,
      'inventories',
      assertUuid(uuid),
    );
  }

  private cleanReason(reason: string | null | undefined): string {
    const r = String(reason || 'manual')
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .slice(0, 32);
    return r || 'manual';
  }

  /** Write the current readPlayerData result to a timestamped snapshot file. */
  async snapshot(
    serverId: string,
    uuid: string,
    reason: string = 'manual',
  ): Promise<SnapshotMeta> {
    const data = await this.playerDataFiles.readPlayerData(serverId, uuid);
    const dir = this.snapshotDir(serverId, uuid);
    await fsp.mkdir(dir, { recursive: true });
    const cleanedReason = this.cleanReason(reason);
    let ts = Date.now();
    let name = `${ts}-${cleanedReason}.json`;
    for (;;) {
      try {
        // `wx` fails atomically if the file already exists, closing the
        // existsSync-then-write TOCTOU window a concurrent snapshot() call
        // for the same player could otherwise race through.
        await fsp.writeFile(
          path.join(dir, name),
          JSON.stringify(
            { ts, reason: cleanedReason, serverId, data },
            null,
            2,
          ),
          { flag: 'wx' },
        );
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        ts += 1; // same-ms collision
        name = `${ts}-${cleanedReason}.json`;
      }
    }
    return {
      file: path.posix.join('logs', serverId, 'inventories', data.uuid, name),
      ts,
      reason: this.cleanReason(reason),
    };
  }

  /** Snapshots for one player, newest first (metadata parsed from filenames). */
  async listSnapshots(
    serverId: string,
    uuidInput: string,
  ): Promise<SnapshotMetaWithSize[]> {
    const uuid = assertUuid(uuidInput);
    const dir = this.snapshotDir(serverId, uuid);
    let entries: fs.Dirent[] = [];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const snapshots: SnapshotMetaWithSize[] = [];
    for (const e of entries) {
      const m = /^(\d{10,16})-([a-z0-9_-]{1,32})\.json$/.exec(
        e.isFile() ? e.name : '',
      );
      if (!m) continue;
      let size = 0;
      try {
        size = (await fsp.stat(path.join(dir, e.name))).size;
      } catch {
        /* racing prune */
      }
      snapshots.push({
        file: path.posix.join('logs', serverId, 'inventories', uuid, e.name),
        ts: Number(m[1]),
        reason: m[2]!,
        size,
      });
    }
    snapshots.sort((a, b) => b.ts - a.ts);
    return snapshots;
  }

  /** Load one snapshot by its rel path (strict shape check + path guard). */
  getSnapshot(relFile: string): LoadedSnapshot {
    const m = SNAPSHOT_FILE_RE.exec(String(relFile || ''));
    if (!m) throw new BadRequestException('Invalid snapshot file reference');
    let raw: string;
    try {
      raw = fs.readFileSync(this.pathGuard.dataPath(relFile), 'utf8'); // dataPath re-guards containment
    } catch {
      throw new NotFoundException(
        'Snapshot not found — it may have been pruned',
      );
    }
    try {
      const parsed = JSON.parse(raw);
      return {
        file: relFile,
        ts: Number(m[3]),
        reason: m[4]!,
        uuid: m[2]!,
        data: parsed.data || parsed,
      };
    } catch {
      throw new BadRequestException('Snapshot file is corrupt');
    }
  }

  /** Aggregate item counts across all sections, keyed by id + display name. */
  private tallyItems(data: PlayerInventoryData): Map<string, TallyEntry> {
    const tally = new Map<string, TallyEntry>();
    for (const [, item] of iterateItems(data)) {
      const key = `${item.id} ${item.displayName || ''}`;
      const cur = tally.get(key);
      if (cur) cur.count += item.count;
      else
        tally.set(key, {
          id: item.id,
          displayName: item.displayName || null,
          count: item.count,
        });
    }
    return tally;
  }

  /**
   * Diff two snapshots (rel paths). Items are keyed by id + displayName so a
   * renamed item counts as its own line.
   */
  diffSnapshots(aFile: string, bFile: string): SnapshotDiff {
    const a = this.getSnapshot(aFile);
    const b = this.getSnapshot(bFile);
    const before = this.tallyItems(a.data);
    const after = this.tallyItems(b.data);

    const added: TallyEntry[] = [];
    const removed: TallyEntry[] = [];
    const changed: SnapshotDiff['changed'] = [];
    for (const [key, item] of after) {
      const prev = before.get(key);
      if (!prev) added.push(item);
      else if (prev.count !== item.count) {
        changed.push({
          id: item.id,
          displayName: item.displayName,
          from: prev.count,
          to: item.count,
        });
      }
    }
    for (const [key, item] of before) {
      if (!after.has(key)) removed.push(item);
    }
    const meta = (s: LoadedSnapshot): SnapshotMeta => ({
      file: s.file,
      ts: s.ts,
      reason: s.reason,
    });
    return { a: meta(a), b: meta(b), added, removed, changed };
  }

  /** Keep only the newest `keepPerPlayer` snapshots for every player of a server. */
  async pruneSnapshots(
    serverId: string,
    keepPerPlayer: number = 50,
  ): Promise<{ pruned: number }> {
    const base = this.pathGuard.dataPath('logs', serverId, 'inventories');
    let uuids: string[] = [];
    try {
      uuids = (await fsp.readdir(base, { withFileTypes: true }))
        .filter((e) => e.isDirectory() && UUID_RE.test(e.name))
        .map((e) => e.name);
    } catch {
      return { pruned: 0 };
    }
    let pruned = 0;
    for (const uuid of uuids) {
      const snapshots = await this.listSnapshots(serverId, uuid);
      for (const snap of snapshots.slice(keepPerPlayer)) {
        try {
          await fsp.rm(this.pathGuard.dataPath(snap.file), { force: true });
          pruned += 1;
        } catch {
          /* already gone */
        }
      }
    }
    return { pruned };
  }
}
