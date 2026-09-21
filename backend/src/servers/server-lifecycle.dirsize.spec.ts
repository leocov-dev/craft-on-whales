import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ServerLifecycleService } from './server-lifecycle.service';

/**
 * Scoped to `dirSize()` only — it's a pure fs walk with no injected
 * dependencies, so the DI-heavy constructor is bypassed with
 * `Object.create` rather than stubbing all 16 constructor params.
 */
function makeService(): ServerLifecycleService {
  return Object.create(
    ServerLifecycleService.prototype,
  ) as ServerLifecycleService;
}

describe('ServerLifecycleService.dirSize — symlink safety', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'msm-dirsize-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('counts real files but ignores a symlink pointing outside the tree', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'msm-outside-'));
    fs.writeFileSync(path.join(outside, 'secret.bin'), Buffer.alloc(10_000));

    fs.writeFileSync(path.join(root, 'real.txt'), Buffer.alloc(123));
    fs.symlinkSync(outside, path.join(root, 'escape-link'), 'dir');

    try {
      const service = makeService();
      expect(service.dirSize(root)).toBe(123);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('does not follow a symlink loop back into an ancestor directory', () => {
    const sub = path.join(root, 'sub');
    fs.mkdirSync(sub);
    fs.writeFileSync(path.join(sub, 'a.txt'), Buffer.alloc(5));
    // Loop: sub/back -> root (an ancestor), which itself contains sub/.
    fs.symlinkSync(root, path.join(sub, 'back'), 'dir');

    const service = makeService();
    // Must terminate (no infinite recursion / stack overflow) and never
    // count anything reachable only through the symlink.
    expect(service.dirSize(root)).toBe(5);
  });

  it('ignores a symlink to a file (not just directories)', () => {
    const target = path.join(root, 'target.txt');
    fs.writeFileSync(target, Buffer.alloc(1000));
    fs.symlinkSync(target, path.join(root, 'link.txt'));

    const service = makeService();
    expect(service.dirSize(root)).toBe(1000);
  });
});
