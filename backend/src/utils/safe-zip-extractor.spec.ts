import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import { PathGuardService } from '../storage/path-guard.service';
import {
  extractZipSafely,
  isSafeZipEntryName,
  isSupportedZipEntryType,
} from './safe-zip-extractor';
import {
  buildZipFixture,
  UNIX_MODE_REGULAR_FILE,
  UNIX_MODE_SYMLINK,
} from './zip-fixture.test-helpers';

describe('isSafeZipEntryName', () => {
  it('accepts ordinary forward-slash-separated names', () => {
    expect(isSafeZipEntryName('sub/dir/file.txt')).toBe(true);
    expect(isSafeZipEntryName('top.txt')).toBe(true);
  });

  it('rejects a backslash-separator entry name', () => {
    expect(isSafeZipEntryName('a\\b.txt')).toBe(false);
    expect(isSafeZipEntryName('..\\..\\evil.txt')).toBe(false);
  });

  it('rejects a `..` traversal segment', () => {
    expect(isSafeZipEntryName('../evil.txt')).toBe(false);
    expect(isSafeZipEntryName('sub/../../evil.txt')).toBe(false);
  });

  it('rejects an absolute or drive-letter path', () => {
    expect(isSafeZipEntryName('/etc/passwd')).toBe(false);
    expect(isSafeZipEntryName('C:/windows/system32')).toBe(false);
  });

  it('rejects a NUL byte and an empty name', () => {
    expect(isSafeZipEntryName('evil\0.txt')).toBe(false);
    expect(isSafeZipEntryName('')).toBe(false);
  });
});

describe('isSupportedZipEntryType', () => {
  const entry = (fileName: string, unixMode?: number) => ({
    fileName,
    uncompressedSize: 0,
    versionMadeBy: unixMode !== undefined ? (3 << 8) | 20 : 20,
    externalFileAttributes: (unixMode ?? 0) << 16,
  });

  it('accepts a plain file and a directory entry with no unix mode bits', () => {
    expect(isSupportedZipEntryType(entry('file.txt'))).toBe(true);
    expect(isSupportedZipEntryType(entry('dir/'))).toBe(true);
  });

  it('accepts a unix-authored regular file and directory', () => {
    expect(isSupportedZipEntryType(entry('file.txt', 0o100644))).toBe(true);
    expect(isSupportedZipEntryType(entry('dir/', 0o40755))).toBe(true);
  });

  it('rejects a unix symlink entry', () => {
    expect(isSupportedZipEntryType(entry('link.txt', 0o120777))).toBe(false);
  });

  it('rejects a unix device/FIFO/socket entry', () => {
    expect(isSupportedZipEntryType(entry('dev.node', 0o020666))).toBe(false); // char device
    expect(isSupportedZipEntryType(entry('fifo.node', 0o010644))).toBe(false); // FIFO
  });
});

describe('safe-zip-extractor', () => {
  let root: string;
  let destDir: string;
  let pathGuard: PathGuardService;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cow-safe-zip-'));
    destDir = path.join(root, 'out');
    pathGuard = new PathGuardService({
      dataDir: root,
    } as ConstructorParameters<typeof PathGuardService>[0]);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const write = (entries: Parameters<typeof buildZipFixture>[0]): string => {
    const zipPath = path.join(root, `${Date.now()}-${Math.random()}.zip`);
    fs.writeFileSync(zipPath, buildZipFixture(entries));
    return zipPath;
  };

  it('extracts a normal valid zip (dirs + files) intact', async () => {
    const zip = write([
      { name: 'sub/' },
      { name: 'sub/hello.txt', content: 'hello world' },
      { name: 'top.txt', content: 'top level' },
    ]);

    await extractZipSafely(pathGuard, zip, destDir);

    expect(fs.readFileSync(path.join(destDir, 'sub/hello.txt'), 'utf8')).toBe(
      'hello world',
    );
    expect(fs.readFileSync(path.join(destDir, 'top.txt'), 'utf8')).toBe(
      'top level',
    );
  });

  it('rejects a zip-slip attempt escaping destDir via ../', async () => {
    const zip = write([{ name: '../evil.txt', content: 'pwned' }]);

    await expect(extractZipSafely(pathGuard, zip, destDir)).rejects.toThrow(
      BadRequestException,
    );
    expect(fs.existsSync(path.join(root, 'evil.txt'))).toBe(false);
  });

  it('rejects an entry using backslash separators outright', async () => {
    const zip = write([{ name: 'a\\b.txt', content: 'x' }]);

    await expect(extractZipSafely(pathGuard, zip, destDir)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('rejects an oversized entry against the per-entry cap', async () => {
    const zip = write([{ name: 'big.bin', content: Buffer.alloc(1024, 1) }]);

    await expect(
      extractZipSafely(pathGuard, zip, destDir, { maxEntryBytes: 100 }),
    ).rejects.toThrow(PayloadTooLargeException);
  });

  it('rejects an archive whose total uncompressed size exceeds the cap', async () => {
    const zip = write([
      { name: 'a.bin', content: Buffer.alloc(60, 1) },
      { name: 'b.bin', content: Buffer.alloc(60, 2) },
    ]);

    await expect(
      extractZipSafely(pathGuard, zip, destDir, {
        maxEntryBytes: 100,
        maxTotalBytes: 100,
      }),
    ).rejects.toThrow(PayloadTooLargeException);
  });

  it('rejects a symlink entry rather than extracting or following it', async () => {
    const zip = write([
      {
        name: 'link.txt',
        content: '/etc/passwd',
        unixMode: UNIX_MODE_SYMLINK,
      },
    ]);

    await expect(extractZipSafely(pathGuard, zip, destDir)).rejects.toThrow(
      BadRequestException,
    );
    expect(fs.existsSync(path.join(destDir, 'link.txt'))).toBe(false);
  });

  it('accepts a unix-authored entry that is an ordinary regular file', async () => {
    const zip = write([
      {
        name: 'ok.txt',
        content: 'fine',
        unixMode: UNIX_MODE_REGULAR_FILE,
      },
    ]);

    await extractZipSafely(pathGuard, zip, destDir);
    expect(fs.readFileSync(path.join(destDir, 'ok.txt'), 'utf8')).toBe('fine');
  });

  it('rejects a malformed (non-zip) file with a BadRequestException', async () => {
    const bogus = path.join(root, 'bogus.zip');
    fs.writeFileSync(bogus, 'not a zip at all');

    await expect(
      extractZipSafely(pathGuard, bogus, destDir),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
