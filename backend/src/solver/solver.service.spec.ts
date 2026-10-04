import { NotFoundException } from '@nestjs/common';
import { SolverService } from './solver.service';
import { JavaMatrixService } from '../servers/java-matrix.service';
import type { ModrinthApiService } from '../mods/modrinth-api.service';
import type { CurseforgeApiService } from '../mods/curseforge-api.service';
import type {
  CurseforgeFile,
  CurseforgeResolved,
  ModrinthVersion,
} from '../mods/mods.types';

const MODS = 6;
const PLUGINS = 5;

const cfMod = (
  slug: string,
  classId: number,
  modId: number,
): CurseforgeResolved => ({
  modId,
  slug,
  name: slug.toUpperCase(),
  summary: '',
  iconUrl: null,
  downloads: 0,
  classId,
  latestFiles: [],
  fileId: null,
});

const cfFile = (
  gameVersions: string[],
  releaseType: CurseforgeFile['releaseType'] = 'release',
): CurseforgeFile => ({
  fileId: 1,
  name: 'f',
  fileName: 'f.jar',
  downloadUrl: null,
  gameVersions,
  releaseType,
  fileDate: '2026-01-01T00:00:00Z',
  fileLength: 1,
  hashes: [],
  serverPackFileId: null,
  dependencies: [],
});

const mrVersion = (
  loaders: string[],
  game_versions: string[],
): ModrinthVersion =>
  ({
    version_type: 'release',
    loaders,
    game_versions,
  }) as unknown as ModrinthVersion;

interface Fixtures {
  modrinth?: Record<string, { slug: string; versions: ModrinthVersion[] }>;
  curseforge?: Record<
    string,
    { mod: CurseforgeResolved; files: CurseforgeFile[] }
  >;
}

/** SolverService over in-memory registries; only what the solver asks of them. */
function build({ modrinth = {}, curseforge = {} }: Fixtures) {
  const mr = {
    getProject: (ref: string) => {
      const p = modrinth[ref];
      return p
        ? Promise.resolve({ slug: p.slug, title: p.slug, icon_url: null })
        : Promise.reject(Object.assign(new Error('missing'), { status: 404 }));
    },
    getVersions: (ref: string) => Promise.resolve(modrinth[ref]!.versions),
  } as unknown as ModrinthApiService;
  const cf = {
    resolveUrl: (ref: string) => {
      const p = curseforge[ref];
      return p
        ? Promise.resolve(p.mod)
        : Promise.reject(new NotFoundException('Not found on CurseForge'));
    },
    getAllFiles: (modId: number) =>
      Promise.resolve(
        Object.values(curseforge).find((p) => p.mod.modId === modId)!.files,
      ),
  } as unknown as CurseforgeApiService;
  return new SolverService(mr, cf, new JavaMatrixService());
}

describe('SolverService with CurseForge projects', () => {
  describe('buildCurseforgeLoaderMap', () => {
    const solver = build({});

    it('splits gameVersions into MC versions and loader tags', () => {
      const map = solver.buildCurseforgeLoaderMap(
        [
          cfFile(['1.21.1', '1.21', 'Fabric', 'Java 21', 'Client']),
          cfFile(['1.20.1', 'Forge', 'NeoForge']),
        ],
        MODS,
      );
      expect([...map.get('fabric')!]).toEqual(['1.21.1', '1.21']);
      expect([...map.get('forge')!]).toEqual(['1.20.1']);
      expect([...map.get('neoforge')!]).toEqual(['1.20.1']);
      expect(map.get('quilt')!.size).toBe(0);
      expect(map.get('paper')!.size).toBe(0);
    });

    it('skips alpha files and snapshot versions', () => {
      const map = solver.buildCurseforgeLoaderMap(
        [
          cfFile(['1.21.4', 'Fabric'], 'alpha'),
          cfFile(['1.21.2-pre1', '26w02a', '1.21.3', 'Fabric'], 'beta'),
        ],
        MODS,
      );
      expect([...map.get('fabric')!]).toEqual(['1.21.3']);
    });

    it('treats Bukkit Plugins projects as Paper', () => {
      const map = solver.buildCurseforgeLoaderMap(
        [cfFile(['1.21.4', 'Bukkit', 'Spigot'])],
        PLUGINS,
      );
      expect([...map.get('paper')!]).toEqual(['1.21.4']);
      expect(map.get('forge')!.size).toBe(0);
    });

    it('does not count a mod as Paper just for a Bukkit tag', () => {
      const map = solver.buildCurseforgeLoaderMap(
        [cfFile(['1.21.4', 'Bukkit'])],
        MODS,
      );
      expect(map.get('paper')!.size).toBe(0);
    });
  });

  describe('solve', () => {
    const solver = build({
      modrinth: {
        sodium: {
          slug: 'sodium',
          versions: [mrVersion(['fabric'], ['1.21.1', '1.20.1'])],
        },
      },
      curseforge: {
        jei: {
          mod: cfMod('jei', MODS, 10),
          files: [
            cfFile(['1.20.1', 'Fabric']),
            cfFile(['1.19.2', 'Fabric']),
            cfFile(['1.21.1', 'Forge']),
          ],
        },
        'jei-alias': {
          mod: cfMod('jei', MODS, 10),
          files: [cfFile(['1.20.1', 'Fabric'])],
        },
        neo: {
          mod: cfMod('neo', MODS, 12),
          files: [cfFile(['1.21.1', 'NeoForge'])],
        },
        lonely: {
          mod: cfMod('lonely', MODS, 11),
          files: [cfFile(['1.19.2', 'Fabric'])],
        },
      },
    });

    it('finds the intersection pair across a mixed selection', async () => {
      const res = await solver.solve([
        'sodium', // bare string = Modrinth
        { platform: 'curseforge', ref: 'jei' },
      ]);
      expect(res.best).toMatchObject({
        loader: 'fabric',
        mcVersion: '1.20.1',
        coverage: 'all',
      });
      expect(res.perProject.map((p) => [p.key, p.supported])).toEqual([
        ['modrinth:sodium', true],
        ['curseforge:jei', true],
      ]);
    });

    it('reports partial coverage with platform keys', async () => {
      const res = await solver.solve([
        'sodium',
        { platform: 'curseforge', ref: 'lonely' },
      ]);
      expect(res.best).toBeNull();
      expect(res.partial).toMatchObject({
        coveredCount: 1,
        total: 2,
        mcVersion: '1.21.1',
        coveredKeys: ['modrinth:sodium'],
      });
      expect(res.partial!.dropped).toEqual([
        expect.objectContaining({
          platform: 'curseforge',
          slug: 'lonely',
          supportedVersions: ['1.19.2'],
        }),
      ]);
    });

    it('keeps same-slug projects from different platforms apart', async () => {
      const same = build({
        modrinth: {
          jei: { slug: 'jei', versions: [mrVersion(['fabric'], ['1.20.1'])] },
        },
        curseforge: {
          jei: {
            mod: cfMod('jei', MODS, 10),
            files: [cfFile(['1.20.1', 'Fabric'])],
          },
        },
      });
      const res = await same.solve([
        'jei',
        { platform: 'modrinth', ref: 'jei' }, // duplicate of the bare string
        { platform: 'curseforge', ref: 'jei' },
      ]);
      expect(res.perProject.map((p) => p.key)).toEqual([
        'modrinth:jei',
        'curseforge:jei',
      ]);
    });

    it('counts a project once when two refs resolve to the same key', async () => {
      const res = await solver.solve([
        { platform: 'curseforge', ref: 'jei' },
        { platform: 'curseforge', ref: 'jei-alias' },
        { platform: 'curseforge', ref: 'neo' },
      ]);
      expect(res.perProject.map((p) => p.key)).toEqual([
        'curseforge:jei',
        'curseforge:neo',
      ]);
      expect(res.best).toBeNull();
      expect(res.partial).toMatchObject({ coveredCount: 1, total: 2 });
    });

    it('solves a plugin project given by bukkit-plugins URL as Paper', async () => {
      const url = 'https://www.curseforge.com/minecraft/bukkit-plugins/ess';
      const res = await build({
        curseforge: {
          [url]: {
            mod: cfMod('ess', PLUGINS, 20),
            files: [cfFile(['1.21.4', 'Bukkit'])],
          },
        },
      }).solve([{ platform: 'curseforge', ref: url }]);
      expect(res.best).toMatchObject({ loader: 'paper', mcVersion: '1.21.4' });
    });

    it('rejects a modpack', async () => {
      const m = build({
        curseforge: {
          pack: { mod: cfMod('pack', 4471, 30), files: [] },
        },
      });
      await expect(
        m.solve([{ platform: 'curseforge', ref: 'pack' }]),
      ).rejects.toThrow('modpack');
    });

    it('names the platform in a not-found error', async () => {
      await expect(
        solver.solve([{ platform: 'curseforge', ref: 'nope' }]),
      ).rejects.toThrow('"nope" was not found on CurseForge');
      await expect(solver.solve(['nope'])).rejects.toThrow(
        '"nope" was not found on Modrinth',
      );
    });
  });
});
