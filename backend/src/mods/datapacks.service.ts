import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { and, eq, inArray } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { serverContent } from '../db/schema';
import { EventsService } from '../events/events.service';
import { LibraryService } from '../library/library.service';
import { DatapackIconService } from './datapack-icon.service';
import { resolveActiveLevel } from '../servers/active-level';
import { ServerPropertiesService } from '../servers/server-properties.service';
import { ServerQueryService } from '../servers/server-query.service';
import type { Server } from '../servers/types';
import { pickZipEntries } from '../items/item-zip-parser';
import { PathGuardService } from '../storage/path-guard.service';
import type { ContentItem } from '../../../shared/types/mods';

const MCMETA = 'pack.mcmeta';
/** A pack.mcmeta bigger than this is not metadata; skip it rather than read it. */
const MAX_MCMETA_BYTES = 1024 * 1024;
/** Directory datapacks are summed for size; a tree this large stops counting. */
const MAX_SIZE_WALK_ENTRIES = 50_000;
const LEGACY_SUFFIX = '.disabled';

/** `readdir` that treats a missing dir as empty; any other error (EACCES, ENOTDIR...) surfaces. */
async function readdirIfExists(dir: string) {
  try {
    return await fsp.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

export interface PackMeta {
  description: string | null;
  packFormat: number | null;
}

/** One datapack found on disk, before it is joined with its DB row. */
export interface DiskPack {
  /** Name as stored on disk. */
  diskName: string;
  /** Absolute path of the entry as stored on disk. */
  abs: string;
  /** Name without the legacy `.disabled` file suffix: what the API and DB call it. */
  file: string;
  enabled: boolean;
  isDirectory: boolean;
  size: number;
  meta: PackMeta;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** `pack.description` is a string or a JSON text component; keep the plain text. */
function descriptionText(v: unknown): string | null {
  if (typeof v === 'string') return v.trim() || null;
  if (isRecord(v)) return descriptionText(v.text);
  if (Array.isArray(v)) {
    const parts = (v as unknown[]).map(descriptionText).filter(Boolean);
    return parts.length ? parts.join('') : null;
  }
  return null;
}

/** Parse pack.mcmeta text (BOM tolerated). Never throws: bad metadata is just absent. */
export function parsePackMeta(text: string): PackMeta {
  try {
    const json: unknown = JSON.parse(
      text.charCodeAt(0) === 0xfeff ? text.slice(1) : text,
    );
    const pack = isRecord(json) && isRecord(json.pack) ? json.pack : {};
    return {
      description: descriptionText(pack.description),
      packFormat:
        typeof pack.pack_format === 'number' ? pack.pack_format : null,
    };
  } catch {
    return { description: null, packFormat: null };
  }
}

const NO_META: PackMeta = { description: null, packFormat: null };

/**
 * Datapacks of a server's ACTIVE world. A datapack lives in
 * `<level>/datapacks`; a disabled one is moved to the sibling
 * `<level>/datapacks.disabled` (see MODS_NOTES.md, "Datapacks"). Nothing here
 * touches mods/plugins, which stay in ModsService.
 */
@Injectable()
export class DatapacksService {
  constructor(
    private readonly dbService: DbService,
    private readonly pathGuard: PathGuardService,
    private readonly properties: ServerPropertiesService,
    private readonly query: ServerQueryService,
    private readonly library: LibraryService,
    private readonly events: EventsService,
    private readonly icons: DatapackIconService,
  ) {}

  private get db() {
    return this.dbService.db;
  }

  /** A bare name: no separator, NUL or dot segment. Level names and pack names come from user-editable input. */
  private assertBareName(
    name: string | null | undefined,
    what: string,
  ): string {
    const value = String(name || '');
    if (!value || value === '.' || value === '..' || /[\\/\0]/.test(value)) {
      throw new BadRequestException(`Invalid ${what}`);
    }
    return value;
  }

  /** Active level name: LEVEL env, then server.properties `level-name`, then `world`. */
  activeLevelName(server: Pick<Server, 'id' | 'env'>): string {
    const level = resolveActiveLevel(server.env, (key) =>
      this.properties.get(server.id, key),
    );
    return this.assertBareName(level, 'level name');
  }

  /** Server-relative dir holding the active world's enabled datapacks. */
  activeDirRel(server: Pick<Server, 'id' | 'env'>): string {
    return `${this.activeLevelName(server)}/datapacks`;
  }

  /** Server-relative dir holding the active world's disabled datapacks (a sibling, never inside `datapacks/`). */
  disabledDirRel(server: Pick<Server, 'id' | 'env'>): string {
    return `${this.activeLevelName(server)}/datapacks.disabled`;
  }

  private abs(serverId: string, dirRel: string, ...rest: string[]): string {
    return this.pathGuard.dataPath('servers', serverId, dirRel, ...rest);
  }

  /** Total bytes of a directory's regular files; symlinks are never followed or counted. */
  private async dirSize(dir: string): Promise<number> {
    let total = 0;
    let seen = 0;
    const stack = [dir];
    while (stack.length && seen < MAX_SIZE_WALK_ENTRIES) {
      const cur = stack.pop()!;
      const entries = await readdirIfExists(cur);
      for (const e of entries) {
        seen += 1;
        const full = path.join(cur, e.name);
        if (e.isDirectory()) stack.push(full);
        else if (e.isFile())
          total += (await fsp.lstat(full).catch(() => null))?.size ?? 0;
      }
    }
    return total;
  }

  private async readMeta(abs: string, isDirectory: boolean): Promise<PackMeta> {
    try {
      if (isDirectory) {
        const mcmeta = path.join(abs, MCMETA);
        const st = await fsp.lstat(mcmeta);
        if (!st.isFile() || st.size > MAX_MCMETA_BYTES) return NO_META;
        return parsePackMeta(await fsp.readFile(mcmeta, 'utf8'));
      }
      const found = await pickZipEntries(
        abs,
        (name) => name === MCMETA,
        (f) => f.size > 0,
      );
      const buf = found.get(MCMETA);
      return buf ? parsePackMeta(buf.toString('utf8')) : NO_META;
    } catch {
      return NO_META;
    }
  }

  private async hasMcmeta(dir: string): Promise<boolean> {
    return (
      (await fsp.lstat(path.join(dir, MCMETA)).catch(() => null))?.isFile() ??
      false
    );
  }

  /** Datapacks in one dir. Zips, and directories that hold a pack.mcmeta; symlinks are skipped. */
  private async scan(dirAbs: string, enabled: boolean): Promise<DiskPack[]> {
    const entries = await readdirIfExists(dirAbs);
    const out: DiskPack[] = [];
    for (const entry of entries) {
      const abs = path.join(dirAbs, entry.name);
      if (entry.isDirectory()) {
        // A pre-existing `x.disabled` directory keeps its pack.mcmeta, so
        // Minecraft still loads it: it counts as enabled under its real name.
        if (!(await this.hasMcmeta(abs))) continue;
        out.push({
          diskName: entry.name,
          abs,
          file: entry.name,
          enabled,
          isDirectory: true,
          size: await this.dirSize(abs),
          meta: await this.readMeta(abs, true),
        });
      } else if (entry.isFile()) {
        // Legacy toggle renamed `x.zip` to `x.zip.disabled` in place.
        const legacy = enabled && entry.name.endsWith(`.zip${LEGACY_SUFFIX}`);
        const file = legacy
          ? entry.name.slice(0, -LEGACY_SUFFIX.length)
          : entry.name;
        if (!file.endsWith('.zip')) continue;
        out.push({
          diskName: entry.name,
          abs,
          file,
          enabled: enabled && !legacy,
          isDirectory: false,
          size: (await fsp.lstat(abs).catch(() => null))?.size ?? 0,
          meta: await this.readMeta(abs, false),
        });
      }
    }
    return out;
  }

  /** Datapacks on disk in the active world, enabled dir first. Symlinks never appear. */
  async diskPacks(server: Server): Promise<DiskPack[]> {
    return [
      ...(await this.scan(
        this.abs(server.id, this.activeDirRel(server)),
        true,
      )),
      ...(await this.scan(
        this.abs(server.id, this.disabledDirRel(server)),
        false,
      )),
    ];
  }

  /** Display name for a pack that has no DB row (or whose row has no better name). */
  prettify(file: string): string {
    return (
      file
        .replace(/\.zip$/, '')
        .replace(/[-_]+/g, ' ')
        .trim() || file
    );
  }

  /** Installed datapacks of the active world: enabled and disabled, joined with their DB rows. */
  async listDatapacks(serverId: string): Promise<ContentItem[]> {
    const server = await this.query.getServer(serverId);
    if (!server) throw new NotFoundException('Server not found');
    const packs = await this.diskPacks(server);
    const rows = (
      await this.db
        .select()
        .from(serverContent)
        .where(
          and(
            eq(serverContent.serverId, serverId),
            eq(serverContent.kind, 'datapack'),
          ),
        )
    ).map((r) => ({ ...r, base: r.filename.replace(/\.disabled$/, '') }));
    const byFile = new Map(rows.map((r) => [r.base, r]));
    const libs = await Promise.all(
      packs.map(async (pack) => {
        const libraryId = byFile.get(pack.file)?.libraryId;
        const lib = libraryId
          ? await this.library.getLibraryFile(libraryId)
          : undefined;
        return {
          lib,
          sharedWith: lib ? await this.library.usageCount(lib.id) : null,
        };
      }),
    );
    const seen = new Set<string>();
    const items: ContentItem[] = [];
    packs.forEach((pack, i) => {
      seen.add(pack.file);
      const row = byFile.get(pack.file);
      const { lib, sharedWith } = libs[i]!;
      items.push({
        id: row ? row.id : null,
        name: row ? row.name : this.prettify(pack.file),
        file: pack.file,
        kind: 'datapack',
        source: row ? row.managedBy : 'unknown',
        version: row ? row.version : null,
        size: pack.size,
        enabled: pack.enabled,
        sharedWith,
        iconUrl:
          (lib && lib.iconRelPath
            ? `/api/icons/library/${path.basename(lib.iconRelPath)}`
            : (lib && lib.iconUrl) || this.rowIcon(row)) || null,
        description: pack.meta.description,
        packFormat: pack.meta.packFormat,
        isDirectory: pack.isDirectory,
      });
    });
    // Rows whose pack vanished from disk (deleted by hand, or the active world changed).
    for (const row of rows) {
      if (seen.has(row.base)) continue;
      items.push({
        id: row.id,
        name: row.name,
        file: row.base,
        kind: 'datapack',
        source: row.managedBy,
        version: row.version,
        size: 0,
        enabled: false,
        missing: true,
        sharedWith: null,
        iconUrl: this.rowIcon(row),
      });
    }
    return items.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** A row's own icon: the extracted `pack.png`, else its registry icon URL. */
  private rowIcon(
    row: { iconRelPath: string | null; iconUrl: string | null } | undefined,
  ): string | null {
    if (!row) return null;
    return row.iconRelPath
      ? `/api/icons/library/${path.basename(row.iconRelPath)}`
      : row.iconUrl;
  }

  /** Every on-disk spot the pack occupies (it can be in both dirs). Entries that are neither a file nor a directory (symlinks) don't count. */
  private async locateAll(
    server: Server,
    file: string,
  ): Promise<{ abs: string; enabled: boolean; legacy: boolean }[]> {
    const candidates = [
      {
        dir: this.activeDirRel(server),
        name: file,
        enabled: true,
        legacy: false,
      },
      {
        dir: this.activeDirRel(server),
        name: `${file}${LEGACY_SUFFIX}`,
        enabled: false,
        legacy: true,
      },
      {
        dir: this.disabledDirRel(server),
        name: file,
        enabled: false,
        legacy: false,
      },
    ];
    const found: { abs: string; enabled: boolean; legacy: boolean }[] = [];
    for (const c of candidates) {
      // A legacy suffix only ever applied to zip files; a `.disabled` directory is its own pack.
      if (c.legacy && !file.endsWith('.zip')) continue;
      const abs = this.abs(server.id, c.dir, c.name);
      const st = await fsp.lstat(abs).catch(() => null);
      if (st && (st.isFile() || st.isDirectory()))
        found.push({ abs, enabled: c.enabled, legacy: c.legacy });
    }
    return found;
  }

  /** Row filter for a pack: its name, or the legacy `.disabled` form a row may carry. */
  private rowFilter(serverId: string, file: string) {
    return and(
      eq(serverContent.serverId, serverId),
      eq(serverContent.kind, 'datapack'),
      inArray(serverContent.filename, [file, `${file}${LEGACY_SUFFIX}`]),
    );
  }

  /**
   * Move without ever replacing the destination. Returns false when something
   * already sits there. Files use a hard link, whose EEXIST is atomic, then drop
   * the source; if linking is unsupported (EXDEV, EPERM...) it falls back to
   * check-then-rename. Directories cannot be hard-linked, so they only get the
   * check-then-rename (a residual race, see MODS_NOTES.md, "Datapacks").
   */
  private async moveNoClobber(src: string, dest: string): Promise<boolean> {
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    if ((await fsp.lstat(src)).isFile()) {
      try {
        await fsp.link(src, dest);
        await fsp.unlink(src);
        return true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
        // Not linkable here: fall through to the check + rename below.
      }
    }
    if (await fsp.lstat(dest).catch(() => null)) return false;
    await fsp.rename(src, dest);
    return true;
  }

  /**
   * Drop a disabled copy of a pack that an install is about to replace: the one
   * in `datapacks.disabled/` and a legacy `x.zip.disabled`. The enabled copy is
   * the installer's to overwrite.
   */
  async clearDisabledCopy(server: Server, file: string): Promise<void> {
    this.assertBareName(file, 'datapack filename');
    for (const found of await this.locateAll(server, file))
      if (!found.enabled)
        await fsp.rm(found.abs, { recursive: true, force: true });
  }

  /**
   * Enable or disable a datapack by moving it between `datapacks/` and
   * `datapacks.disabled/`. Never overwrites: a same-named pack already at the
   * destination is a 409. A running server picks the change up on `/reload` or
   * restart, so this always reports `on-restart`.
   */
  async setEnabled(
    serverId: string,
    file: string,
    enabled: boolean,
    { actor = 'system' }: { actor?: string } = {},
  ): Promise<{ applied: 'on-restart' }> {
    this.assertBareName(file, 'datapack filename');
    const server = await this.query.getServer(serverId);
    if (!server) throw new NotFoundException('Server not found');
    const [found] = await this.locateAll(server, file);
    if (!found) throw new NotFoundException('Datapack not found');

    // A legacy `.zip.disabled` is already inert but still sits in datapacks/: disabling it migrates it.
    if (found.enabled !== enabled || (found.legacy && !enabled)) {
      const destDirRel = enabled
        ? this.activeDirRel(server)
        : this.disabledDirRel(server);
      const dest = this.abs(serverId, destDirRel, file);
      if (!(await this.moveNoClobber(found.abs, dest)))
        throw new ConflictException(
          `A datapack named ${file} already exists in the ${enabled ? 'enabled' : 'disabled'} list`,
        );
    }
    await this.db
      .update(serverContent)
      .set({ enabled })
      .where(this.rowFilter(serverId, file));
    this.events.recordEvent({
      serverId,
      actor,
      type: enabled ? 'mod-enabled' : 'mod-disabled',
      summary: `Datapack ${file} ${enabled ? 'enabled' : 'disabled'} (applies on /reload or restart)`,
    });
    return { applied: 'on-restart' };
  }

  /** Delete a datapack (file or directory tree) and its row, from every dir that holds a copy. */
  async removeDatapack(
    serverId: string,
    file: string,
    { actor = 'system' }: { actor?: string } = {},
  ): Promise<{ freedBytes: number }> {
    this.assertBareName(file, 'datapack filename');
    const server = await this.query.getServer(serverId);
    if (!server) throw new NotFoundException('Server not found');
    const found = await this.locateAll(server, file);
    let freed = 0;
    for (const spot of found) {
      const st = await fsp.lstat(spot.abs);
      freed += st.isDirectory() ? await this.dirSize(spot.abs) : st.size;
      // rm unlinks symlinks inside a tree instead of following them.
      await fsp.rm(spot.abs, { recursive: true, force: true });
    }
    const removed = await this.db
      .delete(serverContent)
      .where(this.rowFilter(serverId, file))
      .returning({
        id: serverContent.id,
        iconRelPath: serverContent.iconRelPath,
      });
    for (const r of removed) await this.icons.remove(r.iconRelPath);
    if (found.length === 0 && removed.length === 0)
      throw new NotFoundException('Datapack not found');
    this.events.recordEvent({
      serverId,
      actor,
      type: 'mod-removed',
      summary: `Removed datapack ${file} (${(freed / 1024 / 1024).toFixed(1)} MB freed)`,
    });
    return { freedBytes: freed };
  }
}
