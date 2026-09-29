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
per-source dispatch in `ModsService` / `ModBrowserService` is where they meet. If 4.29 finds the
dispatch branches really do share a shape, extract it then, from the concrete code.

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
  so `getVersions()[0]` is often a snapshot. 4.29 should prefer the newest `release` when nothing
  is pinned. `getVersions` keeps externally-hosted builds so callers can offer them as manual
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

### Deferred to 4.29 (universal add-by-link)

4.28 built and registered the three clients (`ModsModule` providers and exports) and tested them.
**Nothing calls them yet.** 4.29 picks up here:

1. **`ModPlatform`** (`mods.types.ts`) is still `'modrinth' | 'curseforge'`. Add `'hangar'`,
   `'spiget'`, and `'github'`, and follow the type errors (the `server_content`/library `platform`
   columns, manifest entries, update checks).
2. **`ModsService.classifyModSource`**: route `hangar.papermc.io` → hangar, `spigotmc.org` →
   spiget, and `github.com` URLs plus bare `owner/repo` → github. Use `parseHangarRef`,
   `parseSpigetRef`, and `parseGithubRef`, which need no network. `owner/repo` can't collide with a
   Modrinth slug because Modrinth slugs have no `/`. Check it before the Modrinth-slug fallback.
3. **`ModsService.installFromUrl`**, one branch per source:
   - Hangar: `resolveUrl`, then `getVersion(slug, versionName)` if pinned, otherwise
     `getVersions(slug, { mcVersion })` and the newest `release`. Return 409 when `downloadUrl` is
     null (external). `expectedHash: hangarExpectedHash(v)`.
   - Spiget: `resolveUrl`. Return 409 with the page URL when the resource is `external` or
     `premium`. Pick `versionId` or `getVersions()[0]`, download from `downloadUrl(id, versionId)`,
     and leave `expectedHash` unset. Spiget gives no filename, so build one from the name and
     version.
   - GitHub: `resolveUrl`, `getReleases`, `pickGithubRelease(releases, tag)`,
     `pickGithubAsset(release.assets, asset)`. Use `expectedHash: githubAssetExpectedHash(a)`.
4. **`ModBrowserService` / `ModBrowserOrchestratorService`**: add Hangar and Spiget to plugin
   search and version listing. Neither publishes machine-readable dependencies, so their
   dependency closure is empty.
5. **Update checker** (`updates/`): newer-version checks for installed Hangar, Spiget, and GitHub
   content.
6. **Frontend**: Hangar and SpigotMC search chips on the Mods tab for plugin servers, the add-by-link
   copy listing every accepted form, and the manual-download fallback for external or premium
   Spiget resources and external Hangar versions.
