import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { serverContent } from '../db/schema';
import { EventsService } from '../events/events.service';
import { LibraryService } from '../library/library.service';
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

interface PackMeta {
  description: string | null;
  packFormat: number | null;
}

/** One datapack found on disk, before it is joined with its DB row. */
interface DiskPack {
  /** Name as stored on disk. */
  diskName: string;
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
    const level =
      server.env?.LEVEL ||
      this.properties.get(server.id, 'level-name') ||
      'world';
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
      const entries = await fsp
        .readdir(cur, { withFileTypes: true })
        .catch(() => []);
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
    const entries = await fsp
      .readdir(dirAbs, { withFileTypes: true })
      .catch(() => []);
    const out: DiskPack[] = [];
    for (const entry of entries) {
      const abs = path.join(dirAbs, entry.name);
      if (entry.isDirectory()) {
        // A pre-existing `x.disabled` directory keeps its pack.mcmeta, so
        // Minecraft still loads it: it counts as enabled under its real name.
        if (!(await this.hasMcmeta(abs))) continue;
        out.push({
          diskName: entry.name,
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

  /** Installed datapacks of the active world: enabled and disabled, joined with their DB rows. */
  async listDatapacks(serverId: string): Promise<ContentItem[]> {
    const server = await this.query.getServer(serverId);
    if (!server) throw new NotFoundException('Server not found');
    const packs = [
      ...(await this.scan(this.abs(serverId, this.activeDirRel(server)), true)),
      ...(await this.scan(
        this.abs(serverId, this.disabledDirRel(server)),
        false,
      )),
    ];
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
    const seen = new Set<string>();
    const items: ContentItem[] = [];
    for (const pack of packs) {
      seen.add(pack.file);
      const row = byFile.get(pack.file);
      const lib = row?.libraryId
        ? await this.library.getLibraryFile(row.libraryId)
        : undefined;
      items.push({
        id: row ? row.id : null,
        name: row ? row.name : this.prettify(pack.file),
        file: pack.file,
        kind: 'datapack',
        source: row ? row.managedBy : 'unknown',
        version: row ? row.version : null,
        size: pack.size,
        enabled: pack.enabled,
        sharedWith: lib ? await this.library.usageCount(lib.id) : null,
        iconUrl:
          (lib && lib.iconRelPath
            ? `/api/icons/library/${path.basename(lib.iconRelPath)}`
            : (lib && lib.iconUrl) || (row && row.iconUrl)) || null,
        description: pack.meta.description,
        packFormat: pack.meta.packFormat,
        isDirectory: pack.isDirectory,
      });
    }
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
        iconUrl: row.iconUrl,
      });
    }
    return items.sort((a, b) => a.name.localeCompare(b.name));
  }

  private prettify(file: string): string {
    return (
      file
        .replace(/\.zip$/, '')
        .replace(/[-_]+/g, ' ')
        .trim() || file
    );
  }

  /** The pack's current on-disk spot, or null. Entries that are neither a file nor a directory (symlinks) don't count. */
  private async locate(
    server: Server,
    file: string,
  ): Promise<{ abs: string; enabled: boolean; legacy: boolean } | null> {
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
    for (const c of candidates) {
      // A legacy suffix only ever applied to zip files; a `.disabled` directory is its own pack.
      if (c.legacy && !file.endsWith('.zip')) continue;
      const abs = this.abs(server.id, c.dir, c.name);
      const st = await fsp.lstat(abs).catch(() => null);
      if (st && (st.isFile() || st.isDirectory()))
        return { abs, enabled: c.enabled, legacy: c.legacy };
    }
    return null;
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
    const found = await this.locate(server, file);
    if (!found) throw new NotFoundException('Datapack not found');

    // A legacy `.zip.disabled` is already inert but still sits in datapacks/: disabling it migrates it.
    if (found.enabled !== enabled || (found.legacy && !enabled)) {
      const destDirRel = enabled
        ? this.activeDirRel(server)
        : this.disabledDirRel(server);
      const dest = this.abs(serverId, destDirRel, file);
      if (await fsp.lstat(dest).catch(() => null))
        throw new ConflictException(
          `A datapack named ${file} already exists in the ${enabled ? 'enabled' : 'disabled'} list`,
        );
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.rename(found.abs, dest);
    }
    await this.db
      .update(serverContent)
      .set({ enabled })
      .where(
        and(
          eq(serverContent.serverId, serverId),
          eq(serverContent.kind, 'datapack'),
          eq(serverContent.filename, file),
        ),
      );
    this.events.recordEvent({
      serverId,
      actor,
      type: enabled ? 'mod-enabled' : 'mod-disabled',
      summary: `Datapack ${file} ${enabled ? 'enabled' : 'disabled'} (applies on /reload or restart)`,
    });
    return { applied: 'on-restart' };
  }

  /** Delete a datapack (file or directory tree) and its row, from whichever dir holds it. */
  async removeDatapack(
    serverId: string,
    file: string,
    { actor = 'system' }: { actor?: string } = {},
  ): Promise<{ freedBytes: number }> {
    this.assertBareName(file, 'datapack filename');
    const server = await this.query.getServer(serverId);
    if (!server) throw new NotFoundException('Server not found');
    const found = await this.locate(server, file);
    let freed = 0;
    if (found) {
      const st = await fsp.lstat(found.abs);
      freed = st.isDirectory() ? await this.dirSize(found.abs) : st.size;
      // rm unlinks symlinks inside a tree instead of following them.
      await fsp.rm(found.abs, { recursive: true, force: true });
    }
    const removed = await this.db
      .delete(serverContent)
      .where(
        and(
          eq(serverContent.serverId, serverId),
          eq(serverContent.kind, 'datapack'),
          eq(serverContent.filename, file),
        ),
      )
      .returning({ id: serverContent.id });
    if (!found && removed.length === 0)
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
