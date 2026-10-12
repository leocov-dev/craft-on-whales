import {
  AUTO_HEAP_MAX_MB,
  AUTO_HEAP_MIN_MB,
  ResourceDefaultsResolver,
  autoHeapMb,
} from './resource-defaults.resolver';

const GB = 1024;

describe('autoHeapMb', () => {
  it.each([
    // [host RAM in MB, expected heap in MB]
    [2 * GB, AUTO_HEAP_MIN_MB],
    [4 * GB, AUTO_HEAP_MIN_MB],
    [8 * GB, 1024],
    [16 * GB, 2048],
    [24 * GB, 3072],
    [32 * GB, 4096],
    [64 * GB, AUTO_HEAP_MAX_MB],
    [512 * GB, AUTO_HEAP_MAX_MB],
  ])('host with %i MB gets a %i MB heap', (hostMb, heapMb) => {
    expect(autoHeapMb(hostMb)).toBe(heapMb);
  });

  it('never leaves the min/max bounds', () => {
    for (let gb = 0; gb <= 1024; gb += 3) {
      const heap = autoHeapMb(gb * GB);
      expect(heap).toBeGreaterThanOrEqual(AUTO_HEAP_MIN_MB);
      expect(heap).toBeLessThanOrEqual(AUTO_HEAP_MAX_MB);
    }
  });
});

describe('ResourceDefaultsResolver', () => {
  const ENV_KEYS = [
    'DEFAULT_HEAP_MB',
    'DEFAULT_CONTAINER_MEMORY_MB',
    'DEFAULT_DISK_QUOTA_GB',
  ] as const;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('keeps the container limit above the heap', () => {
    const d = new ResourceDefaultsResolver().resolve();
    expect(d.containerMemoryMb).toBeGreaterThan(d.heapMb);
  });

  it('honours env overrides over the host-aware defaults', () => {
    process.env.DEFAULT_HEAP_MB = '2048';
    process.env.DEFAULT_CONTAINER_MEMORY_MB = '3584';
    const d = new ResourceDefaultsResolver().resolve();
    expect(d.heapMb).toBe(2048);
    expect(d.containerMemoryMb).toBe(3584);
  });

  it('derives the container limit from an overridden heap', () => {
    process.env.DEFAULT_HEAP_MB = '4096';
    expect(new ResourceDefaultsResolver().resolve().containerMemoryMb).toBe(
      6144,
    );
  });
});
