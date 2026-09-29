# Mods module notes

## Content-source clients (upstream parity 4.28)

Upstream reference: `anefzaoui/minecraft-server-manager` commits `e85b951` and `475aa85`
(`src/services/hangarApi.js`, `spigetApi.js`, `githubApi.js`, `test/sourceClients.test.js`). Read
for behavior only; nothing was ported.

Registry clients in this directory:

| Service                    | Source                           | Key                            |
| -------------------------- | -------------------------------- | ------------------------------ |
| `ModrinthApiService`       | Modrinth                         | none                           |
| `CurseforgeApiService`     | CurseForge                       | required (encrypted DB)        |
| `GtnhApiService`           | GT New Horizons                  | none                           |
| `PackwizApiService`        | packwiz `pack.toml` URLs         | none                           |
| `HangarApiService`         | Hangar (hangar.papermc.io)       | none                           |
| `SpigetApiService`         | SpigotMC, through the Spiget API | none                           |
| `GithubReleasesApiService` | GitHub Releases                  | none (`GITHUB_TOKEN` optional) |

### Why there's no shared `ContentSource` interface

Each client is its own `@Injectable()` with its own private fetch helper, Zod schemas, and
normalized types in `mods.types.ts`. That's how the four older clients were built, and the new three
follow suit. The sources don't share a shape worth abstracting over:

- Identifiers differ: Modrinth uses a string id or slug, CurseForge a numeric mod id plus file id,
  Hangar a slug plus version name, Spiget a numeric resource id plus version id, GitHub an
  `owner/repo` plus tag plus asset name.
- Compatibility data differs: per-version loader and MC tags (Modrinth, CurseForge), per-platform MC
  lists (Hangar), resource-level "tested versions" only (Spiget), or nothing (GitHub).
- Error and rate-limit behavior differs: GitHub uses ETag revalidation and an epoch-based reset
  header, Spiget answers an empty search with a 404, CurseForge needs a key.

A common interface would have to be the union of all of this or a lowest common denominator. The
per-source dispatch in `ModsService` / `ModBrowserService` is where they meet. 4.29 wired the
install side as one private `resolve<Source>()` per source in `ModsService`, each returning the same
`{ downloadUrl, meta: DownloadMeta }`. That return type is the only shape they share; the lookups
before it don't, so there's still no interface.

The fetch helpers (`hangarFetch`, `spigetFetch`, `ghFetch`) look almost the same as `mrFetch`. They
were left duplicated on purpose, matching the existing convention (see `ApiCacheService`'s header:
the cache read/write is shared, fetch and error handling stay per service). The one shared piece
is `source-url.util.ts`'s `parseSourceUrl`, which the three ref parsers use to match on the real
hostname instead of a substring, so `notgithub.com/a/b` isn't treated as a GitHub URL. Upstream
matched on substrings.

Each client has the same basic surface: `resolveUrl(input)` (a pasted URL or short ref, resolved to
the normalized project plus any version the URL pinned), `getProject`/`getResource`/`getRepo`,
`getVersions`/`getReleases`, and `search` where the source supports it. GitHub has no search: the
plugin catalog is Hangar and Spiget, and GitHub is add-by-link only. Pure parsers
(`parseHangarRef`, `parseSpigetRef`, `parseGithubRef`) are exported on their own so 4.29's
`classifyModSource` can route input without a network call.

### No SSRF or host allowlisting

These clients only call their own fixed API base URLs. The download URLs they return (Hangar CDN,
Spiget proxy, `github.com/.../releases/download/...`) are handed to `LibraryService` like any other
download. **Don't add URL, host, or IP allowlisting here.** It was removed on purpose in `3719117`;
see `library/LIBRARY_NOTES.md`.

### `GITHUB_TOKEN`: env var only

GitHub's REST API works without a token for public repos, but the unauthenticated quota is 60
requests/hour per IP. Two things make that livable:

1. **ETag revalidation.** `ghFetch` stores `{ etag, data }` in `api_cache` under `github:<path>`.
   Once a row is past its TTL, the client sends `If-None-Match`. A `304` doesn't count against the
   rate limit; the cached data is served and the row is re-stored so the TTL restarts. This fit
   `ApiCacheService`'s existing get/set cleanly, so we used it instead of the plain TTL recheck
   that `settings/panel-update.service.ts` uses.
2. **An optional `GITHUB_TOKEN`**, read once in `ConfigService` (`githubToken`) like the other plain
   env vars. It's sent as `Authorization: Bearer` only to `https://api.github.com`, and never on
   asset downloads.

It's env-only: no DB storage, no Settings UI, no encryption at rest. Upstream is keyless, the token
is optional, and a panel works fine without it. Operators who hit the limit are the kind who can set
an env var. A DB-stored, encrypted, UI-editable token like CurseForge's (`ApiKeysService`) would be
new surface with no concrete need behind it, which AGENTS.md's "no speculative configuration" rule
rules out. CurseForge is different because its API can't be used at all without a key.

A rate-limited response (429, or 403 with `x-ratelimit-remaining: 0`) serves stale cache if there is
any. Otherwise it's a 429 that says when the limit resets, plus a `GITHUB_TOKEN` hint if no token is
set. A 401 means the configured token was rejected.

### What each source guarantees about hashes

These feed `ExpectedHash` / `LibraryService.downloadToLibrary`'s verification (see
`library/LIBRARY_NOTES.md`). If a source has no hash, leave it unset; `downloadToLibrary` logs and
skips verification.

- **Hangar**: every Hangar-hosted file has `fileInfo.sha256Hash`. Use
  `hangarExpectedHash(version)`, which gives `{ algorithm: 'sha256' }`. Externally-hosted versions
  (`external: true`, only `externalUrl`) have no Hangar file and no hash, so it returns `null`.
- **Spiget**: no hashes at all, per resource or per version. There's no helper; leave
  `expectedHash` unset.
- **GitHub Releases**: GitHub computes a `digest` (`sha256:<hex>`) for release assets. The client
  parses it into `GithubReleaseAsset.sha256`, and `githubAssetExpectedHash(asset)` wraps it. Older
  assets that predate digests have `digest: null`, which gives `null`. Upstream didn't verify
  GitHub downloads at all; we do because the field is there.

### Behavior worth knowing

- **Hangar** only looks at the `PAPER` platform (`HANGAR_PLATFORM`); velocity and waterfall builds
  are ignored. `hangarCompatibleWith` accepts an exact MC match or a bare-minor tag prefix
  (`"1.21"` fits a 1.21.4 server, but `"1.2"` never matches 1.21.x). Channel names map to
  `versionType`: `Snapshot` or `Alpha` becomes `alpha`, `Beta` becomes `beta`, anything else is
  `release`. Many projects (ViaVersion, for example) publish snapshots more often than releases,
  so `getVersions()[0]` is often a snapshot, and add-by-link prefers the newest `release`. The
  catch-all means odd channel names (`DevBuilds`, `dev`, `Legacy`) also count as `release`. `getVersions` keeps externally-hosted builds so callers can offer them as manual
  downloads. Upstream dropped them when they had no MC tags.
- **Spiget** versions are sorted by `-id`, not `-releaseDate`. Live, `-releaseDate` put LuckPerms
  5.5.0 ahead of the newer 5.5.71. Ids only go up. Downloads go through
  `downloadUrl(resourceId, versionId?)`, Spiget's `/download/proxy` CDN endpoint, because
  spigotmc.org's own download links hit a Cloudflare challenge. Resources marked `external`
  (hosted off-site) or `premium` (paid) can't be proxied, and callers must treat them as manual
  downloads. Upstream only checked `external`. `parseSpigetRef` won't read `"1.21"` as resource 21:
  the `name.` prefix has to contain a non-digit.
- **GitHub** `getReleases` drops drafts and non-`.jar` assets, and uses the API's own
  `browser_download_url`. `pickGithubRelease` picks the explicit tag if one is given, otherwise the
  newest stable release with jars, falling back to the newest pre-release with jars.
  `pickGithubAsset` picks the preferred name (exact match, then substring), otherwise the first jar
  that isn't a `-sources`/`-javadoc`/`-dev`/`-api`/`-slim` sidecar.

## Universal add-by-link (upstream parity 4.29)

`ModsService.installFromUrl` accepts every source. `classifyModSource` routes by real hostname with
no network call:

| Input                                                    | Routed to  |
| -------------------------------------------------------- | ---------- |
| `modrinth.com/...`, bare slug                            | modrinth   |
| `curseforge.com/...`                                     | curseforge |
| `hangar.papermc.io/<owner>/<slug>[/versions/<v>]`        | hangar     |
| `spigotmc.org/resources/<name.>id[?version=<v>]`         | spiget     |
| `github.com/o/r[/releases[/tag/<t>]]`, `.jar` asset link | github     |
| bare `owner/repo`                                        | github     |
| any other URL, non-`.jar` GitHub asset links             | direct     |

- A URL pasted without `https://` works when it starts with a dotted host and a path
  (`github.com/o/r`). A slash can't appear in a Modrinth slug, so anything else with a `/` is
  either `owner/repo` or invalid.
- Non-jar GitHub release assets (a datapack `.zip`) stay `direct`. The GitHub client only lists
  `.jar` assets, and routing those links through it would break installs that worked before 4.29.
- Bare Spiget ids and bare Hangar slugs aren't routed: `28140` or `ViaVersion` would collide with
  Modrinth slugs. Paste the page URL.

Per source, on install:

- **Hangar**: a pinned version via `getVersion`. Otherwise `getVersions(slug, { mcVersion, limit: 50
})`, then the newest `release`, falling back to the newest of any channel. `limit: 50` because
  ViaVersion's newest release was 16th in the list, behind 15 snapshots. sha256 is verified.
- **Spiget**: `premium` and `external` resources return **409**, with the page URL or the resource's
  `file.externalUrl` (now on `SpigetResource.externalUrl`), before any download. A pinned
  `?version=` goes through a new `getVersion` (`/resources/{id}/versions/{vid}`), so pins older than
  the list window still work. Filename is `<name>-<version>.jar`, since Spiget gives none (the
  proxy does send `Content-Disposition`, but `LibraryService` doesn't read it). There's no hash, so
  `LibraryService` logs "unverified".
- **GitHub**: `pickGithubRelease` / `pickGithubAsset`. A download link names its asset exactly, so
  a missing asset is a 404, not a fallback to another jar. A pinned tag only matches within the 30
  most recent releases. The sha256 comes from `digest`.
- **Hangar and Spiget refuse non-plugin servers** (400, before any network call). They only host
  Paper/Spigot plugins, and unlike Modrinth there's no loader filter to fail on, so a Fabric server
  would otherwise get a Paper jar in `mods/`. GitHub isn't guarded, since it hosts both.

### Why Hangar's external builds are a 409 too

Checked live against the top ~100 Hangar projects: 34 had an externally-hosted newest build.
`externalUrl` is arbitrary. Sometimes it's a direct jar (ProtocolLib's GitHub asset, MythicMobs'
CDN). Often it's a page: a GitHub release tag (EssentialsX, Towny), a Modrinth version page, a
Jenkins job, Patreon (CoreProtect), a SpigotMC page, or dev.bukkit.org. There's no hash, and no
way to tell a file from a page without fetching it. So it's a 409 that names the URL, the same as
Spiget. Many of those URLs (GitHub, Modrinth, SpigotMC) can be pasted straight back into
add-by-link, which works today.

### Types

`ModPlatform` now has all five registries. `BrowsablePlatform` (`modrinth | curseforge`) is what
`ModBrowserService` and `refToUrl` take. Both are only reached through zod enums restricted to
those two, and widening their types would have let Hangar/Spiget silently fall into their
Modrinth `else` branches. `refToUrl` didn't gain the new platforms: its only callers
(`mods.controller.ts` update(), the orchestrator's from-mods flow) never see them.

### Still deferred

1. **Mod browser** (`ModBrowserService` / `ModBrowserOrchestratorService`, server-creation
   wizard): Hangar/Spiget search and version listing. Neither publishes machine-readable
   dependencies, so their dependency closure would be empty. Widen `BrowsablePlatform` then.
2. **Update checker** (`updates/`) and `mods.controller.ts` update(): newer-version checks and
   one-click updates for `hangar`/`spiget`/`github` library rows (they 409 "Cannot auto-update"
   today). `refToUrl` gains the new platforms at that point.
3. **Frontend**: Hangar/SpigotMC search chips, and the manual download fallback (open page +
   upload jar) for the 409s. That's upstream-parity 4.32. For now the add-by-link toast shows the
   409 message, URL included, and stays up until dismissed.

## Jar identification (upstream parity 4.30, phase 1)

Upstream reference: `anefzaoui/minecraft-server-manager` `407c328` (`src/services/modIdentify.js`,
`src/utils/murmur2.js`, `test/modIdentify.test.js`). Read for behavior only.

`JarIdentifierService` works out what a jar is, so a jar from a zip / `.mrpack` import (or a plain
upload) can become a tracked library row instead of an anonymous file. Nothing calls it yet; the
import pipeline is later phases of 4.30.

Layers, best first. Each one only sees the jars the previous ones missed:

1. **Modrinth by sha1**: `ModrinthApiService.getVersionsByHashes` (`POST /v2/version_files`), then
   `getProjects` (`GET /v2/projects?ids=`) for title, slug and icon.
2. **CurseForge by fingerprint**: `curseforgeFingerprint()` locally, then
   `CurseforgeApiService.getFingerprintMatches` (`POST /v1/fingerprints/432`, exact matches only),
   then `getMods` (`POST /v1/mods`).
3. **The jar's own manifest**: `readJarMetadata()` in `jar-metadata-reader.ts`.
4. Otherwise `source: 'unknown'`, named after the file.

Things worth knowing:

- **Batched.** `identifyMany` sends one request per layer (chunks of 200), not one per jar. Pass
  a whole pack at once. `identify` is a one-jar convenience.
- **Never throws for registry trouble.** A registry that's down, rate-limited or rejects the key is
  logged as a warning and skipped; the next layer still runs. A missing CurseForge key
  (`PreconditionFailedException` from `cfFetch`) is expected on many panels and is only a debug log,
  so without a key the chain is Modrinth, then manifest. The result doesn't say whether a layer was
  skipped.
- **Bulk lookups aren't cached.** `mrFetch` / `cfFetch` only cache GETs. `getProjects` is a GET
  and is cached like any other.
- **The fingerprint.** 32-bit MurmurHash2, seed 1, over the bytes with 0x09/0x0a/0x0d/0x20
  removed (and the stripped length as the hash's length). The spec pins it with SMHasher's
  verification value and fixtures from `meza/curseforge-fingerprint-go`, a port of CurseForge's own
  C++ code; two real CurseForge jars were checked locally too. Hashing the raw bytes never
  matches.
- **Manifest priority.** `fabric.mod.json`, `quilt.mod.json`, `META-INF/neoforge.mods.toml`,
  `META-INF/mods.toml`, `mcmod.info`, `paper-plugin.yml`, `plugin.yml`. The first one that parses
  supplies the fields; `loaders` lists every manifest present (a multi-loader jar reports all its
  loaders). Only root-level entries are read, so bundled jar-in-jar dependencies
  (`META-INF/jars/...`) don't masquerade as the jar. `${...}` build placeholders count as missing;
  a mods.toml version placeholder falls back to `Implementation-Version` in `MANIFEST.MF`.
  `plugin.yml` is read with the YAML failsafe schema so `version: 1.10` stays `"1.10"`.
- **Reuses `items/item-zip-parser.ts`'s `pickZipEntries`** (yauzl) rather than adding a zip reader.
  Nothing is extracted to disk, so `safe-zip-extractor.ts`'s path rules don't apply here.
- **`kind`.** Modrinth: `plugin` when every loader is a server-plugin platform. CurseForge: class
  5 (Bukkit Plugins). Manifest: `plugin.yml` / `paper-plugin.yml` are plugins.
- **`version` on CurseForge matches** is the file's display name (CurseForge has no separate
  version-number field), so expect things like `jei-1.20.1-forge-15.2.0.27.jar`.
