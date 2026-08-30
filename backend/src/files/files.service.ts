import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { ConfigService } from '../config/config.service';
import { EventsService } from '../events/events.service';
import { PathGuardService } from '../storage/path-guard.service';
import { StorageIndexService } from '../storage/storage-index.service';
import { DbService } from '../db/db.service';
import { servers } from '../db/schema';
import { and, eq, isNull } from 'drizzle-orm';
import type { FileEntry } from '../../../shared/types/files';

const MAX_TEXT_BYTES = 2 * 1024 * 1024; // editor cap
// Global scope: panel-internal files at the DATA_DIR root that must never be read,
// written, listed, or downloaded from the UI — the database (password hashes + the
// at-rest secret cipher) and the session secret (that cipher's key + the cookie
// signing key). Any other top-level dotfile is treated the same, defensively.
const PROTECTED_GLOBAL = new Set([
  'panel.db',
  'panel.db-wal',
  'panel.db-shm',
  'panel.db-journal',
  '.session-secret',
]);

interface ResolvedPath {
  base: string;
  abs: string;
  rel: string;
}

export type ListEntry = FileEntry;

export interface ListResult {
  path: string;
  entries: ListEntry[];
}

export interface ReadTextResult {
  content: string;
  size: number;
}

export interface WriteTextResult {
  path: string;
  size: number;
}

export interface StatFileResult {
  abs: string;
  rel: string;
  size: number;
  name: string;
}

/**
 * Scoped file manager. serverId scopes every operation to
 * ./data/servers/<id>; serverId = null is the global (admin) manager rooted
 * at DATA_DIR itself. Every path resolves through PathGuardService — nothing
 * can escape ./data, and server-scoped calls can't escape their server dir.
 * Ports legacy `src/services/files.ts`.
 */
@Injectable()
export class FilesService {
  constructor(
    private readonly config: ConfigService,
    private readonly pathGuard: PathGuardService,
    private readonly events: EventsService,
    private readonly indexer: StorageIndexService,
    private readonly dbService: DbService,
  ) {}

  private get db() {
    return this.dbService.db;
  }

  private isProtectedGlobal(rel: string): boolean {
    return PROTECTED_GLOBAL.has(rel) || /^\.[^/\\]+$/.test(rel);
  }

  private resolvePath(serverId: string | null, relPath = ''): ResolvedPath {
    const base = serverId
      ? this.pathGuard.safeJoin(this.config.dataDir, 'servers', serverId)
      : this.config.dataDir;
    const abs = this.pathGuard.safeJoin(base, String(relPath || '') || '.');
    const rel = path.relative(base, abs).split(path.sep).join('/');
    return { base, abs, rel };
  }

  private guardProtected(serverId: string | null, rel: string): void {
    if (!serverId && this.isProtectedGlobal(rel)) {
      throw new ForbiddenException(
        'That panel file is not accessible from the file manager',
      );
    }
  }

  async list(serverId: string | null, relPath = ''): Promise<ListResult> {
    const { abs, rel } = this.resolvePath(serverId, relPath);
    const st = await fsp.stat(abs).catch(() => null);
    if (!st) throw new NotFoundException('Folder not found');
    if (!st.isDirectory()) throw new BadRequestException('Not a folder');

    const dirents = await fsp.readdir(abs, { withFileTypes: true });
    const entries: ListEntry[] = [];
    for (const e of dirents) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (!serverId && this.isProtectedGlobal(childRel)) continue;
      const childAbs = path.join(abs, e.name);
      const isDir = e.isDirectory();
      let size = 0;
      let mtimeMs = 0;
      try {
        if (isDir) {
          const dataRel = path
            .relative(this.config.dataDir, childAbs)
            .split(path.sep)
            .join('/');
          size = await this.indexer.sizeOf(dataRel);
          mtimeMs = (await fsp.stat(childAbs)).mtimeMs;
        } else {
          const cst = await fsp.stat(childAbs);
          size = cst.size;
          mtimeMs = cst.mtimeMs;
        }
      } catch {
        /* transient */
      }
      entries.push({
        name: e.name,
        dir: isDir,
        size,
        mtimeMs,
        mtime: this.formatWhen(mtimeMs),
        path: rel ? `${rel}/${e.name}` : e.name,
      });
    }
    entries.sort(
      (a, b) =>
        Number(b.dir) - Number(a.dir) ||
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
    );
    return { path: rel, entries };
  }

  async readText(
    serverId: string | null,
    relPath: string,
  ): Promise<ReadTextResult> {
    const { abs, rel } = this.resolvePath(serverId, relPath);
    this.guardProtected(serverId, rel);
    const st = await fsp.stat(abs).catch(() => null);
    if (!st || !st.isFile()) throw new NotFoundException('File not found');
    if (st.size > MAX_TEXT_BYTES) {
      throw new PayloadTooLargeException(
        `File is too large for the editor (${this.humanBytes(st.size)} — limit is 2 MB). Download it instead.`,
      );
    }
    const buf: Buffer = await fsp.readFile(abs);
    if (buf.subarray(0, 8192).includes(0)) {
      throw new UnsupportedMediaTypeException(
        'This looks like a binary file — download it instead of editing',
      );
    }
    return { content: buf.toString('utf8'), size: st.size };
  }

  async writeText(
    serverId: string | null,
    relPath: string,
    content: string,
    { actor = 'system' }: { actor?: string } = {},
  ): Promise<WriteTextResult> {
    const { abs, rel } = this.resolvePath(serverId, relPath);
    this.guardProtected(serverId, rel);
    if (!rel) throw new BadRequestException('Cannot write the root');
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > MAX_TEXT_BYTES)
      throw new PayloadTooLargeException(
        'Content exceeds the 2 MB editor limit',
      );
    await this.assertRoom(serverId, bytes);

    const parent = path.dirname(abs);
    const pst = await fsp.stat(parent).catch(() => null);
    if (!pst || !pst.isDirectory())
      throw new NotFoundException('Parent folder not found');
    const existing = await fsp.stat(abs).catch(() => null);
    if (existing && existing.isDirectory())
      throw new BadRequestException('That path is a folder');

    const tmp = path.join(
      parent,
      `.msm-write-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.tmp`,
    );
    await fsp.writeFile(tmp, content, 'utf8');
    await fsp.rename(tmp, abs);

    this.events.recordEvent({
      serverId: serverId || null,
      actor,
      type: 'file-written',
      summary: `File ${existing ? 'saved' : 'created'}: ${rel} (${this.humanBytes(bytes)})`,
      details: { path: rel, sizeBytes: bytes, created: !existing },
    });
    return { path: rel, size: bytes };
  }

  async mkdir(
    serverId: string | null,
    relPath: string,
    { actor = 'system' }: { actor?: string } = {},
  ): Promise<{ path: string }> {
    const { abs, rel } = this.resolvePath(serverId, relPath);
    if (!rel) throw new BadRequestException('Folder name cannot be empty');
    if (fs.existsSync(abs))
      throw new ConflictException('That name already exists');
    await fsp.mkdir(abs, { recursive: true });
    this.events.recordEvent({
      serverId: serverId || null,
      actor,
      type: 'file-mkdir',
      summary: `Folder created: ${rel}`,
      details: { path: rel },
    });
    return { path: rel };
  }

  async rename(
    serverId: string | null,
    relPath: string,
    newName: string,
    { actor = 'system' }: { actor?: string } = {},
  ): Promise<{ path: string }> {
    const { abs, rel } = this.resolvePath(serverId, relPath);
    this.guardProtected(serverId, rel);
    if (!rel) throw new BadRequestException('Cannot rename the root');
    const clean = this.sanitizeName(newName);
    if (!fs.existsSync(abs)) throw new NotFoundException('Not found');
    const target = path.join(path.dirname(abs), clean);
    if (fs.existsSync(target) && path.resolve(target) !== path.resolve(abs)) {
      throw new ConflictException(`"${clean}" already exists here`);
    }
    await fsp.rename(abs, target);
    this.events.recordEvent({
      serverId: serverId || null,
      actor,
      type: 'file-renamed',
      summary: `Renamed: ${rel} → ${clean}`,
      details: { from: rel, to: clean },
    });
    return {
      path: rel.includes('/')
        ? `${rel.slice(0, rel.lastIndexOf('/'))}/${clean}`
        : clean,
    };
  }

  async move(
    serverId: string | null,
    relPath: string,
    destRel: string,
    { actor = 'system' }: { actor?: string } = {},
  ): Promise<{ path: string }> {
    const { abs, rel } = this.resolvePath(serverId, relPath);
    this.guardProtected(serverId, rel);
    if (!rel) throw new BadRequestException('Cannot move the root');
    const dest = this.resolvePath(serverId, destRel);
    const dst = await fsp.stat(dest.abs).catch(() => null);
    if (!fs.existsSync(abs)) throw new NotFoundException('Not found');
    if (!dst || !dst.isDirectory())
      throw new BadRequestException('Destination folder not found');
    if ((dest.abs + path.sep).startsWith(abs + path.sep))
      throw new BadRequestException('Cannot move a folder into itself');

    const target = path.join(dest.abs, path.basename(abs));
    if (fs.existsSync(target))
      throw new ConflictException(
        `"${path.basename(abs)}" already exists in the destination`,
      );
    await this.moveEntry(abs, target);
    const toRel = dest.rel
      ? `${dest.rel}/${path.basename(abs)}`
      : path.basename(abs);
    this.events.recordEvent({
      serverId: serverId || null,
      actor,
      type: 'file-moved',
      summary: `Moved: ${rel} → ${toRel}`,
      details: { from: rel, to: toRel },
    });
    return { path: toRel };
  }

  async copy(
    serverId: string | null,
    relPath: string,
    destRel: string,
    { actor = 'system' }: { actor?: string } = {},
  ): Promise<{ path: string; sizeBytes: number }> {
    const { abs, rel } = this.resolvePath(serverId, relPath);
    if (!rel) throw new BadRequestException('Cannot copy the root');
    const dest = this.resolvePath(serverId, destRel);
    const st = await fsp.stat(abs).catch(() => null);
    const dst = await fsp.stat(dest.abs).catch(() => null);
    if (!st) throw new NotFoundException('Not found');
    if (!dst || !dst.isDirectory())
      throw new BadRequestException('Destination folder not found');
    if ((dest.abs + path.sep).startsWith(abs + path.sep))
      throw new BadRequestException('Cannot copy a folder into itself');

    const bytes = st.isDirectory() ? await this.dirSize(abs) : st.size;
    await this.assertRoom(serverId, bytes);
    await this.assertDiskFree(bytes);

    const target = path.join(dest.abs, path.basename(abs));
    if (fs.existsSync(target))
      throw new ConflictException(
        `"${path.basename(abs)}" already exists in the destination`,
      );
    await fsp.cp(abs, target, { recursive: true });
    const toRel = dest.rel
      ? `${dest.rel}/${path.basename(abs)}`
      : path.basename(abs);
    this.events.recordEvent({
      serverId: serverId || null,
      actor,
      type: 'file-copied',
      summary: `Copied: ${rel} → ${toRel} (${this.humanBytes(bytes)})`,
      details: { from: rel, to: toRel, sizeBytes: bytes },
    });
    this.indexer.scan().catch(() => {});
    return { path: toRel, sizeBytes: bytes };
  }

  async remove(
    serverId: string | null,
    relPath: string,
    { actor = 'system' }: { actor?: string } = {},
  ): Promise<{ freedBytes: number }> {
    const { abs, rel } = this.resolvePath(serverId, relPath);
    this.guardProtected(serverId, rel);
    if (!rel) throw new BadRequestException('Cannot delete the root folder');
    const st = await fsp.stat(abs).catch(() => null);
    if (!st) throw new NotFoundException('Not found');
    const freedBytes = st.isDirectory() ? await this.dirSize(abs) : st.size;
    await fsp.rm(abs, { recursive: true, force: true });
    this.events.recordEvent({
      serverId: serverId || null,
      actor,
      type: 'file-deleted',
      summary: `Deleted: ${rel} (${this.humanBytes(freedBytes)} freed)`,
      details: { path: rel, freedBytes },
    });
    this.indexer.scan().catch(() => {});
    return { freedBytes };
  }

  async acceptUpload(
    serverId: string | null,
    destRel: string,
    tmpAbs: string,
    originalName: string,
    { actor = 'system' }: { actor?: string } = {},
  ): Promise<{ path: string; name: string; size: number }> {
    const dest = this.resolvePath(serverId, destRel);
    const dst = await fsp.stat(dest.abs).catch(() => null);
    if (!dst || !dst.isDirectory())
      throw new BadRequestException('Destination folder not found');
    const filename = this.sanitizeName(originalName || 'upload.bin');
    const size = (await fsp.stat(tmpAbs)).size;
    await this.assertRoom(serverId, size);

    const target = path.join(dest.abs, filename);
    await this.moveEntry(tmpAbs, target);
    const rel = dest.rel ? `${dest.rel}/${filename}` : filename;
    this.events.recordEvent({
      serverId: serverId || null,
      actor,
      type: 'file-uploaded',
      summary: `Uploaded: ${rel} (${this.humanBytes(size)})`,
      details: { path: rel, sizeBytes: size },
    });
    this.indexer.scan().catch(() => {});
    return { path: rel, name: filename, size };
  }

  async statFile(
    serverId: string | null,
    relPath: string,
  ): Promise<StatFileResult> {
    const { abs, rel } = this.resolvePath(serverId, relPath);
    this.guardProtected(serverId, rel);
    const st = await fsp.stat(abs).catch(() => null);
    if (!st || !st.isFile()) throw new NotFoundException('File not found');
    return { abs, rel, size: st.size, name: path.basename(abs) };
  }

  async assertRoom(
    serverId: string | null,
    aboutToAddBytes: number,
  ): Promise<void> {
    if (!serverId) return;
    const [server] = await this.db
      .select()
      .from(servers)
      .where(and(eq(servers.id, serverId), isNull(servers.deletedAt)))
      .limit(1);
    if (server) {
      await this.indexer.assertUnderQuota(
        {
          id: server.id,
          display_name: server.displayName,
          disk_quota_bytes: server.diskQuotaBytes,
        },
        aboutToAddBytes,
      );
    }
  }

  async assertDiskFree(bytes: number): Promise<void> {
    const { free } = await this.indexer
      .diskFree()
      .catch(() => ({ free: Infinity, total: Infinity }));
    if (free < bytes * 1.1)
      throw new HttpException(
        `Not enough disk space (~${this.humanBytes(bytes)} needed)`,
        507,
      );
  }

  private async dirSize(abs: string): Promise<number> {
    let total = 0;
    let entries;
    try {
      entries = await fsp.readdir(abs, { withFileTypes: true });
    } catch {
      return 0;
    }
    for (const e of entries) {
      const child = path.join(abs, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) total += await this.dirSize(child);
      else if (e.isFile()) {
        try {
          total += (await fsp.stat(child)).size;
        } catch {
          /* transient */
        }
      }
    }
    return total;
  }

  private async moveEntry(from: string, to: string): Promise<void> {
    try {
      await fsp.rename(from, to);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
      await fsp.cp(from, to, { recursive: true });
      await fsp.rm(from, { recursive: true, force: true });
    }
  }

  private sanitizeName(name: string): string {
    const clean = String(name || '')
      .replace(/[\\/:*?"<>|\0]/g, '_')
      .replace(/^\.+$/, '')
      .trim()
      .slice(0, 180);
    if (!clean || clean === '.' || clean === '..')
      throw new BadRequestException('Invalid name');
    return clean;
  }

  private formatWhen(ms: number): string {
    if (!ms) return '—';
    const d = new Date(ms);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  private humanBytes(n: number): string {
    if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
    if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
    return `${Math.max(1, Math.round(n / 1024))} KB`;
  }
}
