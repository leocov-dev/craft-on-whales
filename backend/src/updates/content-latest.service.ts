import { Injectable } from '@nestjs/common';
import { ModrinthApiService } from '../mods/modrinth-api.service';
import { CurseforgeApiService } from '../mods/curseforge-api.service';
import { HangarApiService, pickHangarUpdate } from '../mods/hangar-api.service';
import { SpigetApiService, pickSpigetUpdate } from '../mods/spiget-api.service';
import {
  GithubReleasesApiService,
  pickGithubUpdate,
} from '../mods/github-releases-api.service';
import type { GithubRelease, HangarVersion } from '../mods/mods.types';

/** The installed library row an update check looks at. */
export interface InstalledContent {
  platform: string | null;
  projectId: string;
  /** The installed build's platform id (Modrinth version id, CurseForge file id, Hangar version name, Spiget version id, GitHub tag). */
  fileId: string | null;
  /** The installed build's human-readable version, compared name-to-name. */
  version: string | null;
}

/** What the server constrains the lookup to, as for add-by-link. */
export interface ContentTarget {
  mcVersion?: string;
  loader?: string;
}

/**
 * The build to compare the installed one against: `id` in the platform's id
 * space (what `update_checks.latest_version` / `ignored_version` hold) and
 * `name` in the version-name space. A `name` equal to the installed version
 * means up to date.
 */
export interface ContentLatest {
  id: string;
  name: string;
  changelogUrl: string | null;
}

/**
 * Per-platform "what's the newest build of this installed content" for the
 * update checker. Modrinth/CurseForge take the first build the registry
 * returns for the server's loader and MC version; Hangar/Spiget/GitHub pick
 * with the `pick*Update` helpers next to their clients, which never return
 * something older than what's installed. See UPDATES_NOTES.md.
 */
@Injectable()
export class ContentLatestService {
  constructor(
    private readonly modrinth: ModrinthApiService,
    private readonly curseforge: CurseforgeApiService,
    private readonly hangar: HangarApiService,
    private readonly spiget: SpigetApiService,
    private readonly github: GithubReleasesApiService,
  ) {}

  /** null: nothing to compare against (unsupported platform, no builds) — leave the cached check alone. */
  async latestFor(
    row: InstalledContent,
    target: ContentTarget,
  ): Promise<ContentLatest | null> {
    switch (row.platform) {
      case 'modrinth':
        return this.latestModrinth(row.projectId, target);
      case 'curseforge':
        return this.latestCurseforge(row.projectId, target);
      case 'hangar':
        return this.latestHangar(row, target);
      case 'spiget':
        return this.latestSpiget(row);
      case 'github':
        return this.latestGithub(row);
      default:
        return null;
    }
  }

  private async latestModrinth(
    projectId: string,
    { loader, mcVersion }: ContentTarget,
  ): Promise<ContentLatest | null> {
    const versions = await this.modrinth.getVersions(projectId, {
      loader,
      mcVersion,
    });
    const first = versions[0];
    return first
      ? {
          id: first.id,
          name: first.version_number,
          changelogUrl: `https://modrinth.com/project/${projectId}/changelog`,
        }
      : null;
  }

  private async latestCurseforge(
    projectId: string,
    { loader, mcVersion }: ContentTarget,
  ): Promise<ContentLatest | null> {
    const files = await this.curseforge.getFiles(Number(projectId), {
      mcVersion,
      loader,
    });
    const first = files[0];
    return first
      ? {
          id: String(first.fileId),
          name: first.name,
          changelogUrl: `https://www.curseforge.com/projects/${projectId}`,
        }
      : null;
  }

  /** Same MC filter and 50-build window as add-by-link's resolveHangar. */
  private async latestHangar(
    row: InstalledContent,
    { mcVersion }: ContentTarget,
  ): Promise<ContentLatest | null> {
    const versions = await this.hangar.getVersions(row.projectId, {
      mcVersion,
      limit: 50,
    });
    const installedName = row.fileId ?? row.version;
    let installed: HangarVersion | null =
      versions.find((v) => v.name === installedName) ?? null;
    if (!installed && installedName)
      installed = await this.hangar
        .getVersion(row.projectId, installedName)
        .catch(() => null);
    const next = pickHangarUpdate(versions, installedName, installed);
    if (!next) return this.upToDate(row);
    const project = await this.hangar.getProject(row.projectId);
    return {
      id: next.name,
      name: next.name,
      changelogUrl: `https://hangar.papermc.io/${project.owner}/${project.slug}/versions/${encodeURIComponent(next.name)}`,
    };
  }

  private async latestSpiget(
    row: InstalledContent,
  ): Promise<ContentLatest | null> {
    const resourceId = Number(row.projectId);
    const next = pickSpigetUpdate(await this.spiget.getVersions(resourceId), {
      versionId: row.fileId,
      name: row.version,
    });
    if (!next) return this.upToDate(row);
    return {
      id: next.versionId,
      name: next.name,
      changelogUrl: `https://www.spigotmc.org/resources/${resourceId}/updates`,
    };
  }

  /**
   * getReleases' default window, so this shares add-by-link's ETag-cached
   * request. An installed tag outside that window costs one cached by-tag
   * lookup for its publish date (pickGithubUpdate's downgrade guard).
   */
  private async latestGithub(
    row: InstalledContent,
  ): Promise<ContentLatest | null> {
    const releases = await this.github.getReleases(row.projectId);
    const installedTag = row.fileId ?? row.version;
    let installed: GithubRelease | null =
      releases.find((r) => r.tag === installedTag) ?? null;
    if (!installed && installedTag)
      installed = await this.github
        .getReleaseByTag(row.projectId, installedTag)
        .catch(() => null);
    const next = pickGithubUpdate(releases, installedTag, installed);
    if (!next) return this.upToDate(row);
    return { id: next.tag, name: next.tag, changelogUrl: next.htmlUrl };
  }

  /** The installed build itself: the checker records "up to date". */
  private upToDate(row: InstalledContent): ContentLatest | null {
    if (!row.version) return null;
    return {
      id: row.fileId ?? row.version,
      name: row.version,
      changelogUrl: null,
    };
  }
}
