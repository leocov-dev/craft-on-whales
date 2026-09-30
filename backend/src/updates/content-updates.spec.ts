import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { eq } from 'drizzle-orm';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import type { Request } from 'express';
import { ApiCacheService } from '../mods/api-cache.service';
import { HangarApiService, pickHangarUpdate } from '../mods/hangar-api.service';
import { SpigetApiService, pickSpigetUpdate } from '../mods/spiget-api.service';
import {
  GithubReleasesApiService,
  pickGithubUpdate,
  pickGithubUpdateAsset,
} from '../mods/github-releases-api.service';
import { BlockedDownloadException } from '../mods/blocked-download.exception';
import { ModsService } from '../mods/mods.service';
import { ModsController } from '../mods/mods.controller';
import { UpdateCheckerService } from './update-checker.service';
import { ContentLatestService } from './content-latest.service';
import {
  libraryFiles,
  serverContent,
  servers,
  updateChecks,
} from '../db/schema';
import type { ConfigService } from '../config/config.service';
import type { DownloadMeta } from '../library/library.service';
import type {
  GithubRelease,
  HangarVersion,
  SpigetVersion,
} from '../mods/mods.types';

// Update checks and one-click updates for Hangar / SpigotMC / GitHub
// content (item 4.29b). Pure "what's newer" pickers first, then the checker
// end to end against the real migrations in an in-memory SQLite with the
// real API clients (fetch stubbed per URL), then the update route and the
// manual-upload completion of a blocked update.

const MIGRATIONS_DIR = path.resolve(__dirname, '..', '..', 'drizzle');

function freshDb() {
  const sqlite = new DatabaseSync(':memory:');
  for (const dir of fs.readdirSync(MIGRATIONS_DIR).sort()) {
    const file = path.join(MIGRATIONS_DIR, dir, 'migration.sql');
    if (!fs.existsSync(file)) continue;
    for (const stmt of fs
      .readFileSync(file, 'utf8')
      .split('--> statement-breakpoint'))
      if (stmt.trim()) sqlite.exec(stmt);
  }
  return { sqlite, db: drizzle({ client: sqlite }) };
}

async function insertServer(db: ReturnType<typeof drizzle>): Promise<void> {
  await db.insert(servers).values({
    id: 'srv1',
    displayName: 'Survival',
    type: 'PAPER',
    mcVersion: '1.21.4',
    portGame: 25565,
    portRcon: 25575,
    rconPasswordCipher: 'x',
    heapMb: 1024,
    containerMemoryMb: 2048,
  });
}

class FakeApiCache {
  rows = new Map<string, { value: unknown; ageMs: number }>();
  get(key: string) {
    return Promise.resolve(this.rows.get(key) ?? null);
  }
  set(key: string, value: unknown) {
    this.rows.set(key, { value: structuredClone(value), ageMs: 0 });
    return Promise.resolve();
  }
}

type Route = (url: URL) => Response | null;
const toUrl = (input: string | URL | Request | globalThis.Request): URL =>
  new URL(
    typeof input === 'string' || input instanceof URL ? input : input.url,
  );

// --- normalized fixtures for the pickers --------------------------------

const hv = (
  name: string,
  versionType: HangarVersion['versionType'] = 'release',
  datePublished: string | null = null,
): HangarVersion => ({
  name,
  datePublished,
  versionType,
  channel: versionType === 'release' ? 'Release' : 'Snapshot',
  gameVersions: ['1.21'],
  downloadUrl: `https://hangarcdn.papermc.io/${name}.jar`,
  externalUrl: null,
  external: false,
  filename: `${name}.jar`,
  sizeBytes: 1,
  sha256: null,
});

const sv = (versionId: number, name: string): SpigetVersion => ({
  versionId: String(versionId),
  name,
  datePublished: null,
});

const gr = (
  tag: string,
  { prerelease = false, jars = ['plugin.jar'] } = {},
): GithubRelease => ({
  tag,
  name: tag,
  prerelease,
  publishedAt: null,
  htmlUrl: `https://github.com/o/r/releases/tag/${tag}`,
  assets: jars.map((name) => ({
    name,
    size: 1,
    downloadUrl: `https://github.com/o/r/releases/download/${tag}/${name}`,
    sha256: null,
  })),
});

describe('pickHangarUpdate', () => {
  const list = [
    hv('5.2.0-SNAPSHOT+3', 'alpha'),
    hv('5.2.0-SNAPSHOT+2', 'alpha'),
    hv('5.1.0'),
    hv('5.1.0-SNAPSHOT+9', 'alpha'),
    hv('5.0.0'),
  ];

  it('moves a release build to the newest release, past newer snapshots', () => {
    expect(pickHangarUpdate(list, '5.0.0', list[4]!)?.name).toBe('5.1.0');
  });

  it('moves a snapshot build to the newest build of any channel', () => {
    expect(pickHangarUpdate(list, '5.1.0-SNAPSHOT+9', list[3]!)?.name).toBe(
      '5.2.0-SNAPSHOT+3',
    );
  });

  it('reports nothing when the installed build is already the target', () => {
    expect(pickHangarUpdate(list, '5.1.0', list[2]!)).toBeNull();
    expect(pickHangarUpdate(list, '5.2.0-SNAPSHOT+3', list[0]!)).toBeNull();
  });

  it('never moves a snapshot install backwards', () => {
    // A snapshot follower on the newest snapshot: 5.1.0 is behind it.
    expect(pickHangarUpdate(list, '5.2.0-SNAPSHOT+2', list[1]!)?.name).toBe(
      '5.2.0-SNAPSHOT+3',
    );
    const onlyOlderRelease = [hv('5.3.0-SNAPSHOT+1', 'alpha'), hv('5.1.0')];
    expect(
      pickHangarUpdate(
        onlyOlderRelease,
        '5.3.0-SNAPSHOT+1',
        onlyOlderRelease[0]!,
      ),
    ).toBeNull();
  });

  it('treats an unknown installed build as release-channel', () => {
    expect(pickHangarUpdate(list, '4.9.0', null)?.name).toBe('5.1.0');
  });

  it('uses publish dates when the installed build is outside the list', () => {
    const newer = [hv('5.1.0', 'release', '2026-08-01T00:00:00Z')];
    const installed = hv('5.1.1', 'release', '2026-09-01T00:00:00Z');
    expect(pickHangarUpdate(newer, '5.1.1', installed)).toBeNull();
    const older = hv('5.0.0', 'release', '2026-07-01T00:00:00Z');
    expect(pickHangarUpdate(newer, '5.0.0', older)?.name).toBe('5.1.0');
  });
});

describe('pickSpigetUpdate', () => {
  const versions = [sv(648014, '5.5.71'), sv(600000, '5.5.0')];

  it('takes the highest version id when it is above the installed one', () => {
    expect(
      pickSpigetUpdate(versions, { versionId: '600000', name: '5.5.0' })
        ?.versionId,
    ).toBe('648014');
  });

  it('goes by id order, not by how the names compare', () => {
    // "5.5.0" sorts above "10.0" as a string and below it as semver; neither matters.
    const renamed = [sv(700000, '10.0'), sv(600000, '5.5.0')];
    expect(
      pickSpigetUpdate(renamed, { versionId: '600000', name: '5.5.0' })?.name,
    ).toBe('10.0');
  });

  it('never flags an installed id at or above the newest listed one', () => {
    expect(
      pickSpigetUpdate(versions, { versionId: '648014', name: 'x' }),
    ).toBeNull();
    expect(
      pickSpigetUpdate(versions, { versionId: '700000', name: 'y' }),
    ).toBeNull();
  });

  it('skips a re-upload under the same name, and falls back to names without an id', () => {
    expect(
      pickSpigetUpdate(versions, { versionId: '600000', name: '5.5.71' }),
    ).toBeNull();
    expect(
      pickSpigetUpdate(versions, { versionId: null, name: '5.5.0' })?.name,
    ).toBe('5.5.71');
  });
});

describe('pickGithubUpdate', () => {
  it('skips a newer pre-release for a stable install', () => {
    const releases = [
      gr('2.0.0-rc1', { prerelease: true }),
      gr('1.1.0'),
      gr('1.0.0'),
    ];
    expect(pickGithubUpdate(releases, '1.0.0')?.tag).toBe('1.1.0');
    expect(pickGithubUpdate(releases, '1.1.0')).toBeNull();
  });

  it('skips releases without jars', () => {
    const releases = [gr('1.2.0', { jars: [] }), gr('1.1.0'), gr('1.0.0')];
    expect(pickGithubUpdate(releases, '1.0.0')?.tag).toBe('1.1.0');
  });

  it('lets a pre-release install follow newer pre-releases', () => {
    const releases = [
      gr('2.0.0-rc2', { prerelease: true }),
      gr('2.0.0-rc1', { prerelease: true }),
      gr('1.1.0'),
    ];
    expect(pickGithubUpdate(releases, '2.0.0-rc1')?.tag).toBe('2.0.0-rc2');
  });

  it('never downgrades a pre-release install to an older stable', () => {
    const releases = [gr('2.0.0-rc1', { prerelease: true }), gr('1.1.0')];
    expect(pickGithubUpdate(releases, '2.0.0-rc1')).toBeNull();
  });

  it('treats a tag that fell out of the window as older than everything listed', () => {
    expect(pickGithubUpdate([gr('3.0.0')], '0.9.0')?.tag).toBe('3.0.0');
  });
});

describe('pickGithubUpdateAsset', () => {
  const jars = (...names: string[]) => gr('v1.3.0', { jars: names }).assets;

  it('keeps a version-less asset name', () => {
    expect(
      pickGithubUpdateAsset(
        jars('Geyser-Velocity.jar', 'Geyser-Spigot.jar'),
        'Geyser-Spigot.jar',
        'v1.2.0',
        'v1.3.0',
      )?.name,
    ).toBe('Geyser-Spigot.jar');
  });

  it('swaps the version inside a versioned asset name', () => {
    expect(
      pickGithubUpdateAsset(
        jars('Foo-fabric-1.3.0.jar', 'Foo-paper-1.3.0.jar'),
        'Foo-paper-1.2.0.jar',
        'v1.2.0',
        'v1.3.0',
      )?.name,
    ).toBe('Foo-paper-1.3.0.jar');
  });

  it("falls back to pickGithubAsset's default", () => {
    expect(
      pickGithubUpdateAsset(
        jars('Foo-1.3.0-sources.jar', 'Foo-1.3.0-all.jar'),
        'renamed.jar',
        'v1.2.0',
        'v1.3.0',
      )?.name,
    ).toBe('Foo-1.3.0-all.jar');
  });
});

// --- registry fixtures (raw API shapes) ---------------------------------

const hangarProject = {
  name: 'ViaVersion',
  namespace: { owner: 'ViaVersion', slug: 'ViaVersion' },
  description: 'x',
  avatarUrl: null,
  stats: { downloads: 1 },
};

const rawHangarVersion = (
  name: string,
  channel = 'Release',
  { hosted = true } = {},
) => ({
  name,
  createdAt: '2026-08-01T00:00:00Z',
  channel: { name: channel },
  platformDependencies: { PAPER: ['1.21'] },
  downloads: {
    PAPER: hosted
      ? {
          fileInfo: {
            name: `ViaVersion-${name}.jar`,
            sizeBytes: 5,
            sha256Hash: 'e'.repeat(64),
          },
          downloadUrl: `https://hangarcdn.papermc.io/ViaVersion-${name}.jar`,
          externalUrl: null,
        }
      : {
          fileInfo: null,
          downloadUrl: null,
          externalUrl: 'https://github.com/ViaVersion/ViaVersion/releases',
        },
  },
});

const spigetResource = ({ external = false, premium = false } = {}) => ({
  id: 28140,
  name: 'LuckPerms',
  tag: 'perms',
  downloads: 1,
  icon: { url: '' },
  // Stale on purpose: the server runs 1.21.4. Must not hide the update.
  testedVersions: ['1.8', '1.9'],
  external,
  premium,
  file: external
    ? { type: 'external', externalUrl: 'https://luckperms.net/download' }
    : { type: '.jar' },
});

const ghRepo = {
  full_name: 'EssentialsX/Essentials',
  name: 'Essentials',
  description: 'x',
  owner: { avatar_url: null },
};

const rawGhRelease = (tag: string, prerelease = false) => ({
  tag_name: tag,
  name: null,
  draft: false,
  prerelease,
  published_at: '2026-05-31T15:00:46Z',
  html_url: `https://github.com/EssentialsX/Essentials/releases/tag/${tag}`,
  assets: [
    {
      name: `EssentialsX-${tag}.jar`,
      size: 1,
      browser_download_url: `https://github.com/EssentialsX/Essentials/releases/download/${tag}/EssentialsX-${tag}.jar`,
      digest: null,
    },
  ],
});

/** Registry state the stubbed fetch serves; tests mutate it to "publish" builds. */
interface Registry {
  hangarVersions: unknown[];
  spigetResource: unknown;
  spigetVersions: unknown[];
  ghReleases: unknown[];
}

function registryRoutes(reg: Registry): Route[] {
  return [
    (u) =>
      u.pathname === '/api/v1/projects/ViaVersion'
        ? Response.json(hangarProject)
        : null,
    (u) =>
      u.pathname === '/api/v1/projects/ViaVersion/versions'
        ? Response.json({ result: reg.hangarVersions })
        : null,
    (u) => {
      const m = /^\/api\/v1\/projects\/ViaVersion\/versions\/(.+)$/.exec(
        u.pathname,
      );
      const name = m ? decodeURIComponent(m[1]!) : null;
      const found = (reg.hangarVersions as { name: string }[]).find(
        (v) => v.name === name,
      );
      return m
        ? found
          ? Response.json(found)
          : new Response(null, { status: 404 })
        : null;
    },
    (u) =>
      u.pathname === '/v2/resources/28140'
        ? Response.json(reg.spigetResource)
        : null,
    (u) =>
      u.pathname === '/v2/resources/28140/versions'
        ? Response.json(reg.spigetVersions)
        : null,
    (u) => {
      const m = /^\/v2\/resources\/28140\/versions\/(\d+)$/.exec(u.pathname);
      const found = m
        ? (reg.spigetVersions as { id: number }[]).find(
            (v) => v.id === Number(m[1]),
          )
        : null;
      return m
        ? found
          ? Response.json(found)
          : new Response(null, { status: 404 })
        : null;
    },
    (u) =>
      u.pathname === '/repos/EssentialsX/Essentials'
        ? Response.json(ghRepo)
        : null,
    (u) =>
      u.pathname === '/repos/EssentialsX/Essentials/releases'
        ? Response.json(reg.ghReleases)
        : null,
  ];
}

describe('update checks for Hangar / SpigotMC / GitHub content', () => {
  let sqlite: DatabaseSync;
  let db: ReturnType<typeof drizzle>;
  let cache: FakeApiCache;
  let reg: Registry;
  let fetchMock: jest.SpiedFunction<typeof fetch>;
  let checker: UpdateCheckerService;

  const serverVm = {
    id: 'srv1',
    display_name: 'Survival',
    type: 'PAPER',
    mc_version: '1.21.4',
  };

  beforeEach(async () => {
    ({ sqlite, db } = freshDb());
    cache = new FakeApiCache();
    reg = {
      hangarVersions: [
        rawHangarVersion('5.1.0-SNAPSHOT+3', 'Snapshot'),
        rawHangarVersion('5.0.1'),
        rawHangarVersion('5.0.0'),
      ],
      // External: an update can't be downloaded, but it must still be found.
      spigetResource: spigetResource({ external: true }),
      spigetVersions: [
        { id: 648014, name: '5.5.71', releaseDate: 2 },
        { id: 600000, name: '5.5.0', releaseDate: 1 },
      ],
      ghReleases: [
        rawGhRelease('2.21.0-dev+12', true),
        rawGhRelease('2.20.1'),
        rawGhRelease('2.20.0'),
      ],
    };
    const routes = registryRoutes(reg);
    fetchMock = jest.spyOn(global, 'fetch').mockImplementation((input) => {
      const url = toUrl(input);
      for (const r of routes) {
        const res = r(url);
        if (res) return Promise.resolve(res);
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    });

    await insertServer(db);
    const add = async (
      key: string,
      platform: string,
      projectId: string,
      fileId: string,
      version: string,
    ) => {
      await db.insert(libraryFiles).values({
        id: `lib_${key}`,
        category: 'plugin',
        name: key,
        filename: `${key}-${version}.jar`,
        relPath: `library/plugins/${key}.jar`,
        sha256: key.padEnd(64, '0'),
        sizeBytes: 1,
        platform,
        projectId,
        fileId,
        version,
      });
      await db.insert(serverContent).values({
        id: `sc_${key}`,
        serverId: 'srv1',
        libraryId: `lib_${key}`,
        kind: 'plugin',
        managedBy: 'overlay',
        name: key,
        filename: `${key}-${version}.jar`,
        version,
      });
    };
    await add('hangar', 'hangar', 'ViaVersion', '5.0.0', '5.0.0');
    await add('spiget', 'spiget', '28140', '600000', '5.5.0');
    await add('github', 'github', 'EssentialsX/Essentials', '2.20.0', '2.20.0');

    const apiCache = cache as unknown as ApiCacheService;
    const contentLatest = new ContentLatestService(
      {} as never, // modrinth: no Modrinth rows here
      {} as never, // curseforge
      new HangarApiService(apiCache),
      new SpigetApiService(apiCache),
      new GithubReleasesApiService(apiCache, {
        githubToken: null,
      } as unknown as ConfigService),
    );
    checker = new UpdateCheckerService(
      { db } as never,
      { recordEvent: () => undefined } as never,
      { listServers: () => Promise.resolve([serverVm]) } as never,
      { latestFor: () => Promise.resolve(null) } as never,
      contentLatest,
      { loaderOf: () => 'paper' } as never,
      apiCache,
    );
  });

  afterEach(() => {
    fetchMock.mockRestore();
    sqlite.close();
  });

  const outdated = async () =>
    Object.fromEntries(
      (await checker.listOutdated()).map((r) => [r.subjectId, r.latest]),
    );
  const checkRow = async (id: string) =>
    (
      await db.select().from(updateChecks).where(eq(updateChecks.subjectId, id))
    )[0];

  it('finds the next build per source, with the platform id in latest_version', async () => {
    const findings = await checker.checkAll();
    expect(findings.map((f) => f.latest).sort()).toEqual([
      '2.20.1',
      '5.0.1',
      '5.5.71',
    ]);
    expect(await outdated()).toEqual({
      sc_hangar: '5.0.1', // not the newer 5.1.0 snapshot
      sc_spiget: '5.5.71', // despite stale testedVersions and an external resource
      sc_github: '2.20.1', // not the newer pre-release
    });
    expect(await checkRow('sc_spiget')).toMatchObject({
      latestVersion: '648014',
      latestName: '5.5.71',
      changelogUrl: 'https://www.spigotmc.org/resources/28140/updates',
    });
    expect(await checkRow('sc_hangar')).toMatchObject({
      latestVersion: '5.0.1',
      changelogUrl:
        'https://hangar.papermc.io/ViaVersion/ViaVersion/versions/5.0.1',
    });
    expect((await checkRow('sc_github'))?.changelogUrl).toBe(
      'https://github.com/EssentialsX/Essentials/releases/tag/2.20.1',
    );
  });

  it('clears the row once the installed build is the newest', async () => {
    await checker.checkAll();
    await db
      .update(libraryFiles)
      .set({ fileId: '648014', version: '5.5.71' })
      .where(eq(libraryFiles.id, 'lib_spiget'));
    await db
      .update(serverContent)
      .set({ version: '5.5.71' })
      .where(eq(serverContent.id, 'sc_spiget'));
    await checker.checkAll();
    expect(await checkRow('sc_spiget')).toMatchObject({
      currentVersion: '5.5.71',
      latestVersion: null,
      latestName: null,
    });
    expect(Object.keys(await outdated())).not.toContain('sc_spiget');
  });

  it('ignored_version hides a build until a newer one supersedes it', async () => {
    await checker.checkAll();
    for (const id of ['sc_hangar', 'sc_spiget', 'sc_github'])
      await checker.ignoreUpdate('content', id);
    expect(await outdated()).toEqual({});
    expect(
      (await checker.listIgnored()).map((r) => r.subjectId).sort(),
    ).toEqual(['sc_github', 'sc_hangar', 'sc_spiget']);

    // A re-check that finds the same builds keeps them ignored.
    await checker.checkAll();
    expect(await outdated()).toEqual({});

    // New builds are published (and the cached registry answers expire).
    reg.hangarVersions.unshift(rawHangarVersion('5.0.2'));
    reg.spigetVersions.unshift({ id: 650000, name: '5.5.72', releaseDate: 3 });
    reg.ghReleases.unshift(rawGhRelease('2.20.2'));
    cache.rows.clear();
    await checker.checkAll();
    expect(await outdated()).toEqual({
      sc_hangar: '5.0.2',
      sc_spiget: '5.5.72',
      sc_github: '2.20.2',
    });
    expect(await checker.listIgnored()).toEqual([]);
    // The stale ignored id is left behind, harmless (UPDATES_NOTES.md).
    expect((await checkRow('sc_spiget'))?.ignoredVersion).toBe('648014');
  });

  it("ignores a snapshot or pre-release that isn't an update for a stable install", async () => {
    reg.hangarVersions = [
      rawHangarVersion('5.1.0-SNAPSHOT+3', 'Snapshot'),
      rawHangarVersion('5.0.0'),
    ];
    reg.ghReleases = [
      rawGhRelease('2.21.0-dev+12', true),
      rawGhRelease('2.20.0'),
    ];
    await checker.checkAll();
    expect(await outdated()).toEqual({ sc_spiget: '5.5.71' });
    expect(await checkRow('sc_hangar')).toMatchObject({
      currentVersion: '5.0.0',
      latestVersion: null,
    });
  });

  it("shares add-by-link's cached GitHub request instead of polling on its own", async () => {
    await checker.checkAll();
    await checker.checkAll();
    const ghCalls = fetchMock.mock.calls
      .map(([u]) => toUrl(u))
      .filter((u) => u.hostname === 'api.github.com');
    // One request for both runs, on the same URL (and so the same ETag cache
    // row) resolveGithub uses: getReleases' default window.
    expect(ghCalls.map((u) => `${u.pathname}${u.search}`)).toEqual([
      '/repos/EssentialsX/Essentials/releases?per_page=30',
    ]);
    expect(
      cache.rows.has(
        'github:/repos/EssentialsX/Essentials/releases?per_page=30',
      ),
    ).toBe(true);
  });

  describe('ModsService.updateRefFor', () => {
    let mods: ModsService;

    beforeEach(() => {
      const apiCache = cache as unknown as ApiCacheService;
      mods = new ModsService(
        { db } as never,
        {} as never,
        {} as never,
        { recordEvent: () => undefined } as never,
        {} as never,
        {} as never,
        {} as never,
        new HangarApiService(apiCache),
        new SpigetApiService(apiCache),
        new GithubReleasesApiService(apiCache, {
          githubToken: null,
        } as unknown as ConfigService),
        {
          getServer: () => Promise.resolve({ ...serverVm, env: {} }),
        } as never,
        {} as never,
        {} as never,
        {} as never,
      );
    });

    const lib = (
      platform: string,
      projectId: string,
      version: string,
      filename = 'x.jar',
    ) => ({ platform, projectId, fileId: version, version, filename });

    it('pins Hangar by owner/slug and version name, and it resolves to a download', async () => {
      const ref = await mods.updateRefFor(
        lib('hangar', 'ViaVersion', '5.0.0'),
        '5.0.1',
      );
      expect(ref).toBe(
        'https://hangar.papermc.io/ViaVersion/ViaVersion/versions/5.0.1',
      );
      await expect(mods.assertResolvable('srv1', ref)).resolves.toBeUndefined();
    });

    it('pins SpigotMC by version id; an external resource blocks the update', async () => {
      const ref = await mods.updateRefFor(
        lib('spiget', '28140', '600000'),
        '648014',
      );
      expect(ref).toBe(
        'https://www.spigotmc.org/resources/28140/?version=648014',
      );
      const err = await mods
        .assertResolvable('srv1', ref)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BlockedDownloadException);
      expect((err as BlockedDownloadException).blocked).toMatchObject({
        source: 'spiget',
        reason: 'external',
        version: '5.5.71',
      });
      expect((err as BlockedDownloadException).meta).toMatchObject({
        platform: 'spiget',
        projectId: '28140',
        fileId: '648014',
      });
    });

    it('blocks an externally-hosted Hangar build instead of downloading it', async () => {
      reg.hangarVersions.unshift(
        rawHangarVersion('5.0.2', 'Release', { hosted: false }),
      );
      const ref = await mods.updateRefFor(
        lib('hangar', 'ViaVersion', '5.0.0'),
        '5.0.2',
      );
      await expect(mods.assertResolvable('srv1', ref)).rejects.toBeInstanceOf(
        BlockedDownloadException,
      );
    });

    it('pins GitHub to the same jar variant as a download link', async () => {
      const ref = await mods.updateRefFor(
        lib(
          'github',
          'EssentialsX/Essentials',
          '2.20.0',
          'EssentialsX-2.20.0.jar',
        ),
        '2.20.1',
      );
      expect(ref).toBe(
        'https://github.com/EssentialsX/Essentials/releases/download/2.20.1/EssentialsX-2.20.1.jar',
      );
      await expect(mods.assertResolvable('srv1', ref)).resolves.toBeUndefined();
    });

    it('refuses platforms with no update source', async () => {
      await expect(
        mods.updateRefFor(lib('url', 'x', '1'), '2'),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });
});

describe('POST mods/update routing', () => {
  let sqlite: DatabaseSync;
  let db: ReturnType<typeof drizzle>;
  let mods: {
    updateRefFor: jest.Mock;
    assertResolvable: jest.Mock;
    removeContent: jest.Mock;
    installFromUrl: jest.Mock;
    setEnabled: jest.Mock;
  };
  let controller: ModsController;
  const req = { user: { username: 'alice' } } as unknown as Request;
  const REF = 'https://www.spigotmc.org/resources/28140/?version=648014';

  beforeEach(async () => {
    ({ sqlite, db } = freshDb());
    await insertServer(db);
    await db.insert(libraryFiles).values({
      id: 'lib1',
      category: 'plugin',
      name: 'LuckPerms',
      filename: 'LuckPerms-5.5.0.jar',
      relPath: 'library/plugins/lp.jar',
      sha256: 'a'.repeat(64),
      sizeBytes: 1,
      platform: 'spiget',
      projectId: '28140',
      fileId: '600000',
      version: '5.5.0',
    });
    await db.insert(serverContent).values({
      id: 'sc1',
      serverId: 'srv1',
      libraryId: 'lib1',
      kind: 'plugin',
      managedBy: 'overlay',
      name: 'LuckPerms',
      filename: 'LuckPerms-5.5.0.jar',
      version: '5.5.0',
      importId: 'imp1',
    });
    await db.insert(updateChecks).values({
      subjectType: 'content',
      subjectId: 'sc1',
      currentVersion: '5.5.0',
      latestVersion: '648014',
      latestName: '5.5.71',
    });
    mods = {
      updateRefFor: jest.fn().mockResolvedValue(REF),
      assertResolvable: jest.fn().mockResolvedValue(undefined),
      removeContent: jest.fn().mockResolvedValue({ freedBytes: 1 }),
      installFromUrl: jest.fn().mockResolvedValue({
        library: { name: 'LuckPerms', version: '5.5.71' },
        filename: 'LuckPerms-5.5.71.jar',
      }),
      setEnabled: jest.fn(),
    };
    controller = new ModsController(
      mods as never,
      { mustGet: () => Promise.resolve({ id: 'srv1' }) } as never,
      { db } as never,
      {} as never,
      {} as never,
    );
  });

  afterEach(() => sqlite.close());

  it('installs the checked build through the pinned link', async () => {
    const res = await controller.update(req, 'srv1', { contentId: 'sc1' });
    expect(mods.updateRefFor).toHaveBeenCalledWith(
      expect.objectContaining({ platform: 'spiget', projectId: '28140' }),
      '648014',
    );
    expect(mods.removeContent).toHaveBeenCalledWith(
      'srv1',
      'LuckPerms-5.5.0.jar',
      { actor: 'alice' },
    );
    expect(mods.installFromUrl).toHaveBeenCalledWith('srv1', REF, {
      actor: 'alice',
      kind: 'plugin',
      importId: 'imp1',
    });
    expect(res.installed.version).toBe('5.5.71');
  });

  it('answers a blocked build with the manual-upload payload and keeps the installed jar', async () => {
    mods.assertResolvable.mockRejectedValue(
      new BlockedDownloadException(
        {
          source: 'spiget',
          reason: 'premium',
          name: 'LuckPerms',
          version: '5.5.71',
          filename: null,
          pageUrl: 'https://www.spigotmc.org/resources/28140/',
          externalUrl: null,
          verifiable: false,
        },
        {},
      ),
    );
    const err = await controller
      .update(req, 'srv1', { contentId: 'sc1' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({
      statusCode: 409,
      updateRef: REF,
      blocked: { source: 'spiget', reason: 'premium', version: '5.5.71' },
    });
    expect(mods.removeContent).not.toHaveBeenCalled();
    expect(mods.installFromUrl).not.toHaveBeenCalled();
  });

  it('passes other resolve failures through untouched, still before removing anything', async () => {
    mods.assertResolvable.mockRejectedValue(new NotFoundException('gone'));
    await expect(
      controller.update(req, 'srv1', { contentId: 'sc1' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(mods.removeContent).not.toHaveBeenCalled();
  });

  it('needs a known newer build first', async () => {
    await db.delete(updateChecks);
    await expect(
      controller.update(req, 'srv1', { contentId: 'sc1' }),
    ).rejects.toThrow('run an update check first');
    expect(mods.updateRefFor).not.toHaveBeenCalled();
  });
});

describe('installManualUpload replacing an installed build (blocked update)', () => {
  let sqlite: DatabaseSync;
  let db: ReturnType<typeof drizzle>;
  let root: string;
  let jar: string;
  let imported: DownloadMeta[];
  let fetchMock: jest.SpiedFunction<typeof fetch>;
  let mods: ModsService;
  let setEnabled: jest.SpyInstance;
  const REF = 'https://www.spigotmc.org/resources/28140/?version=648014';

  beforeEach(async () => {
    ({ sqlite, db } = freshDb());
    await insertServer(db);
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cow-update-manual-'));
    jar = path.join(root, 'upload.tmp');
    fs.writeFileSync(jar, 'jar');
    const pluginsDir = path.join(root, 'servers', 'srv1', 'plugins');
    fs.mkdirSync(pluginsDir, { recursive: true });
    fs.writeFileSync(path.join(pluginsDir, 'LuckPerms-5.5.0.jar'), 'old');
    imported = [];

    const reg: Registry = {
      hangarVersions: [],
      spigetResource: spigetResource({ premium: true }),
      spigetVersions: [{ id: 648014, name: '5.5.71', releaseDate: 2 }],
      ghReleases: [],
    };
    const routes = registryRoutes(reg);
    fetchMock = jest.spyOn(global, 'fetch').mockImplementation((input) => {
      const url = toUrl(input);
      for (const r of routes) {
        const res = r(url);
        if (res) return Promise.resolve(res);
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    });

    const addRow = async (key: string, platform: string, projectId: string) => {
      await db.insert(libraryFiles).values({
        id: `lib_${key}`,
        category: 'plugin',
        name: key,
        filename: `${key}.jar`,
        relPath: `library/plugins/${key}.jar`,
        sha256: key.padEnd(64, '0'),
        sizeBytes: 1,
        platform,
        projectId,
        version: '5.5.0',
      });
    };
    await addRow('lp', 'spiget', '28140');
    await addRow('other', 'spiget', '1');
    await db.insert(serverContent).values([
      {
        id: 'sc_lp',
        serverId: 'srv1',
        libraryId: 'lib_lp',
        kind: 'plugin',
        managedBy: 'overlay',
        name: 'LuckPerms',
        filename: 'LuckPerms-5.5.0.jar',
        version: '5.5.0',
        enabled: false,
        importId: 'imp1',
      },
      {
        id: 'sc_other',
        serverId: 'srv1',
        libraryId: 'lib_other',
        kind: 'plugin',
        managedBy: 'overlay',
        name: 'Other',
        filename: 'Other.jar',
        version: '1',
      },
    ]);

    const apiCache = new FakeApiCache() as unknown as ApiCacheService;
    const library = {
      getLibraryFile: async (id: string) =>
        (
          await db.select().from(libraryFiles).where(eq(libraryFiles.id, id))
        )[0],
      importFile: (_p: string, meta: DownloadMeta) => {
        imported.push(meta);
        return Promise.resolve({ id: 'lib_new', ...meta });
      },
      fillMissingProvenance: (_id: string, meta: DownloadMeta) =>
        Promise.resolve({
          id: 'lib_new',
          name: meta.name,
          version: meta.version,
          iconUrl: null,
          sizeBytes: 1,
        }),
      installToServer: () =>
        Promise.resolve({
          installedPath: '/x',
          filename: 'LuckPerms-5.5.71.jar',
        }),
    };
    mods = new ModsService(
      { db } as never,
      { dataPath: (...parts: string[]) => path.join(root, ...parts) } as never,
      {
        assertUnderQuota: () => Promise.resolve(),
        scan: () => Promise.resolve(),
      } as never,
      { recordEvent: () => undefined } as never,
      library as never,
      {} as never,
      {} as never,
      new HangarApiService(apiCache),
      new SpigetApiService(apiCache),
      {} as never,
      {
        getServer: () =>
          Promise.resolve({
            id: 'srv1',
            type: 'PAPER',
            mc_version: '1.21.4',
            env: {},
          }),
      } as never,
      {} as never,
      {} as never,
      {} as never,
    );
    setEnabled = jest
      .spyOn(mods, 'setEnabled')
      .mockResolvedValue({ applied: 'instant' } as never);
  });

  afterEach(() => {
    fetchMock.mockRestore();
    sqlite.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const rows = async () =>
    (await db.select().from(serverContent)).map((r) => ({
      id: r.id,
      filename: r.filename,
      libraryId: r.libraryId,
      importId: r.importId,
    }));

  it('swaps the old build for the upload, keeping its import and disabled state', async () => {
    const res = await mods.installManualUpload(
      'srv1',
      jar,
      'LuckPerms-Bukkit-5.5.71.jar',
      REF,
      { actor: 'alice', replaceContentId: 'sc_lp' },
    );
    expect(res.filename).toBe('LuckPerms-5.5.71.jar');
    expect(imported[0]).toMatchObject({
      version: '5.5.71',
      category: 'plugin',
    });
    const after = await rows();
    expect(after.find((r) => r.id === 'sc_lp')).toBeUndefined();
    expect(
      after.find((r) => r.filename === 'LuckPerms-5.5.71.jar'),
    ).toMatchObject({ libraryId: 'lib_new', importId: 'imp1' });
    expect(
      fs.existsSync(
        path.join(root, 'servers', 'srv1', 'plugins', 'LuckPerms-5.5.0.jar'),
      ),
    ).toBe(false);
    expect(setEnabled).toHaveBeenCalledWith(
      'srv1',
      'LuckPerms-5.5.71.jar',
      false,
      {
        actor: 'alice',
      },
    );
  });

  it('refuses to replace content from a different project, before importing', async () => {
    await expect(
      mods.installManualUpload('srv1', jar, 'x.jar', REF, {
        replaceContentId: 'sc_other',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(imported).toHaveLength(0);
    expect((await rows()).map((r) => r.id).sort()).toEqual([
      'sc_lp',
      'sc_other',
    ]);
  });

  it('404s a row that is gone', async () => {
    await expect(
      mods.installManualUpload('srv1', jar, 'x.jar', REF, {
        replaceContentId: 'sc_missing',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(imported).toHaveLength(0);
  });
});
