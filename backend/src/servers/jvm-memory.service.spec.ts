import { Test } from '@nestjs/testing';
import { JvmMemoryService } from './jvm-memory.service';

describe('JvmMemoryService', () => {
  let service: JvmMemoryService;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [JvmMemoryService],
    }).compile();
    service = moduleRef.get(JvmMemoryService);
  });

  describe('parseMemMb', () => {
    it('reads every spelling the image accepts, bare numbers as MB', () => {
      expect(service.parseMemMb('512M')).toBe(512);
      expect(service.parseMemMb('4G')).toBe(4096);
      expect(service.parseMemMb('2g')).toBe(2048);
      expect(service.parseMemMb('4096')).toBe(4096);
      expect(service.parseMemMb(' 1024m ')).toBe(1024);
      expect(service.parseMemMb('1024k')).toBe(1);
      expect(service.parseMemMb('2GB')).toBe(2048);
    });

    it('returns null for anything it cannot read', () => {
      expect(service.parseMemMb('75%')).toBeNull();
      expect(service.parseMemMb('')).toBeNull();
      expect(service.parseMemMb('   ')).toBeNull();
      expect(service.parseMemMb(undefined)).toBeNull();
      expect(service.parseMemMb(null)).toBeNull();
      expect(service.parseMemMb('lots')).toBeNull();
      expect(service.parseMemMb('-Xmx2G')).toBeNull();
      expect(service.parseMemMb('0')).toBeNull();
      expect(service.parseMemMb('-512M')).toBeNull();
      expect(service.parseMemMb({})).toBeNull();
    });
  });

  describe('normalizeSize', () => {
    it('gives a bare number its M (the bug: Java reads it as bytes)', () => {
      expect(service.normalizeSize('4096')).toBe('4096M');
      expect(service.normalizeSize('512')).toBe('512M');
      expect(service.normalizeSize('  2048  ')).toBe('2048M');
    });

    it('leaves an explicit unit alone', () => {
      expect(service.normalizeSize('512M')).toBe('512M');
      expect(service.normalizeSize('4G')).toBe('4G');
      expect(service.normalizeSize('2g')).toBe('2g');
      expect(service.normalizeSize('1024k')).toBe('1024k');
      expect(service.normalizeSize('2GB')).toBe('2GB');
    });

    it('passes through zero, percentages, and malformed input untouched', () => {
      expect(service.normalizeSize('0')).toBe('0');
      expect(service.normalizeSize('')).toBe('');
      expect(service.normalizeSize('75%')).toBe('75%');
      expect(service.normalizeSize('lots')).toBe('lots');
      expect(service.normalizeSize('-Xmx2G')).toBe('-Xmx2G');
      expect(service.normalizeSize('512 M')).toBe('512 M');
    });
  });

  describe('normalizeSizeEnv', () => {
    it('repairs every size-bearing key and touches nothing else', () => {
      const env = {
        MEMORY: '4096',
        INIT_MEMORY: '512',
        MAX_MEMORY: '8G',
        VIEW_DISTANCE: '12',
        JVM_OPTS: '-XX:+UseG1GC',
      };
      expect(service.normalizeSizeEnv(env)).toEqual({
        MEMORY: '4096M',
        INIT_MEMORY: '512M',
        MAX_MEMORY: '8G',
        VIEW_DISTANCE: '12',
        JVM_OPTS: '-XX:+UseG1GC',
      });
    });

    it('does not mutate its input and leaves absent keys absent', () => {
      const env = { MEMORY: '2048' };
      const out = service.normalizeSizeEnv(env);
      expect(env.MEMORY).toBe('2048');
      expect(out).toEqual({ MEMORY: '2048M' });
      expect('INIT_MEMORY' in out).toBe(false);
    });

    it('leaves an empty value empty rather than inventing a size', () => {
      expect(service.normalizeSizeEnv({ INIT_MEMORY: '' })).toEqual({
        INIT_MEMORY: '',
      });
    });
  });

  describe('heapPlan', () => {
    it('an equal starting and maximum heap (the default) gets the "up front" note, flags or not', () => {
      const plain = service.heapPlan({}, 12288);
      expect(plain.growsOnDemand).toBe(false);
      expect(plain.note).toMatch(/whole 12288 MB heap up front/);
      expect(plain.note).toMatch(/INIT_MEMORY/);
      // The preset does not change the message: the heap fills either way.
      expect(service.heapPlan({ USE_AIKAR_FLAGS: 'true' }, 12288).note).toBe(
        plain.note,
      );
    });

    it('a smaller INIT_MEMORY flips the note to "grows on demand"', () => {
      const p = service.heapPlan(
        { INIT_MEMORY: '4G', USE_AIKAR_FLAGS: 'true' },
        12288,
      );
      expect(p.initMb).toBe(4096);
      expect(p.growsOnDemand).toBe(true);
      expect(p.note).toMatch(/starts with 4096 MB and grows toward its 12288/);
    });

    it('MAX_MEMORY overrides the panel heap; INIT_MEMORY above it is not growth', () => {
      const p = service.heapPlan(
        { MAX_MEMORY: '8G', INIT_MEMORY: '8G' },
        12288,
      );
      expect(p.heapMb).toBe(8192);
      expect(p.growsOnDemand).toBe(false);
      expect(
        service.heapPlan({ INIT_MEMORY: '16G' }, 12288).growsOnDemand,
      ).toBe(false);
    });

    it('no heap at all yields no note', () => {
      expect(service.heapPlan({}, 0).note).toBeNull();
      expect(service.heapPlan(undefined, undefined).note).toBeNull();
      expect(service.heapPlan(null, null).note).toBeNull();
    });
  });
});
