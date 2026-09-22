import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BadRequestException } from '@nestjs/common';
import { PathGuardService } from '../storage/path-guard.service';
import {
  buildZipFixture,
  UNIX_MODE_SYMLINK,
} from '../utils/zip-fixture.test-helpers';
import { WorldArchiveService } from './world-archive.service';

// Docker-free, DB-free: WorldArchiveService is pure fs/zip plumbing, so it's
// instantiated directly (with a real PathGuardService — its own constructor
// needs only `config.dataDir`, unused by the zip-extraction paths under
// test here, so a minimal fake ConfigService is enough). These cases feed it
// inputs a hostile or careless upload could produce — truncated zip,
// non-archive bytes, corrupt tar — and assert every one surfaces as a
// BadRequestException with a specific sentence rather than the raw
// yauzl/tar parser error bubbling up as a 500.
describe('WorldArchiveService — malformed archive handling', () => {
  let service: WorldArchiveService;
  let root: string;

  beforeEach(() => {
    const pathGuard = new PathGuardService({
      dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'cow-world-archive-cfg-')),
    } as ConstructorParameters<typeof PathGuardService>[0]);
    service = new WorldArchiveService(pathGuard);
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cow-world-archive-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  describe('extractZip', () => {
    it('rejects with a BadRequestException when the zip is not a real zip', async () => {
      const bogus = path.join(root, 'bogus.zip');
      fs.writeFileSync(bogus, 'this is not a zip file at all');

      await expect(
        service.extractZip(bogus, path.join(root, 'out')),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a truncated zip (valid local-file header, no central directory)', async () => {
      const truncated = path.join(root, 'truncated.zip');
      // A real PK\x03\x04 local file header signature followed by garbage —
      // enough to look zip-ish at a glance, but yauzl can't find a valid
      // end-of-central-directory record.
      fs.writeFileSync(
        truncated,
        Buffer.concat([
          Buffer.from([0x50, 0x4b, 0x03, 0x04]),
          Buffer.alloc(64, 0),
        ]),
      );

      await expect(
        service.extractZip(truncated, path.join(root, 'out2')),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects with a message that names the archive as malformed, not a raw parser error', async () => {
      const bogus = path.join(root, 'bogus2.zip');
      fs.writeFileSync(bogus, 'nope');

      await expect(
        service.extractZip(bogus, path.join(root, 'out3')),
      ).rejects.toThrow(/malformed zip/i);
    });

    it('rejects a zip-slip entry via the shared safe-zip-extractor guard', async () => {
      const evil = path.join(root, 'evil.zip');
      fs.writeFileSync(
        evil,
        buildZipFixture([{ name: '../escaped.txt', content: 'pwned' }]),
      );

      await expect(
        service.extractZip(evil, path.join(root, 'out6')),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(fs.existsSync(path.join(root, 'escaped.txt'))).toBe(false);
    });

    it('rejects a symlink entry via the shared safe-zip-extractor guard', async () => {
      const linky = path.join(root, 'linky.zip');
      fs.writeFileSync(
        linky,
        buildZipFixture([
          {
            name: 'link.txt',
            content: '/etc/passwd',
            unixMode: UNIX_MODE_SYMLINK,
          },
        ]),
      );

      await expect(
        service.extractZip(linky, path.join(root, 'out7')),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('extracts a normal valid zip intact', async () => {
      const good = path.join(root, 'good.zip');
      fs.writeFileSync(
        good,
        buildZipFixture([{ name: 'level.dat', content: 'nbt-ish bytes' }]),
      );
      const out = path.join(root, 'out8');

      await service.extractZip(good, out);

      expect(fs.readFileSync(path.join(out, 'level.dat'), 'utf8')).toBe(
        'nbt-ish bytes',
      );
    });
  });

  describe('extractArchive', () => {
    it('rejects a file that is neither zip nor tar magic bytes', async () => {
      const notAnArchive = path.join(root, 'world.zip');
      fs.writeFileSync(notAnArchive, 'plain text, not an archive');

      await expect(
        service.extractArchive(
          notAnArchive,
          path.join(root, 'out4'),
          'world.zip',
        ),
      ).rejects.toMatchObject({
        status: 400,
      });
    });

    it('rejects a corrupt .tar.gz with a 4xx, not a raw tar/gzip exception', async () => {
      const badTarGz = path.join(root, 'world.tar.gz');
      // Valid gzip magic bytes, garbage payload — decompresses to nothing
      // tar can parse.
      fs.writeFileSync(
        badTarGz,
        Buffer.concat([Buffer.from([0x1f, 0x8b]), Buffer.alloc(32, 0xff)]),
      );

      await expect(
        service.extractArchive(
          badTarGz,
          path.join(root, 'out5'),
          'world.tar.gz',
        ),
      ).rejects.toMatchObject({ status: 400 });
    });
  });
});
