import { Injectable, Logger } from '@nestjs/common';
import { SettingsService } from './settings.service';
import type { PanelUpdateStatus } from '../../../shared/types/settings';

export type { PanelUpdateStatus };

const PANEL_REPO = 'leocov-dev/craft-on-whales';
const RELEASES_LATEST_URL = `https://api.github.com/repos/${PANEL_REPO}/releases/latest`;
const UA =
  'craft-on-whales/panel-update-check (self-hosted panel; contact via repo)';

/** Re-check at most this often on a passive (page-load) call; "Check now" always bypasses this. */
const MIN_RECHECK_INTERVAL_MS = 60 * 60 * 1000;

const SETTINGS_KEY = 'panel_update_check';

/** What's persisted under `SETTINGS_KEY` via `SettingsService`. */
interface StoredPanelUpdateCheck {
  /** Latest published stable release tag, with any leading "v" stripped (e.g. "1.4.0"). Null if GitHub has no releases, or the last check failed with nothing ever cached. */
  latestVersion: string | null;
  /** Raw tag as GitHub returned it (e.g. "v1.4.0"). */
  latestTag: string | null;
  releaseName: string | null;
  releaseUrl: string | null;
  publishedAt: string | null;
  /** ISO timestamp of the last time a real GitHub lookup was attempted (success or failure). */
  checkedAt: string;
  /** Set when the most recent lookup failed; the other fields still hold the last known-good result. Cleared on the next success. */
  error: string | null;
}

/** "v1.2.3" or "1.2.3" -> [1,2,3]; anything else (pre-release-style tags, "dev", junk) -> null. */
function parseSemver(v: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** -1/0/1 when both sides parse as semver, else null — never guess on a shape we don't recognize. */
export function compareVersions(a: string, b: string): -1 | 0 | 1 | null {
  const av = parseSemver(a);
  const bv = parseSemver(b);
  if (!av || !bv) return null;
  for (let i = 0; i < 3; i++) {
    const x = av[i] ?? 0;
    const y = bv[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

interface GithubReleaseResponse {
  tag_name?: unknown;
  name?: unknown;
  html_url?: unknown;
  published_at?: unknown;
}

/**
 * Panel self-update check ("is a newer version of this panel published?").
 * See SETTINGS_NOTES.md for the full design writeup — in short: a purely
 * read-only comparison against GitHub's "latest release" endpoint (which
 * already excludes drafts and pre-releases on GitHub's side), cached in the
 * existing `settings` key/value store, with the same fetch/timeout/error-
 * swallowing shape as the other outbound API clients in this codebase
 * (ModrinthApiService, CurseforgeApiService, UpdateCheckerService). It never
 * touches any panel file — there is no apply/self-update path here or
 * anywhere else in this codebase.
 */
@Injectable()
export class PanelUpdateService {
  private readonly logger = new Logger(PanelUpdateService.name);

  constructor(private readonly settings: SettingsService) {}

  /** The panel's own running version. Baked into the container image at build time from the released git tag (see Dockerfile's APP_VERSION build ARG); "dev" for any build that didn't set it (local/manual runs), same convention the frontend footer already uses. */
  getCurrentVersion(): string {
    return (process.env.APP_VERSION || 'dev').trim() || 'dev';
  }

  /**
   * Current status, using the cached result unless it's stale (or `force` is
   * set). Never throws — a GitHub hiccup degrades to the last known-good
   * result (or an all-null result if nothing has ever succeeded) with
   * `error` set, so the Settings page always has something to render.
   */
  async check({
    force = false,
  }: { force?: boolean } = {}): Promise<PanelUpdateStatus> {
    const currentVersion = this.getCurrentVersion();
    const cached = await this.settings.get<StoredPanelUpdateCheck>(
      SETTINGS_KEY,
      null,
    );

    if (!force && cached) {
      const ageMs = Date.now() - Date.parse(cached.checkedAt);
      if (
        Number.isFinite(ageMs) &&
        ageMs >= 0 &&
        ageMs < MIN_RECHECK_INTERVAL_MS
      ) {
        return this.toStatus(currentVersion, cached);
      }
    }

    try {
      const release = await this.fetchLatestRelease();
      const stored: StoredPanelUpdateCheck = {
        latestVersion: release ? release.tag.replace(/^v/i, '') : null,
        latestTag: release ? release.tag : null,
        releaseName: release ? release.name : null,
        releaseUrl: release ? release.htmlUrl : null,
        publishedAt: release ? release.publishedAt : null,
        checkedAt: new Date().toISOString(),
        error: null,
      };
      await this.settings.set(SETTINGS_KEY, stored);
      return this.toStatus(currentVersion, stored);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Could not reach GitHub.';
      this.logger.warn(`Panel update check failed: ${message}`);
      const stored: StoredPanelUpdateCheck = {
        latestVersion: cached?.latestVersion ?? null,
        latestTag: cached?.latestTag ?? null,
        releaseName: cached?.releaseName ?? null,
        releaseUrl: cached?.releaseUrl ?? null,
        publishedAt: cached?.publishedAt ?? null,
        checkedAt: new Date().toISOString(),
        error: message,
      };
      // Persist even the failure so a Settings-page reload still shows "last
      // check failed" instead of silently pretending nothing was tried.
      await this.settings.set(SETTINGS_KEY, stored).catch(() => undefined);
      return this.toStatus(currentVersion, stored);
    }
  }

  private toStatus(
    currentVersion: string,
    stored: StoredPanelUpdateCheck | null,
  ): PanelUpdateStatus {
    const latestVersion = stored?.latestVersion ?? null;
    return {
      currentVersion,
      latestVersion,
      releaseName: stored?.releaseName ?? null,
      releaseUrl: stored?.releaseUrl ?? null,
      publishedAt: stored?.publishedAt ?? null,
      checkedAt: stored?.checkedAt ?? null,
      updateAvailable: latestVersion
        ? compareVersions(latestVersion, currentVersion) === 1
        : false,
      error: stored?.error ?? null,
    };
  }

  /**
   * GitHub's "latest release" endpoint (as opposed to `/releases`, newest
   * first) already excludes drafts and pre-releases server-side — exactly
   * the "newest stable release only" rule this feature needs, with no
   * client-side filtering to get wrong. Returns null when the repo has no
   * published releases at all (a 404 from this endpoint), which is a normal
   * "nothing to report" outcome, not an error.
   */
  private async fetchLatestRelease(): Promise<{
    tag: string;
    name: string | null;
    htmlUrl: string | null;
    publishedAt: string | null;
  } | null> {
    const res = await fetch(RELEASES_LATEST_URL, {
      headers: { 'User-Agent': UA, Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(
        `GitHub answered HTTP ${res.status} for the latest release`,
      );
    }
    const json = (await res.json()) as GithubReleaseResponse;
    const tag = typeof json.tag_name === 'string' ? json.tag_name : null;
    if (!tag) return null;
    return {
      tag,
      name: typeof json.name === 'string' ? json.name : null,
      htmlUrl: typeof json.html_url === 'string' ? json.html_url : null,
      publishedAt:
        typeof json.published_at === 'string' ? json.published_at : null,
    };
  }
}
