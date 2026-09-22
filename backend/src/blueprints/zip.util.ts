import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import { ZipArchive } from 'archiver';
import * as yauzl from 'yauzl';
import { PathGuardService } from '../storage/path-guard.service';
import {
  extractZipSafely,
  isSafeZipEntryName,
} from '../utils/safe-zip-extractor';

export { ZipArchive };

// ---- Zip helpers (all zip-slip-guarded — see utils/safe-zip-extractor.ts) ----

/** @deprecated kept for callers outside this file; use isSafeZipEntryName. */
export const safeEntryName = isSafeZipEntryName;

export interface ZipEntry {
  name: string;
  size: number;
}

/** List entries and stream out manifest.json without extracting anything. */
export function readZipIndex(
  zipPath: string,
): Promise<{ entries: ZipEntry[]; manifestText: string | null }> {
  return new Promise((resolve, reject) => {
    yauzl.open(
      zipPath,
      { lazyEntries: true, strictFileNames: true },
      (err, zip) => {
        if (err)
          return reject(new BadRequestException('Not a valid zip archive'));
        const entries: ZipEntry[] = [];
        let manifestText: string | null = null;
        zip.on('error', reject);
        zip.on('end', () => resolve({ entries, manifestText }));
        zip.on('entry', (entry) => {
          if (!safeEntryName(entry.fileName)) {
            zip.close();
            return reject(
              new BadRequestException(
                `Archive entry escapes its destination: ${entry.fileName}`,
              ),
            );
          }
          entries.push({ name: entry.fileName, size: entry.uncompressedSize });
          if (entry.fileName === 'manifest.json') {
            zip.openReadStream(entry, (streamErr, readStream) => {
              if (streamErr) return reject(streamErr);
              const chunks: Buffer[] = [];
              readStream.on('data', (c: Buffer) => chunks.push(c));
              readStream.on('error', reject);
              readStream.on('end', () => {
                manifestText = Buffer.concat(chunks).toString('utf8');
                zip.readEntry();
              });
            });
          } else {
            zip.readEntry();
          }
        });
        zip.readEntry();
      },
    );
  });
}

// Default cumulative decompressed-size budget for extractZipSafe — matches
// the upload size cap enforced on blueprint import (see
// blueprints.controller.ts's `limits.fileSize`), since extraction shouldn't
// be able to write out more than an honestly-sized upload ever could.
export const MAX_EXTRACT_BYTES = 8 * 1024 ** 3;

/**
 * Extract a whole zip under destDir. Every entry is guarded by the shared
 * safe-zip-extractor (zip-slip containment via PathGuardService.safeJoin,
 * backslash-separator rejection, per-entry/total decompressed-size caps,
 * unsupported-entry-type refusal) — see UTILS_NOTES.md.
 */
export function extractZipSafe(
  pathGuard: PathGuardService,
  zipFile: string,
  destDir: string,
  maxTotalBytes: number = MAX_EXTRACT_BYTES,
): Promise<void> {
  return extractZipSafely(pathGuard, zipFile, destDir, { maxTotalBytes });
}

export function hashFile(absFile: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(absFile)
      .on('data', (c: string | Buffer) => hash.update(c))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

export function slugify(name: string): string {
  return (
    String(name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'blueprint'
  );
}

export function sanitizeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|\0]/g, '_').slice(0, 180);
}
