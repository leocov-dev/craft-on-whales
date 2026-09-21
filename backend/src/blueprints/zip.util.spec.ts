import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BadRequestException } from '@nestjs/common';
import { extractZipSafe, readZipIndex } from './zip.util';

// Pure fs/zip plumbing, no DI needed. These feed the blueprint import path
// (readZipIndex → importPreview, extractZipSafe → importBlueprint) a
// malformed .mcserver.zip and assert it surfaces as a BadRequestException
// with a specific sentence, not a raw yauzl exception / generic 500.
describe('blueprint zip.util — malformed archive handling', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cow-blueprint-zip-'));
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
        extractZipSafe(bogus, path.join(root, 'out')),
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
        extractZipSafe(truncated, path.join(root, 'out2')),
      ).rejects.toThrow(/malformed zip/i);
    });
  });
});
