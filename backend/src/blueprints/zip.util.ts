import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import archiver from 'archiver';
import * as yauzl from 'yauzl';

export { archiver };

// ---- Zip helpers (all zip-slip-guarded) ----

export function safeEntryName(name: string): boolean {
  if (!name || name.includes('\0') || name.includes('\\')) return false;
  if (path.isAbsolute(name) || /^[a-zA-Z]:/.test(name)) return false;
  return !name.split('/').includes('..');
}

export interface ZipEntry {
  name: string;
  size: number;
}

/** List entries and stream out manifest.json without extracting anything. */
export function readZipIndex(
  zipPath: string,
): Promise<{ entries: ZipEntry[]; manifestText: string | null }> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
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
    });
  });
}

/** Extract a whole zip under destDir; every entry path is containment-checked. */
export function extractZipSafe(
  zipFile: string,
  destDir: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipFile, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err);
      zip.on('error', reject);
      zip.on('end', resolve);
      zip.on('entry', (entry) => {
        if (!safeEntryName(entry.fileName)) {
          zip.close();
          return reject(
            new Error(`Archive entry escapes destination: ${entry.fileName}`),
          );
        }
        const target = path.resolve(destDir, entry.fileName);
        if (
          target !== path.resolve(destDir) &&
          !target.startsWith(path.resolve(destDir) + path.sep)
        ) {
          zip.close();
          return reject(
            new Error(`Archive entry escapes destination: ${entry.fileName}`),
          );
        }
        if (/\/$/.test(entry.fileName)) {
          fs.mkdirSync(target, { recursive: true });
          zip.readEntry();
        } else {
          fs.mkdirSync(path.dirname(target), { recursive: true });
          zip.openReadStream(entry, (streamErr, readStream) => {
            if (streamErr) return reject(streamErr);
            const out = fs.createWriteStream(target);
            out.on('close', () => zip.readEntry());
            out.on('error', reject);
            readStream.pipe(out);
          });
        }
      });
      zip.readEntry();
    });
  });
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
