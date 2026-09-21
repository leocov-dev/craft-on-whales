import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FilesService } from './files.service';

interface DirSizeCapable {
  dirSize(abs: string): Promise<number>;
}

/**
 * Scoped to the private `dirSize()` walk only — it has no dependency on
 * the constructor's injected services, so the DI-heavy constructor is
 * bypassed with `Object.create` rather than stubbing all 6 params.
 */
function makeService(): DirSizeCapable {
  return Object.create(FilesService.prototype) as DirSizeCapable;
}

describe('FilesService.dirSize — symlink safety', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'msm-files-dirsize-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('counts real files but ignores a symlink pointing outside the tree', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'msm-outside-'));
    fs.writeFileSync(path.join(outside, 'secret.bin'), Buffer.alloc(10_000));

    fs.writeFileSync(path.join(root, 'real.txt'), Buffer.alloc(42));
    fs.symlinkSync(outside, path.join(root, 'escape-link'), 'dir');

    try {
      const service = makeService();
      await expect(service.dirSize(root)).resolves.toBe(42);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('does not follow a symlink loop back into an ancestor directory', async () => {
    const sub = path.join(root, 'sub');
    fs.mkdirSync(sub);
    fs.writeFileSync(path.join(sub, 'a.txt'), Buffer.alloc(7));
    fs.symlinkSync(root, path.join(sub, 'back'), 'dir');

    const service = makeService();
    await expect(service.dirSize(root)).resolves.toBe(7);
  });
});
