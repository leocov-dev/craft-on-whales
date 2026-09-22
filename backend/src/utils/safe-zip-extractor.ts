// Shared "is this zip entry safe to extract" guard, consolidated out of three
// call sites that each grew their own near-identical copy (world upload/
// backup-restore/world-library install, blueprint import, and — read-only,
// out of scope here — the mod-jar scanner). See UTILS_NOTES.md for the full
// consolidation writeup.
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  BadRequestException,
  HttpException,
  PayloadTooLargeException,
} from '@nestjs/common';
import * as yauzl from 'yauzl';
import { PathGuardService } from '../storage/path-guard.service';

// unix st_mode file-type bits, as packed into a zip central-directory
// record's externalFileAttributes (high 16 bits) when versionMadeBy's high
// byte is 3 (UNIX). See `man 7 inode` / POSIX S_IFMT.
const UNIX_MADE_BY = 3;
const S_IFMT = 0xf000;
const S_IFREG = 0x8000;
const S_IFDIR = 0x4000;

/**
 * True when a zip entry's name can be safely joined under a destination
 * directory. Rejects:
 *  - NUL bytes
 *  - backslash separators — a `\`-separated name (e.g. `..\\..\\evil`) reads
 *    as one opaque path segment on POSIX, so a naive forward-slash-only `..`
 *    check can miss it; treated as malicious outright rather than normalized,
 *    since a legitimate zip (created by any real zip tool, on any platform)
 *    always stores `/`-separated names per the zip spec.
 *  - absolute paths and drive-letter paths (`C:\...`)
 *  - any `..` path segment
 */
export function isSafeZipEntryName(name: string): boolean {
  if (!name || name.includes('\0') || name.includes('\\')) return false;
  if (path.isAbsolute(name) || /^[a-zA-Z]:/.test(name)) return false;
  return !name.split('/').includes('..');
}

/**
 * True when a zip entry's type is one we're willing to materialize on disk —
 * a plain file or a directory. Symlinks, device/FIFO/socket entries, or
 * anything else encoded in the unix mode bits are rejected outright: a
 * symlink entry could otherwise be extracted as a symlink pointing outside
 * `destDir` (this repo's writers never call `fs.symlink`, so today a symlink
 * entry would merely land as an inert regular file containing the link
 * target text — but rejecting it explicitly means that safety doesn't
 * silently depend on the writer never changing, and it matches the file's
 * declared type instead of extracting a lie).
 */
export function isSupportedZipEntryType(entry: yauzl.Entry): boolean {
  const isDirEntry = entry.fileName.endsWith('/');
  const madeBy = (entry.versionMadeBy ?? 0) >> 8;
  if (madeBy !== UNIX_MADE_BY) return true; // no unix mode bits present (DOS/FAT-authored zip) — nothing to check
  const mode = (entry.externalFileAttributes ?? 0) >>> 16;
  const fileType = mode & S_IFMT;
  if (fileType === 0) return true; // mode bits present but no type encoded — treat as ordinary
  return isDirEntry ? fileType === S_IFDIR : fileType === S_IFREG;
}

export interface SafeZipExtractLimits {
  /** Ceiling on the sum of every entry's uncompressed size. */
  maxTotalBytes?: number;
  /** Ceiling on any single entry's uncompressed size. Defaults to `maxTotalBytes` — one entry can't be allowed to consume more than the whole archive's budget. */
  maxEntryBytes?: number;
  /** Ceiling on the number of entries the archive may contain. */
  maxEntries?: number;
}

export const DEFAULT_MAX_EXTRACT_TOTAL_BYTES = 50 * 1024 ** 3;
export const DEFAULT_MAX_EXTRACT_ENTRIES = 200000;

/**
 * Extract a whole zip under `destDir`, guarding every entry: zip-slip
 * containment (via `PathGuardService.safeJoin` — the repo's one path-
 * containment primitive), backslash-separator rejection, per-entry and
 * total uncompressed-size caps, and unsupported-entry-type refusal
 * (symlinks, device files, anything not a plain file/directory).
 *
 * Failures are always a `BadRequestException` (malformed/hostile archive)
 * or `PayloadTooLargeException` (a cap was exceeded) — never a raw yauzl/fs
 * error escaping to the caller.
 */
export function extractZipSafely(
  pathGuard: PathGuardService,
  zipFile: string,
  destDir: string,
  limits: SafeZipExtractLimits = {},
): Promise<void> {
  const maxTotalBytes = limits.maxTotalBytes ?? DEFAULT_MAX_EXTRACT_TOTAL_BYTES;
  const maxEntryBytes = limits.maxEntryBytes ?? maxTotalBytes;
  const maxEntries = limits.maxEntries ?? DEFAULT_MAX_EXTRACT_ENTRIES;

  return new Promise((resolve, reject) => {
    // strictFileNames: without it, yauzl silently normalizes `\` to `/`
    // before we ever see the entry — which would make backslash-separator
    // rejection unreachable dead code. With it, yauzl itself rejects a
    // backslash (or absolute/`..`) entry name as malformed before emitting
    // an 'entry' event at all.
    yauzl.open(
      zipFile,
      { lazyEntries: true, strictFileNames: true },
      (err, zip) => {
        if (err)
          return reject(
            new BadRequestException(
              `Malformed zip archive — could not be opened: ${err.message}`,
            ),
          );

        let settled = false;
        let entryCount = 0;
        let declaredBytes = 0;
        let writtenBytes = 0;

        const fail = (e: Error) => {
          if (settled) return;
          settled = true;
          try {
            zip.destroy?.();
          } catch {
            /* best-effort */
          }
          reject(
            e instanceof HttpException
              ? e
              : new BadRequestException(
                  `Malformed zip archive — extraction failed: ${e.message}`,
                ),
          );
        };
        const done = () => {
          if (settled) return;
          settled = true;
          resolve();
        };

        zip.on('error', fail);
        zip.on('end', done);
        zip.on('entry', (entry) => {
          if (settled) return;

          if (++entryCount > maxEntries) {
            return fail(
              new PayloadTooLargeException(
                `Archive has too many entries (> ${maxEntries}) — refusing to extract.`,
              ),
            );
          }

          const entrySize = entry.uncompressedSize || 0;
          if (entrySize > maxEntryBytes) {
            return fail(
              new PayloadTooLargeException(
                `Archive entry "${entry.fileName}" is too large uncompressed (> ${Math.round(maxEntryBytes / 1024 ** 3)} GB) — refusing to extract (possible decompression bomb).`,
              ),
            );
          }
          declaredBytes += entrySize;
          if (declaredBytes > maxTotalBytes) {
            return fail(
              new PayloadTooLargeException(
                `Archive is too large uncompressed (> ${Math.round(maxTotalBytes / 1024 ** 3)} GB) — refusing to extract (possible decompression bomb).`,
              ),
            );
          }

          if (!isSafeZipEntryName(entry.fileName)) {
            return fail(
              new BadRequestException(
                `Archive entry escapes destination: ${entry.fileName}`,
              ),
            );
          }
          if (!isSupportedZipEntryType(entry)) {
            return fail(
              new BadRequestException(
                `Archive entry is not a plain file or directory (symlink or special file): ${entry.fileName}`,
              ),
            );
          }

          let target: string;
          try {
            target = pathGuard.safeJoin(destDir, entry.fileName);
          } catch {
            return fail(
              new BadRequestException(
                `Archive entry escapes destination: ${entry.fileName}`,
              ),
            );
          }

          if (entry.fileName.endsWith('/')) {
            fs.mkdirSync(target, { recursive: true });
            zip.readEntry();
            return;
          }

          fs.mkdirSync(path.dirname(target), { recursive: true });
          zip.openReadStream(entry, (streamErr, readStream) => {
            if (streamErr) return fail(streamErr);
            const out = fs.createWriteStream(target);
            let entryWritten = 0;
            readStream.on('data', (chunk: Buffer) => {
              entryWritten += chunk.length;
              writtenBytes += chunk.length;
              if (
                entryWritten > maxEntryBytes ||
                writtenBytes > maxTotalBytes
              ) {
                readStream.unpipe(out);
                readStream.destroy();
                out.destroy();
                fail(
                  new PayloadTooLargeException(
                    entryWritten > maxEntryBytes
                      ? `Archive entry "${entry.fileName}" exceeds the ${Math.round(maxEntryBytes / 1024 ** 3)} GB per-entry limit — aborted (possible decompression bomb).`
                      : `Archive exceeds the ${Math.round(maxTotalBytes / 1024 ** 3)} GB extraction limit — aborted (possible decompression bomb).`,
                  ),
                );
              }
            });
            out.on('close', () => {
              if (!settled) zip.readEntry();
            });
            out.on('error', fail);
            readStream.pipe(out);
          });
        });
        zip.readEntry();
      },
    );
  });
}
