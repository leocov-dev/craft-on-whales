import { BadRequestException } from '@nestjs/common';
import { fromZipSchema, inferZipTarget } from './server-from-zip.service';
import type { MrpackIndex } from './pack-archive';

type Jar = Parameters<typeof inferZipTarget>[1][number];
const jar = (
  kind: Jar['kind'],
  loaders: string[] = [],
  mcVersions: string[] = [],
): Jar => ({ kind, loaders, mcVersions });

const jars = (...list: Jar[]) => list;
const zip = { format: 'jars' as const, index: null };
const mrpack = (over: Partial<MrpackIndex> = {}) => ({
  format: 'mrpack' as const,
  index: {
    name: 'Pack',
    version: '1',
    mcVersion: '1.21.1',
    loader: 'fabric',
    loaderVersion: '0.16.5',
    files: [],
    invalidFiles: 0,
    ...over,
  },
});
const AUTO = { loader: 'auto' as const };

describe('inferZipTarget', () => {
  describe('.mrpack', () => {
    it('takes loader, Minecraft version and loader build from the index', () => {
      expect(inferZipTarget(mrpack(), [], AUTO)).toEqual({
        loader: 'fabric',
        mcVersion: '1.21.1',
        loaderVersion: '0.16.5',
      });
    });

    it('lets an explicit choice win, dropping a loader build for another loader', () => {
      expect(
        inferZipTarget(mrpack(), [], { loader: 'quilt', mcVersion: '1.21' }),
      ).toEqual({ loader: 'quilt', mcVersion: '1.21', loaderVersion: null });
      expect(
        inferZipTarget(mrpack(), [], { loader: 'fabric', mcVersion: '1.21' }),
      ).toMatchObject({ loaderVersion: '0.16.5' });
    });

    it('asks for what the index leaves out', () => {
      expect(() => inferZipTarget(mrpack({ loader: null }), [], AUTO)).toThrow(
        /doesn’t name a mod loader/,
      );
      expect(() =>
        inferZipTarget(mrpack({ mcVersion: null }), [], AUTO),
      ).toThrow(/doesn’t name a Minecraft version/);
      expect(
        inferZipTarget(mrpack({ loader: null }), [], {
          loader: 'forge',
        }),
      ).toEqual({ loader: 'forge', mcVersion: '1.21.1', loaderVersion: null });
    });
  });

  describe('jar zip', () => {
    it('picks the majority mod loader and the most-supported release', () => {
      expect(
        inferZipTarget(
          zip,
          jars(
            jar('mod', ['fabric'], ['1.20.1', '1.21.1']),
            jar('mod', ['fabric', 'quilt'], ['1.21.1', '24w33a']),
            jar('mod', ['forge'], ['1.20.1']),
            jar(null),
          ),
          AUTO,
        ),
      ).toEqual({ loader: 'fabric', mcVersion: '1.21.1', loaderVersion: null });
    });

    it('breaks ties toward Fabric and the newest release, and never picks a snapshot', () => {
      expect(
        inferZipTarget(
          zip,
          jars(
            jar('mod', ['quilt'], ['1.20.4', '24w33a', '24w33a']),
            jar('mod', ['fabric'], ['1.20.10', '24w33a']),
          ),
          AUTO,
        ),
      ).toEqual({
        loader: 'fabric',
        mcVersion: '1.20.10',
        loaderVersion: null,
      });
    });

    it('makes a Paper server for a zip of mostly plugins', () => {
      expect(
        inferZipTarget(
          zip,
          jars(jar('plugin', ['paper']), jar('plugin'), jar('mod', ['fabric'])),
          AUTO,
        ),
      ).toEqual({ loader: 'paper', mcVersion: 'LATEST', loaderVersion: null });
      expect(
        inferZipTarget(zip, jars(jar('plugin', [], ['1.21.4'])), AUTO)
          .mcVersion,
      ).toBe('1.21.4');
    });

    it('refuses to guess a mod zip’s Minecraft version or loader', () => {
      // Only manifest data: loaders, but no exact versions.
      expect(() =>
        inferZipTarget(zip, jars(jar('mod', ['fabric'])), AUTO),
      ).toThrow(BadRequestException);
      expect(() => inferZipTarget(zip, jars(jar(null)), AUTO)).toThrow(
        /which loader/,
      );
      expect(
        inferZipTarget(zip, jars(jar('mod', ['fabric'])), {
          loader: 'auto',
          mcVersion: '1.20.1',
        }),
      ).toEqual({ loader: 'fabric', mcVersion: '1.20.1', loaderVersion: null });
      expect(
        inferZipTarget(zip, [], { loader: 'neoforge', mcVersion: '1.21.1' }),
      ).toEqual({
        loader: 'neoforge',
        mcVersion: '1.21.1',
        loaderVersion: null,
      });
    });
  });
});

describe('fromZipSchema', () => {
  it('reads multipart strings, with blanks as unset', () => {
    expect(
      fromZipSchema.parse({
        name: ' My pack ',
        loader: '',
        mcVersion: '',
        heapMb: '2048',
        containerMemoryMb: '3072',
        diskQuotaGb: '',
        portGame: '25570',
      }),
    ).toEqual({
      name: 'My pack',
      loader: 'auto',
      mcVersion: undefined,
      applyOverrides: true,
      heapMb: 2048,
      containerMemoryMb: 3072,
      diskQuotaGb: undefined,
      portGame: 25570,
    });
  });

  it('rejects unknown loaders and a heap bigger than the container', () => {
    expect(
      fromZipSchema.safeParse({ name: 'x', loader: 'vanilla' }).success,
    ).toBe(false);
    expect(
      fromZipSchema.safeParse({
        name: 'x',
        heapMb: '4096',
        containerMemoryMb: '2048',
      }).success,
    ).toBe(false);
    expect(
      fromZipSchema.parse({ name: 'x', applyOverrides: 'false' })
        .applyOverrides,
    ).toBe(false);
  });
});
