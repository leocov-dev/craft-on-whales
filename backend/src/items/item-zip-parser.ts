// Pure zip/lang/mod-metadata/version-comparison helpers for ItemRegistryService.
// No DB/filesystem-root/config dependency — kept as plain functions rather
// than an @Injectable() since there's no state or DI surface to justify one.
import * as yauzl from 'yauzl';
import type { LangEntry, McDataItem } from './item-registry.types';

export const LANG_RE = /^assets\/([a-z0-9_.-]+)\/lang\/en_us\.json$/i;
export const META_RE =
  /^(META-INF\/(neoforge\.)?mods\.toml|fabric\.mod\.json|quilt\.mod\.json)$/;
export const NESTED_SERVER_RE = /^META-INF\/versions\/[^/]+\/server[^/]*\.jar$/;
const KEY_RE = /^(item|block)\.([a-z0-9_-]+)\.([a-z0-9_-]+)$/;

/** Coerce an unknown (JSON-parsed) value to a string. */
function asString(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
}

// ---------------------------------------------------------------------------
// zip plumbing (yauzl, lazyEntries — only the entries we need are ever read)

export function openZip(target: Buffer | string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    const cb = (err: Error | null, zip: yauzl.ZipFile) =>
      err ? reject(err) : resolve(zip);
    if (Buffer.isBuffer(target))
      yauzl.fromBuffer(target, { lazyEntries: true }, cb);
    else yauzl.open(target, { lazyEntries: true }, cb);
  });
}

// Cap in-memory read size so a crafted jar whose lang/JSON decompresses to GBs
// can't OOM the panel. Callers (scanJar) already try/catch per entry, so an
// over-limit entry is simply skipped.
const MAX_ZIP_ENTRY_BYTES = 16 * 1024 * 1024;

export function readZipEntry(
  zip: yauzl.ZipFile,
  entry: yauzl.Entry,
  { maxBytes = MAX_ZIP_ENTRY_BYTES }: { maxBytes?: number } = {},
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) => {
      if (err) return reject(err);
      const chunks: Buffer[] = [];
      let total = 0;
      stream.on('data', (c: Buffer) => {
        total += c.length;
        if (total > maxBytes) {
          stream.destroy();
          reject(
            new Error(
              `zip entry exceeds ${Math.round(maxBytes / 1024 / 1024)}MB: ${entry.fileName}`,
            ),
          );
          return;
        }
        chunks.push(c);
      });
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', reject);
    });
  });
}

/**
 * Walk a zip's central directory and read only entries `want(name)` selects.
 * `stopWhen(found)` may end the walk early once everything needed was seen.
 */
export function pickZipEntries(
  target: Buffer | string,
  want: (name: string) => boolean,
  stopWhen: ((found: Map<string, Buffer>) => boolean) | null = null,
): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    const found = new Map<string, Buffer>();
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(found);
    };
    openZip(target).then((zip) => {
      zip.on('error', (err: Error) => {
        zip.close();
        finish(err);
      });
      zip.on('end', () => finish());
      zip.on('entry', (entry: yauzl.Entry) => {
        if (!want(entry.fileName)) return zip.readEntry();
        readZipEntry(zip, entry)
          .then((buf) => {
            found.set(entry.fileName, buf);
            if (stopWhen && stopWhen(found)) {
              zip.close();
              return finish();
            }
            zip.readEntry();
          })
          .catch((err: Error) => {
            zip.close();
            finish(err);
          });
      });
      zip.readEntry();
    }, finish);
  });
}

// ---------------------------------------------------------------------------
// mod metadata (display names) — cheap line-level parsing, never fatal

/** META-INF/[neoforge.]mods.toml → Map(modId -> displayName). */
export function parseModsToml(text: unknown): Map<string, string | null> {
  const names = new Map<string, string | null>();
  let inMods = false;
  let modId: string | null = null;
  let displayName: string | null = null;
  const commit = () => {
    if (modId) names.set(modId, displayName || null);
    modId = null;
    displayName = null;
  };
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('[[')) {
      if (inMods) commit();
      inMods = line.startsWith('[[mods]]');
      continue;
    }
    if (!inMods) continue;
    let m = /^modId\s*=\s*"([^"]+)"/.exec(line);
    if (m) {
      modId = m[1]!;
      continue;
    }
    m = /^displayName\s*=\s*"([^"]+)"/.exec(line);
    if (m) displayName = m[1]!;
  }
  if (inMods) commit();
  return names;
}

/** fabric.mod.json / quilt.mod.json → Map(modId -> name). */
export function parseFabricModJson(text: unknown): Map<string, string | null> {
  const names = new Map<string, string | null>();
  try {
    const data = JSON.parse(String(text)) as {
      id?: unknown;
      name?: unknown;
      quilt_loader?: { id?: unknown; metadata?: { name?: unknown } };
    };
    if (data.id)
      names.set(asString(data.id), data.name ? asString(data.name) : null);
    const quilt = data.quilt_loader;
    if (quilt && quilt.id) {
      const meta = quilt.metadata || {};
      names.set(asString(quilt.id), meta.name ? asString(meta.name) : null);
    }
  } catch {
    /* malformed metadata — namespace fallback covers it */
  }
  return names;
}

// ---------------------------------------------------------------------------
// lang parsing

/** Pull items/blocks out of one en_us.json. */
export function parseLang(buf: unknown): LangEntry[] {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(String(buf)) as Record<string, unknown>;
  } catch {
    return [];
  }
  const out: LangEntry[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (typeof value !== 'string' || !value.trim()) continue;
    const m = KEY_RE.exec(key); // exact 3 segments — sub-entries never match
    if (!m) continue;
    out.push({
      id: `${m[2]}:${m[3]}`,
      name: value.trim(),
      kind: m[1] as 'item' | 'block',
      ns: m[2]!,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// minecraft-data version comparison

export type VerTuple = [number, number, number];

export function parseVer(v: string): VerTuple | null {
  const m = /^(\d+)\.(\d+)(?:\.(\d+))?$/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] || 0)] : null;
}

export function cmpVer(a: VerTuple, b: VerTuple): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** Closest available minecraft-data version to `requested` — exact, else the
 *  newest one at or below it, else (requested is older than everything we
 *  have) the oldest available. An unparsable/empty request just gets newest. */
export function nearestVersion(
  requested: string | null | undefined,
  available: string[],
): string | null {
  const parsed = available
    .map((v) => ({ v, p: parseVer(v) }))
    .filter((x): x is { v: string; p: VerTuple } => x.p !== null);
  if (!parsed.length) return null;
  parsed.sort((a, b) => cmpVer(b.p, a.p)); // newest first
  const req = parseVer(String(requested || ''));
  if (!req) return parsed[0]!.v;
  const exact = parsed.find((x) => cmpVer(x.p, req) === 0);
  if (exact) return exact.v;
  const notNewer = parsed.find((x) => cmpVer(x.p, req) <= 0);
  return notNewer ? notNewer.v : parsed[parsed.length - 1]!.v;
}

export function blockNamesFrom(blocks: { name: string }[]): Set<string> {
  return new Set((blocks || []).map((b) => b.name));
}

export function mcDataItemsToLangEntries(
  items: McDataItem[],
  blockNames: Set<string>,
): LangEntry[] {
  return (items || [])
    .filter((it) => it && it.name && it.displayName)
    .map((it) => ({
      id: `minecraft:${it.name}`,
      name: it.displayName,
      kind: blockNames.has(it.name) ? 'block' : 'item',
      ns: 'minecraft',
    }));
}
