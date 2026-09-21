import { BadRequestException, Injectable } from '@nestjs/common';

export type PackPinPlatform = 'curseforge' | 'modrinth' | 'ftb' | 'gtnh';

export interface UnpinnedPackSelector {
  platform: PackPinPlatform;
  /** env key that would carry the version pin. */
  pinKey: string;
  /** The pack reference as it appears in env today (slug/id), lowercased for
   *  cross-checking against a `server_packs.project_ref` — null when the
   *  platform has nothing to compare (GTNH: the type alone selects the pack). */
  projectRef: string | null;
  message: string;
}

const has = (env: Record<string, string>, key: string): boolean =>
  env[key] != null && String(env[key]).trim() !== '';

/**
 * The panel's pinning invariant, checked in one place: a modpack/content
 * selector env var (CurseForge slug/page URL, Modrinth project, FTB pack id,
 * GTNH type) must always carry its version pin, or the itzg image
 * re-resolves "latest" on EVERY container start and silently upgrades the
 * server out from under its existing world — the upstream lost-worlds bug
 * (#21/#22). See `PACKS_NOTES.md` for the full write-path list this guards.
 *
 * `PacksService.applyPack()` always builds pinned env by construction and
 * never trips this — it exists for the write paths that bypass it: a raw
 * `POST/PATCH` env, or a blueprint import (which replays a server's exported
 * env through `ServerLifecycleService.createServer`, so it's covered here
 * for free rather than needing its own check).
 */
@Injectable()
export class PackPinGuardService {
  /** Detect env selectors that name a modpack platform but carry no version pin. */
  unpinnedSelectors(
    type: string,
    env: Record<string, string> = {},
  ): UnpinnedPackSelector[] {
    const issues: UnpinnedPackSelector[] = [];

    // CurseForge: a slug or page URL without CF_FILE_ID. A page URL naming a
    // specific file (…/files/<id>) is itself a pin, and CF_MODPACK_ZIP is a
    // fixed local file with nothing to resolve.
    if (
      (has(env, 'CF_SLUG') || has(env, 'CF_PAGE_URL')) &&
      !has(env, 'CF_MODPACK_ZIP')
    ) {
      const pagePinned =
        has(env, 'CF_PAGE_URL') && /\/files\/\d+/.test(String(env.CF_PAGE_URL));
      if (!has(env, 'CF_FILE_ID') && !pagePinned) {
        const projectRef =
          (env.CF_SLUG || '').trim().toLowerCase() ||
          (String(env.CF_PAGE_URL || '').match(/\/modpacks\/([^/?#]+)/i) ||
            [])[1]?.toLowerCase() ||
          null;
        issues.push({
          platform: 'curseforge',
          pinKey: 'CF_FILE_ID',
          projectRef,
          message:
            'The CurseForge modpack has no pinned file (CF_FILE_ID): the container would install the newest pack version on every start.',
        });
      }
    }

    // Modrinth: a project without MODRINTH_VERSION. A /version/ URL is a pin.
    if (has(env, 'MODRINTH_MODPACK')) {
      const urlPinned = /\/version\//.test(String(env.MODRINTH_MODPACK));
      if (!has(env, 'MODRINTH_VERSION') && !urlPinned) {
        const raw = String(env.MODRINTH_MODPACK).trim();
        const projectRef = (
          raw.includes('/') ? raw.split('/').filter(Boolean).pop() : raw
        )?.toLowerCase();
        issues.push({
          platform: 'modrinth',
          pinKey: 'MODRINTH_VERSION',
          projectRef: projectRef || null,
          message:
            'The Modrinth modpack has no pinned version (MODRINTH_VERSION): the container would install the newest pack version on every start.',
        });
      }
    }

    // FTB: pack id without a version id.
    if (has(env, 'FTB_MODPACK_ID') && !has(env, 'FTB_MODPACK_VERSION_ID')) {
      issues.push({
        platform: 'ftb',
        pinKey: 'FTB_MODPACK_VERSION_ID',
        projectRef: String(env.FTB_MODPACK_ID).trim().toLowerCase(),
        message:
          'The FTB modpack has no pinned version (FTB_MODPACK_VERSION_ID): the container would install the newest pack version on every start.',
      });
    }

    // GTNH: the type alone selects the pack; without GTNH_PACK_VERSION the
    // image installs the newest release on every start.
    if (type === 'GTNH' && !has(env, 'GTNH_PACK_VERSION')) {
      issues.push({
        platform: 'gtnh',
        pinKey: 'GTNH_PACK_VERSION',
        projectRef: 'gtnh',
        message:
          'The GTNH server has no pinned pack version (GTNH_PACK_VERSION): the container would install the newest release on every start.',
      });
    }

    return issues;
  }

  /** Reject an env write that would leave a pack selector unpinned. */
  assertPinned(type: string, env: Record<string, string> = {}): void {
    const issues = this.unpinnedSelectors(type, env);
    if (!issues.length) return;
    throw new BadRequestException(
      `${issues.map((i) => i.message).join(' ')} Pick a version in the modpack installer instead (or set ${issues
        .map((i) => i.pinKey)
        .join(', ')}).`,
    );
  }
}
