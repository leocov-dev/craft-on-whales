'use strict';

// Shared file library: downloads deduplicated by sha256 under
// ./data/library/<kind>/, installed into servers by hard link (falls back to
// copy across volumes), with locally cached icons.

import { httpError } from '../utils/httpError';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { nanoid } = require('nanoid');
const db = require('../db') as typeof import('../db');
const { dataPath } = require('../storage/pathGuard') as typeof import('../storage/pathGuard');
const { recordEvent } = require('../events') as typeof import('../events');
const { safeFetch } = require('../utils/urlGuard') as typeof import('../utils/urlGuard');

type LibraryCategory = 'mod' | 'plugin' | 'datapack' | 'resourcepack' | 'modpack' | 'world' | 'icon';

/** A `library_files` row (see db/migrations/001_init.ts). */
interface LibraryFileRow {
  id: string;
  category: LibraryCategory;
  name: string;
  filename: string;
  rel_path: string;
  sha256: string;
  size_bytes: number;
  source_url: string | null;
  platform: string | null;
  project_id: string | null;
  file_id: string | null;
  version: string | null;
  mc_versions_json: string;
  loaders_json: string;
  icon_url: string | null;
  icon_rel_path: string | null;
  world_source: string | null;
  world_flavor: string | null;
  created_at: string;
}

interface DownloadMeta {
  category?: LibraryCategory;
  filename?: string;
  name?: string;
  platform?: string;
  projectId?: string | null;
  fileId?: string | null;
  version?: string | null;
  mcVersions?: string[];
  loaders?: string[];
  iconUrl?: string | null;
  worldSource?: string | null;
  worldFlavor?: string | null;
}

const CATEGORY_DIR: Record<LibraryCategory, string> = {
  mod: 'library/mods',
  plugin: 'library/mods', // same pool — kind recorded per row
  datapack: 'library/mods',
  resourcepack: 'library/mods',
  modpack: 'library/modpacks',
  world: 'library/worlds',
  icon: 'library/icons',
};

// No single library download may exceed this — a lying/hostile server can't
// fill the disk through an endless stream.
const MAX_DOWNLOAD_BYTES = 8 * 1024 ** 3;

/**
 * Download a URL into the library with hash dedupe.
 * onProgress({receivedBytes, totalBytes}) fires during download.
 * Returns the library_files row (existing row when the hash already exists).
 */
async function downloadToLibrary(
  url: string,
  meta: DownloadMeta,
  {
    onProgress = () => {},
    actor = 'system',
  }: { onProgress?: (progress: { receivedBytes: number; totalBytes: number }) => void; actor?: string } = {}
): Promise<LibraryFileRow> {
  const category = meta.category || 'mod';
  const tmpFile = dataPath('tmp', `dl-${nanoid(6)}`);
  // SSRF-guarded: rejects private/loopback/link-local targets and re-checks every
  // redirect hop, so a user-supplied "direct" URL can't reach internal services.
  const res = await safeFetch(url, {
    headers: { 'User-Agent': 'MinecraftServerManager/0.1' },
    signal: AbortSignal.timeout(10 * 60 * 1000),
  });
  if (!res.ok) throw httpError(502, `Download failed: HTTP ${res.status} from ${new URL(url).host}`);
  const totalBytes = Number(res.headers.get('content-length')) || 0;

  // Disk preflight when the server declares a size (tmp copy + final copy).
  if (totalBytes > 0) {
    if (totalBytes > MAX_DOWNLOAD_BYTES) {
      throw httpError(
        413,
        `Download is ${humanBytes(totalBytes)} — the ${humanBytes(MAX_DOWNLOAD_BYTES)} per-file limit blocks it`
      );
    }
    const { free } = await (require('../storage/indexer') as typeof import('../storage/indexer')).diskFree();
    if (free < totalBytes * 1.2) {
      throw httpError(507, `Not enough disk space for this download (~${humanBytes(totalBytes)} needed)`);
    }
  }

  const hash = crypto.createHash('sha256');
  let receivedBytes = 0;
  const counter = new (require('node:stream').Transform)({
    transform(chunk: Buffer, _enc: string, cb: (err?: Error | null, chunk?: Buffer) => void) {
      hash.update(chunk);
      receivedBytes += chunk.length;
      if (receivedBytes > MAX_DOWNLOAD_BYTES) {
        // Hard abort — content-length can lie or be absent entirely.
        return cb(
          httpError(413, `Download aborted: stream exceeded the ${humanBytes(MAX_DOWNLOAD_BYTES)} per-file limit`)
        );
      }
      onProgress({ receivedBytes, totalBytes });
      cb(null, chunk);
    },
  });
  try {
    await pipeline(res.body, counter, fs.createWriteStream(tmpFile));
  } catch (err) {
    await fsp.rm(tmpFile, { force: true }).catch(() => {});
    throw err;
  }

  const sha256 = hash.digest('hex');
  const existing = db.get(
    'SELECT * FROM library_files WHERE sha256 = ? AND category = ?',
    sha256,
    category
  ) as unknown as LibraryFileRow | undefined;
  if (existing) {
    await fsp.rm(tmpFile, { force: true });
    return existing;
  }

  const filename = sanitizeFilename(
    meta.filename || decodeURIComponent(path.basename(new URL(url).pathname)) || `file-${sha256.slice(0, 8)}`
  );
  const relPath = `${CATEGORY_DIR[category]}/${sha256.slice(0, 8)}-${filename}`;
  await fsp.mkdir(path.dirname(dataPath(relPath)), { recursive: true });
  await fsp.rename(tmpFile, dataPath(relPath));
  const size = (await fsp.stat(dataPath(relPath))).size;

  const id = `lib_${nanoid(8)}`;
  // ON CONFLICT closes the check-then-insert race: if a concurrent add for the same
  // (sha256, category) won, our INSERT no-ops (relPath is derived from the sha, so
  // both point at the identical file — nothing to clean up) and we return theirs.
  db.run(
    `INSERT INTO library_files (id, category, name, filename, rel_path, sha256, size_bytes, source_url,
       platform, project_id, file_id, version, mc_versions_json, loaders_json, icon_url, world_source, world_flavor)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(sha256, category) DO NOTHING`,
    id,
    category,
    meta.name || filename,
    filename,
    relPath,
    sha256,
    size,
    url,
    meta.platform || 'url',
    meta.projectId || null,
    meta.fileId || null,
    meta.version || null,
    JSON.stringify(meta.mcVersions || []),
    JSON.stringify(meta.loaders || []),
    meta.iconUrl || null,
    meta.worldSource || null,
    meta.worldFlavor || null
  );
  const row = db.get(
    'SELECT * FROM library_files WHERE sha256 = ? AND category = ?',
    sha256,
    category
  ) as unknown as LibraryFileRow;
  if (row && row.id === id) {
    // We won the insert — do the one-time side effects.
    if (meta.iconUrl) cacheIcon(id, meta.iconUrl).catch(() => {});
    recordEvent({
      actor,
      type: 'library-added',
      summary: `Added to library: ${meta.name || filename} (${humanBytes(size)})`,
      details: { id, category, sha256 },
    });
  }
  return row;
}

/** Cache a mod's platform icon locally so the UI never hotlinks. */
async function cacheIcon(libraryId: string, iconUrl: string): Promise<void> {
  try {
    const res = await safeFetch(iconUrl, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return;
    const ext = path.extname(new URL(iconUrl).pathname) || '.png';
    const rel = `library/icons/mods/${libraryId}${ext}`;
    await fsp.mkdir(path.dirname(dataPath(rel)), { recursive: true });
    await pipeline(res.body, fs.createWriteStream(dataPath(rel)));
    db.run('UPDATE library_files SET icon_rel_path = ? WHERE id = ?', rel, libraryId);
  } catch {
    /* icons are best-effort */
  }
}

/**
 * Install a library file into a server directory (hard link → copy fallback).
 * destRel example: 'mods' | 'plugins' | 'world/datapacks'.
 */
async function installToServer(
  libraryId: string,
  serverId: string,
  destRel: string,
  { filename }: { filename?: string } = {}
): Promise<{ installedPath: string; filename: string }> {
  const lib = db.get('SELECT * FROM library_files WHERE id = ?', libraryId) as unknown as LibraryFileRow | undefined;
  if (!lib) throw httpError(404, 'Library file not found');
  // The panel must own the server dir to write into it — a server created before
  // container-runs-as-panel-user has files owned by uid 1000. Lazy require breaks
  // the servers<->library cycle.
  await (require('./servers') as typeof import('./servers')).ensureOwnership(serverId);
  const destDir = dataPath('servers', serverId, destRel);
  await fsp.mkdir(destDir, { recursive: true });
  const target = path.join(destDir, sanitizeFilename(filename || lib.filename));
  await fsp.rm(target, { force: true });
  try {
    await fsp.link(dataPath(lib.rel_path), target);
  } catch {
    await fsp.copyFile(dataPath(lib.rel_path), target);
  }
  return { installedPath: target, filename: path.basename(target) };
}

/**
 * Import a locally-uploaded file (e.g. a manually-downloaded mod jar) into the
 * library with sha256 dedupe. Mirrors downloadToLibrary but from a local path.
 */
async function importFile(
  localPath: string,
  meta: DownloadMeta,
  { actor = 'system' }: { actor?: string } = {}
): Promise<LibraryFileRow> {
  const category = meta.category || 'mod';
  const buf = await fsp.readFile(localPath);
  if (buf.length > MAX_DOWNLOAD_BYTES) throw httpError(413, 'File is too large');
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  const existing = db.get(
    'SELECT * FROM library_files WHERE sha256 = ? AND category = ?',
    sha256,
    category
  ) as unknown as LibraryFileRow | undefined;
  if (existing) return existing;
  const filename = sanitizeFilename(meta.filename || path.basename(localPath));
  const relPath = `${CATEGORY_DIR[category]}/${sha256.slice(0, 8)}-${filename}`;
  await fsp.mkdir(path.dirname(dataPath(relPath)), { recursive: true });
  await fsp.writeFile(dataPath(relPath), buf);
  const id = `lib_${nanoid(8)}`;
  db.run(
    `INSERT INTO library_files (id, category, name, filename, rel_path, sha256, size_bytes, source_url,
       platform, project_id, file_id, version, mc_versions_json, loaders_json, icon_url, world_source, world_flavor)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(sha256, category) DO NOTHING`,
    id,
    category,
    meta.name || filename,
    filename,
    relPath,
    sha256,
    buf.length,
    null,
    meta.platform || 'upload',
    null,
    null,
    meta.version || null,
    JSON.stringify([]),
    JSON.stringify([]),
    null,
    null,
    null
  );
  const row = db.get(
    'SELECT * FROM library_files WHERE sha256 = ? AND category = ?',
    sha256,
    category
  ) as unknown as LibraryFileRow;
  if (row && row.id === id) {
    recordEvent({
      actor,
      type: 'library-added',
      summary: `Uploaded to library: ${meta.name || filename} (${humanBytes(buf.length)})`,
      details: { id, category, sha256 },
    });
  }
  return row;
}

function usageCount(libraryId: string): number {
  return Number(db.get('SELECT COUNT(*) AS n FROM server_content WHERE library_id = ?', libraryId)?.n || 0);
}

async function deleteLibraryFile(
  libraryId: string,
  { actor = 'system', force = false }: { actor?: string; force?: boolean } = {}
): Promise<{ freedBytes: number }> {
  const lib = db.get('SELECT * FROM library_files WHERE id = ?', libraryId) as unknown as LibraryFileRow | undefined;
  if (!lib) return { freedBytes: 0 };
  const used = usageCount(libraryId);
  if (used > 0 && !force) throw httpError(409, `Still installed on ${used} server(s) — remove it there first`);
  await fsp.rm(dataPath(lib.rel_path), { force: true });
  if (lib.icon_rel_path) await fsp.rm(dataPath(lib.icon_rel_path), { force: true });
  db.run('DELETE FROM library_files WHERE id = ?', libraryId);
  recordEvent({
    actor,
    type: 'library-deleted',
    summary: `Removed from library: ${lib.name} (${humanBytes(lib.size_bytes)} freed)`,
  });
  return { freedBytes: lib.size_bytes };
}

/** Library rows whose files no other record references — cleanup candidates. */
function orphans(): LibraryFileRow[] {
  return db.all(
    `SELECT lf.* FROM library_files lf
     LEFT JOIN server_content sc ON sc.library_id = lf.id
     WHERE sc.id IS NULL AND lf.category IN ('mod','plugin','datapack','resourcepack')`
  ) as unknown as LibraryFileRow[];
}

function sanitizeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|\0]/g, '_').slice(0, 180);
}

function humanBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.round(n / 1024)} KB`;
}

export = {
  downloadToLibrary,
  importFile,
  installToServer,
  deleteLibraryFile,
  cacheIcon,
  usageCount,
  orphans,
  CATEGORY_DIR,
};
