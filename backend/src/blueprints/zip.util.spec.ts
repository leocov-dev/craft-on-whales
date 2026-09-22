import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BadRequestException } from '@nestjs/common';
import { PathGuardService } from '../storage/path-guard.service';
import {
  buildZipFixture,
  UNIX_MODE_SYMLINK,
} from '../utils/zip-fixture.test-helpers';
import { extractZipSafe, readZipIndex } from './zip.util';

// Pure fs/zip plumbing (PathGuardService only needs a real `config.dataDir`,
// unused by these code paths, so a minimal fake ConfigService is enough).
// These feed the blueprint import path (readZipIndex → importPreview,
// extractZipSafe → importBlueprint) a malformed .mcserver.zip and assert it
// surfaces as a BadRequestException with a specific sentence, not a raw
// yauzl exception / generic 500 — plus zip-slip/symlink cases proving the
// shared safe-zip-extractor guard is actually wired into this call site.
describe('blueprint zip.util — malformed archive handling', () => {
  let root: string;
  let pathGuard: PathGuardService;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cow-blueprint-zip-'));
    pathGuard = new PathGuardService({
      dataDir: root,
    } as ConstructorParameters<typeof PathGuardService>[0]);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  describe('readZipIndex', () => {
    it('rejects a non-zip file with a BadRequestException', async () => {
      const bogus = path.join(root, 'bogus.mcserver.zip');
      fs.writeFileSync(bogus, 'not a zip');

      await expect(readZipIndex(bogus)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  describe('extractZipSafe', () => {
    it('rejects a non-zip file with a BadRequestException, not a raw Error', async () => {
      const bogus = path.join(root, 'bogus2.mcserver.zip');
      fs.writeFileSync(bogus, 'still not a zip');

      await expect(
        extractZipSafe(pathGuard, bogus, path.join(root, 'out')),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a truncated zip with a specific "malformed" message', async () => {
      const truncated = path.join(root, 'truncated.mcserver.zip');
      fs.writeFileSync(
        truncated,
        Buffer.concat([
          Buffer.from([0x50, 0x4b, 0x03, 0x04]),
          Buffer.alloc(48, 0),
        ]),
      );

      await expect(
        extractZipSafe(pathGuard, truncated, path.join(root, 'out2')),
      ).rejects.toThrow(/malformed zip/i);
    });

    it('rejects a zip-slip entry via the shared safe-zip-extractor guard', async () => {
      const evil = path.join(root, 'evil.mcserver.zip');
      fs.writeFileSync(
        evil,
        buildZipFixture([{ name: '../escaped.txt', content: 'pwned' }]),
      );

      await expect(
        extractZipSafe(pathGuard, evil, path.join(root, 'out3')),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(fs.existsSync(path.join(root, 'escaped.txt'))).toBe(false);
    });

    it('rejects a symlink entry via the shared safe-zip-extractor guard', async () => {
      const linky = path.join(root, 'linky.mcserver.zip');
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
        extractZipSafe(pathGuard, linky, path.join(root, 'out4')),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
