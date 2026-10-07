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
- **Spiget**: `premium` and `external` resources return a **409** `BlockedDownload` (see
  "Blocked-download fallback" below), with the page URL or the resource's `file.externalUrl`
  (now on `SpigetResource.externalUrl`), before any download. A pinned
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

`ModPlatform` now has all five registries. As of 4.29a, `BrowsablePlatform` is `modrinth |
curseforge | hangar | spiget` (see "Mod browser: Hangar and SpigotMC" below); `IdentifiedJar`
uses the narrower `HashLookupPlatform` (`modrinth | curseforge`), the only registries jar
identification can match.

### Still deferred

1. ~~**Update checker** and one-click updates for `hangar`/`spiget`/`github` rows.~~ Done in
   4.29b; see `updates/UPDATES_NOTES.md`, "Hangar, SpigotMC and GitHub content (4.29b)".
2. **Frontend**: Hangar/SpigotMC search chips. There is no mod-search UI to add them to; see the
   next section. (The manual download fallback for the 409s landed in 4.32, below.)

## Mod browser: Hangar and SpigotMC (4.29a)

Our own follow-up to 4.29, not an upstream item. Files: `mod-browser.service.ts`,
`mod-browser.controller.ts`, `mod-browser-orchestrator.service.ts` (`fromModsSchema`),
`ModsService.refToUrl`, `mod-browser.service.spec.ts`.

### There is no frontend for the mod browser

Checked on this branch, not taken on trust from earlier notes: nothing in `frontend/src` calls
`GET /api/mods/search`, `GET /api/mods/versions`, `POST /api/mods/deps`,
`GET /api/modrinth/search`, `GET /api/loaders/versions` or `POST /api/servers/from-mods`.
`WizardPage.vue` is a single form (no tabs, no "From mods" step), the Mods tab only has
add-by-link and zip import, and the Modpacks page's "Browse packs" is `/api/packs/search`
(modpacks, a different service). The legacy app had a "From mods" wizard; the Vue rewrite never
rebuilt it. So "wire Hangar/Spiget into the mod-browser UI" had no UI to wire into, and 4.29a
made the **API** complete instead. A "From mods" wizard UI in `frontend/` is unplanned future
work; when it's built, it gets all four sources from these routes as they are.

### What the routes accept now

- `platform` on `mods/search`, `mods/versions`, `mods/deps` and `servers/from-mods` is
  `BROWSABLE_PLATFORMS` (modrinth, curseforge, hangar, spiget). Search is still one platform per
  request, as before; there's no cross-platform merge.
- `loader` on those routes is `BROWSE_LOADERS`: the four mod loaders plus `paper`. `from-mods`
  already took `paper`; the browse routes didn't, which would have left Hangar/Spiget searchable
  only with no loader at all.
- `ref` per platform: Modrinth/CurseForge slug (unchanged), Hangar **`owner/slug`**, SpigotMC
  numeric resource id. Hangar's API only needs the slug, but `refToUrl` has to build a page URL
  (`hangar.papermc.io/<owner>/<slug>`) that `installFromUrl` can route, and a bare slug would
  parse as an owner with no project. `mods/versions` and `mods/deps` also take a bare Hangar slug
  (they go through `HangarApiService.resolveUrl`); `from-mods` refuses one (zod refine), since it
  builds the install URL from it. Search hits always carry `owner/slug`.
- Hangar `versionId` is the version name (unique per project, free text), so the `versionId`
  length cap went from 60 to 128. Spiget's is the numeric version id.

### Compatibility filtering, per source

- **Loader.** `platformServesLoader`: Hangar and Spiget only serve `paper` (or no loader filter).
  A Fabric/Forge/NeoForge/Quilt search or version list on them returns `[]` without a network
  call, so the wizard can't be offered a plugin it can't install. `from-mods` refuses Hangar/Spiget
  picks unless `loader` is `paper` (a 400 up front, rather than a created server whose installs all
  fail on `installFromUrl`'s plugin-registry guard). Modrinth/CurseForge with `paper` now search
  plugins (`kind: 'plugin'`; CurseForge's Bukkit Plugins class, with no mod-loader filter) instead
  of mods tagged "paper", which found nothing. Their version lists pass the loader through exactly
  as add-by-link's `resolveModrinth` / `resolveCurseforge` do.
- **MC version, Hangar.** The API filters search by `version`, and `getVersions` drops builds
  whose PAPER platform tags don't fit (`hangarCompatibleWith`; untagged builds are kept, as for
  add-by-link). `LATEST`/`SNAPSHOT` mean no filter, as for the other sources.
- **MC version, SpigotMC: not filtered.** Spiget has no per-version MC data and no search filter;
  the only signal is the resource's author-maintained `testedVersions`, which goes stale. Live
  (Sept 2026): Vault (34315) lists only 1.13 to 1.17 and still runs on 1.21; EssentialsX lists
  `1.20.6` but not `1.20`, so a strict match would hide it on 1.20.1. Filtering on it would hide
  exactly the most-used plugins. Instead each Spiget `ModVersion.gameVersions` carries the
  resource's `testedVersions` so a UI can show it, and search order is Spiget's `-downloads`.
  Add-by-link doesn't check it either.

### Normalized versions

- Hangar: `versionType` from the channel (as in `HangarApiService`), `gameVersions` = the PAPER
  tags, `downloadable: false` for an externally-hosted build.
- Spiget: `versionType: 'release'` (no channels), `downloadable: false` on every version of a
  premium or external resource.
- `downloadable: false` means install would answer the 409 `BlockedDownload`, the same meaning it
  already had for CurseForge files.
- `requiredDeps` is always `[]`: neither registry publishes machine-readable dependencies, so
  `resolveDependencies` never looks up versions for them and their closure is empty.

`refToUrl` now builds all four platforms' page URLs (Hangar `/versions/<name>`, SpigotMC
`?version=<id>`), round-trip tested against `parseHangarRef` / `parseSpigetRef`. Since 4.29b the
update route builds its link through `ModsService.updateRefFor`, which uses `refToUrl` for
Modrinth/CurseForge/SpigotMC and looks up the Hangar owner (library rows keep only the slug).

## Blocked-download fallback (upstream parity 4.32)

Upstream reference: 0.10.0, `test/modBrowser.test.js` ("marks CF files without a downloadUrl as not
downloadable") and `public/js/pages/mods.js` (`showManualFallback`, `showExternalFallback`). Read
for behavior only. Files: `blocked-download.exception.ts`, `ModsService.installManualUpload`,
the `mods/manual` route, `frontend/src/components/BlockedDownloadBanner.vue`.

### Which files are blocked

Three cases, one response. None of them is fetched another way: the point is that the panel
doesn't download these, so there's no fallback fetch, proxy or scrape, and no URL allowlisting
either (see `library/LIBRARY_NOTES.md`).

| Source     | Signal                                                     | `reason`                |
| ---------- | ---------------------------------------------------------- | ----------------------- |
| CurseForge | the chosen file has `downloadUrl: null`                    | `distribution-disabled` |
| SpigotMC   | the resource is `premium`                                  | `premium`               |
| SpigotMC   | the resource is `external`                                 | `external`              |
| Hangar     | the chosen build has no Hangar file, only an `externalUrl` | `external`              |

**CurseForge.** When a project's author turns off third-party distribution (the project's
`allowModDistribution`), the API still returns its files, with `downloadUrl: null`. Nothing new had
to be detected: `CurseforgeApiService.normalizeFile` already kept the null, and
`resolveCurseforge` already threw a bare 409 ("disallows automated downloads"). What went wrong
was downstream: `http.ts` showed a Nest error's `error` field, which is only the status name, so
the Mods tab toast just said "Conflict". Every 409 from 4.29 had the same problem. `http.ts` now
prefers `message`. `ModBrowserService.normCurseforgeFile` already exposes the same signal as
`downloadable: false`, but no frontend reads it yet (there is no mod-browser UI in `frontend/`;
see "Mod browser: Hangar and SpigotMC").

The file's hashes are still there on a blocked file, so a CurseForge upload can be verified. The
panel doesn't fall back to an older distributable file when the newest match is blocked:
installing something other than what the link resolves to would be a surprise, and upstream
doesn't either. The user can paste a `/files/<id>` link for a specific file.

Live-checked for Spiget (a premium resource, VoteParty `987`, and an external one, SkinsRestorer
`2124`) and Hangar (EssentialsX, whose builds are on GitHub). CurseForge only in tests: there
was no API key available to check a real distribution-disabled project.

### The response

`resolveCurseforge` / `resolveHangar` / `resolveSpiget` throw `BlockedDownloadException`, a
`ConflictException` whose body is:

```ts
{ statusCode: 409, error: 'Conflict', message, blocked: BlockedDownload }
// BlockedDownload (shared/types/mods.d.ts):
{ source: 'curseforge' | 'hangar' | 'spiget',
  reason: 'distribution-disabled' | 'external' | 'premium',
  name, version: string | null, filename: string | null,
  pageUrl,               // the registry page (for CurseForge and Hangar, the file's own page)
  externalUrl: string | null, // where it's hosted instead; may be a page, not a file
  verifiable: boolean }  // the upload will be checked against a registry hash
```

`message` is still a full sentence with the link, for any caller that only shows text (the
from-mods wizard task's `failed` list, for one). The exception also carries the `DownloadMeta`
the file would have been installed with. That stays server-side: `AllExceptionsFilter` only sends
`getResponse()`.

`externalUrl` is whatever the project's author entered, and the UI renders it as a link. Anything
that isn't `http(s)://` is dropped to `null` in the exception, and the component checks again
before binding the `href`.

Spiget: a blocked resource still gets its version looked up (newest, or the `?version=` pin) so
the banner can say which version to fetch and the upload gets a `fileId`. A failed lookup only
leaves `version` null; it never turns the 409 into a 404.

### Completing the install: `POST /api/servers/:id/mods/manual`

`content` permission. Multipart: `file` (the jar, `.jar`/`.zip`, 250 MB like `mods/upload`),
`url` (the same add-by-link input that was blocked), optional `kind`. Response:
`{ ok, installed: { name, filename, version }, verified }`.

Why the link and not the `blocked` payload or a token:

- **The client never supplies provenance.** The backend resolves `url` again with the same
  routing and guards as add-by-link (`resolveForServer`), catches the `BlockedDownloadException`,
  and uses its `meta`. So the platform, project id, file id, version and hash in the library row
  come from the registry. Registry lookups are cached, so this is usually free.
- **No new server state.** A token would need an in-memory or DB table of pending blocked installs,
  with expiry. Re-resolving the link needs nothing.
- If the link has become downloadable since, the resolve succeeds and the upload is still accepted
  against that metadata (and hash).

Then:

1. **Hash check** when the registry has one (CurseForge sha1/md5; a Hangar-hosted build's sha256
   if it ever gets here). A mismatch is a 400 naming the expected file, before anything reaches
   the library. A verified upload takes the registry's filename, since browsers rename a repeat
   download to `name (1).jar`.
2. `LibraryService.importFile` (sha256 dedupe), then `fillMissingProvenance` with the resolved
   `meta`, so the row is tied to its project like any add-by-link install.
3. `addLibraryContent`: quota check, link into `mods/` or `plugins/` (`contentDir` for the server's
   type and `kind`), overlay row.

Hangar and Spiget have no hash, so their uploads are unverified: the user's word, the same as
`mods/upload`. The row still gets the registry provenance, which is what the user said they
downloaded. That's the only cost of taking their word: a wrong jar would be labelled as the
project.

**Why the uploaded jar isn't run through `JarIdentifierService`.** For CurseForge, the hash check
is stronger than any identification: it proves the jar is exactly the blocked file. For
Hangar/Spiget, identification would mostly fall through to the jar's own `plugin.yml`, which only
confirms it's some plugin. A Modrinth or CurseForge match would name a different platform than
the link the user pasted. And the wrong-kind case it could catch (a Fabric mod uploaded to a Paper
server) is already ruled out: the plugin-registry guard refuses Hangar/Spiget links on
non-plugin servers before anything else runs.

### Updates

`POST .../mods/update` removes the old jar and then installs the new one. A manually uploaded
CurseForge jar has full provenance, so the update checker can offer a newer file, which will
usually be blocked too. The route now calls `ModsService.assertResolvable` on the target before
removing anything, so a blocked (or missing) update is a 409 (or 404) with the installed jar left
alone.

Since 4.29b the same applies to Hangar external builds and SpigotMC premium/external resources,
and the update route's blocked 409 also carries `updateRef`, the pinned link for that build. The
Updates page shows `BlockedDownloadBanner` with it and posts the upload to `mods/manual` with
`replaceContentId`, which swaps the installed row for the upload. See
`updates/UPDATES_NOTES.md`.

### UI

`ModsTab.vue`'s add-by-link: a 409 with `blocked` (`blockedDownloadOf(err)` in `api/mods.ts`) shows
`BlockedDownloadBanner` under the input instead of a toast. It gives the reason, "Open
CurseForge/Hangar/SpigotMC" (`pageUrl`), "Open download site" (`externalUrl`, when there is one),
a `q-file` and "Upload & install". A successful upload clears the banner and the input and reloads
the list. `ApiError` now carries the parsed error `body` so structured errors reach the page.

Not covered: the server-creation wizard's "From mods" flow (no frontend for it yet; its task
`result.failed` carries the blocked message) and blueprint imports (`blueprint-import.service.ts`
keeps its own "install it manually" failure).

## Jar identification (upstream parity 4.30, phase 1)

Upstream reference: `anefzaoui/minecraft-server-manager` `407c328` (`src/services/modIdentify.js`,
`src/utils/murmur2.js`, `test/modIdentify.test.js`). Read for behavior only.

`JarIdentifierService` works out what a jar is, so a jar from a zip / `.mrpack` import (or a plain
upload) can become a tracked library row instead of an anonymous file. `ContentImportService` (next
section) is its caller.

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

## Zip / .mrpack import (upstream parity 4.30, phase 2)

Upstream reference: `407c328` and `c51123b` (`src/services/contentZip.js`, `test/contentZip*.test.js`).
Read for behavior only. Files:

- `pack-archive.ts`: pure parsing. `parseMrpackIndex`, `describeStagedPack` (what an extracted
  archive is), `contentJarName`.
- `pack-overrides.service.ts`: `PackOverridesService`, which applies and reverts override trees.
- `content-import.service.ts`: `ContentImportService`, the pipeline, plus `jarMisfit`.
- Routes in `mods.controller.ts`. Response types in `shared/types/mods.d.ts` (`ContentImport*`).

### Accepted archives

The upload is extracted with `extractZipSafely` into `data/tmp/import-<id>/` (8 GiB cap, the same as
blueprint import) and removed when the import ends. Nothing reaches the server directory until the
archive has fully extracted.

- **`.mrpack`**: `modrinth.index.json` at the root. It must have `game: "minecraft"` and a `files`
  array of at most 1000 entries. A broken index is a 400; it doesn't fall through to "jar zip".
  - Entries with no path, no download or no sha1/sha512 are dropped and counted in a warning.
  - `env.server: "unsupported"` is skipped as `client-only`.
  - Only `mods/<name>.jar` and `plugins/<name>.jar` install. Anything else (resource packs, shader
    packs, nested paths) is skipped as `not-a-mod`. Only the basename is used as a filename.
  - Each file is fetched with `LibraryService.downloadToLibrary`, verified against the index's
    sha512 (sha1 if that's all it has). The listed URLs are tried in order. Four downloads run
    at a time.
  - Override trees: `overrides/`, then `server-overrides/`, so the server copy of a path wins.
    `client-overrides/` is never applied.
- **Jar zip**: anything else with at least one jar or an `overrides/` tree. Every `*.jar` outside
  `overrides/` counts, at any depth (at most 500). `__MACOSX/` and dot-paths are ignored. An
  `overrides/` tree is applied like a `.mrpack`'s.
- In either shape, a jar directly in an override tree's `mods/` or `plugins/` is installed as
  tracked content rather than copied as an anonymous override file. Real `.mrpack`s often bundle
  non-Modrinth mods that way.
- **Not supported: CurseForge `manifest.json` exports.** Upstream handles them. Doing so needs a
  bulk `getFiles` on `CurseforgeApiService` (it has none), a key, and a blocked-download flow. A
  CurseForge export zip contains no jars, so today it's rejected as unrecognized unless it has
  `overrides/`, in which case only the overrides apply.

### Install

The jars from both sources are identified in **one** `JarIdentifierService.identifyMany` call.
That means every jar is in memory at once, bounded by the 1000/500 caps. Then each jar either
installs or is skipped:

- **Skip rules.** `already-installed`: the filename is already in the content dir, on disk or as a
  row. Imports never overwrite an existing jar, because a revert would then delete the user's own
  file. `duplicate`: the same filename came earlier in the archive (bundled jars come first).
  `wrong-kind` / `wrong-loader`: see `jarMisfit`. Only positive evidence skips a jar. An unknown
  jar, or one with no loader data, installs. Quilt accepts Fabric jars. Minecraft version is never
  checked per jar; a `.mrpack` whose `dependencies` disagree with the server gets a warning.
- **Library.** Bundled jars go through `LibraryService.importFile` and downloads are already in the
  library. When identification found a registry match, `LibraryService.fillMissingProvenance`
  gives the row its platform, project and version ids (only if it had no `projectId`). That makes
  the jar update-checkable like an add-by-link install.
- **Row.** `ModsService.addLibraryContent` does the quota check, links the file and upserts the
  row. It's the tail `installFromUrl` now shares. Imported jars are ordinary `managedBy: 'overlay'`
  rows with `import_id` set. They are not `'pack'`: that value means content itzg's pack installer
  owns, which the panel can't delete and toggles through exclusion env vars. Imported jars
  toggle, update, delete and get re-applied like any overlay jar. `update()` passes the row's
  `importId` through `installFromUrl`, so an updated jar stays part of its import.
- Jar failures (download, checksum, install) are collected in `failed` and the import carries on,
  like upstream.

### Reversible overrides

Upstream copies files it would overwrite to a timestamped `.import-backups/` directory and leaves
undoing to the user. Here the import records what it wrote so it can be undone:

- **`content_imports`**: one row per import (server, format, name, version, actor). A
  `server_content.import_id` column points back at it. It has no FK, like `library_id`.
- **`content_import_overrides`**: one row per file written, with `rel_path`, the `sha256` of the
  content written, and `had_original`.
- **Apply.** Paths are relative to the server dir and resolved with
  `PathGuardService.safeJoin(serverDir, rel)`. That also refuses a path that would leave through a
  symlinked directory already in the server dir. For each file, in order: back up an existing
  file to `<server>/.import-backups/<importId>/<rel>`, insert the tracking row, then write. The row
  goes in before the write, so a crash in between leaves a row whose hash doesn't match, which
  revert treats as "changed since" and leaves alone. Any error reverts the whole apply. The jars
  stay installed and the report gets a warning.
  - A path under `.import-backups/` is skipped as `reserved`.
  - A path where a directory or symlink sits is skipped as `not-a-file`.
  - The total size is checked against the disk quota first.
- **Revert** (`DELETE .../mods/imports/:importId`). All the import's remaining rows are removed
  through `ModsService.removeContent`, then each tracked file is handled:
  - It still hashes to what the import wrote: restore the backup if `had_original`, otherwise
    delete it and prune now-empty parent directories.
  - Anything else (edited, deleted, or the backup is gone): `kept`, left untouched.

  Then the backup directory and tracking rows go, and the `content_imports` row with them.

- **Stacking.** A second import that overwrites the first's file backs up the first's content as
  its original. Removing them newest-first restores everything exactly. Removing the older one
  first keeps the newer content (the hash differs) and drops the older backup. Removing the newer
  one then restores the older import's content, not the pre-import original.
- **Why removing one jar doesn't revert the import.** Deleting a single imported jar with the
  normal delete route only removes that jar. Overrides belong to the pack, not to one jar. Also,
  `update()` is remove-then-install, and a "last jar removed" cascade would silently revert config
  files in the middle of an update. Undo is the explicit import removal.
- Only one import or removal runs per server at a time (409 otherwise). This is an in-process
  `Set`, like the other per-server guards.

### API (for the Mods-tab UI)

- **`POST /api/servers/:id/mods/import`**: `content` permission. Multipart fields:
  - `file`: `.zip` or `.mrpack`, at most 1 GiB. A `.mrpack` is small; a jar zip carries whole jars.
  - `applyOverrides`: `"true"` (default) or `"false"`.

  The server, file extension and packwiz check are validated up front (400/404/409). The import
  then runs as a task: the response is `{ ok: true, taskId }`. Poll `GET /api/tasks/:taskId`.
  The task's `step` (`stepLabel` inside `TasksService`) carries progress ("Downloading files
  (3/40)", "Installing 5/40: Sodium"). A
  finished task's `result` is a `ContentImportReport`:

  ```ts
  {
    import: ContentImportSummary | null, // null: nothing installed or written, no row kept
    pack: { format: 'mrpack' | 'jars', name, version, mcVersion, loader, loaderVersion },
    installed: { contentId, filename, path, name, version, kind, origin: 'bundled' | 'download',
                 source: 'modrinth' | 'curseforge' | 'metadata' | 'unknown',
                 platform, projectId, iconUrl }[],
    skipped: { name, path, reason: 'client-only' | 'not-a-mod' | 'wrong-kind' | 'wrong-loader'
                                  | 'already-installed' | 'duplicate', detail? }[],
    failed: { name, path, error }[],
    overrides: { applied: boolean,
                 written: { path, action: 'created' | 'replaced' }[],
                 skipped: { path, reason: 'not-a-file' | 'reserved' | 'disabled' }[] },
    warnings: string[], // MC/loader mismatch, unusable index entries, overrides apply failure
  }
  ```

  `source` is the identification confidence: `modrinth`/`curseforge` are exact hash matches,
  `metadata` comes from the jar's own manifest, and `unknown` is the filename only.

- **`GET /api/servers/:id/mods/imports`**: `view`. Returns `{ ok, imports: ContentImportSummary[] }`,
  newest first. Each summary has `id, format, name, version, actor, createdAt, contentCount,
overrideCount` (live counts).
- **`DELETE /api/servers/:id/mods/imports/:importId`**: `content`. Returns
  `{ ok, removedContent: string[], overrides: { restored, deleted, kept } }`.
- `GET /api/servers/:id/mods` rows now carry `importId`, so the UI can group a pack's jars.

Task polling goes through `TasksController`, which only admins and operators can use. That's the
same as every other task-driven action.

### Mods-tab UI (upstream parity 4.30, phase 3)

Files: `frontend/src/pages/server/ModsTab.vue`, `components/ModImportReportDialog.vue`,
`components/ModImportsDialog.vue`, `api/mods.ts` (`importPack`, `listImports`, `deleteImport`).

- **Upload** is a `q-file` plus an "Apply overrides" toggle on a row under add-by-link, hidden on
  packwiz servers like add-by-link. It posts through `http.postForm`, which reuses `http.ts`'s
  error handling for multipart bodies instead of another hand-rolled `fetch`.
- **Progress** comes from `tasksApi.waitFor`'s `onProgress` callback, which sees every poll.
  The tab shows `task.step` and `task.percent` (indeterminate when null).
- **Report** opens in a dialog when the task finishes. Skip reasons and identification sources map
  to fixed labels (`SKIP_LABELS`, `SOURCE_LABELS`). A new `ContentImportSkipReason` or
  `JarIdentitySource` value is a type error there until it gets a label.
- **Grouping.** `load()` fetches `GET .../mods/imports` with the list. Rows with an `importId`
  are grouped under a "From <pack>" header, newest import first, after the individually added
  rows. Each imported row also carries a badge with the pack name. With no imports the list looks
  the same as before.
- **Revert** is the "Imports" dialog. Its confirmation spells out what removal does (see
  "Reversible overrides" above). A non-empty `kept` shows a persistent warning naming the files.
- **`createdAt` has no zone.** `content_imports.created_at` is SQLite `datetime('now')`, UTC as
  `YYYY-MM-DD HH:MM:SS`. `new Date()` reads that as local time, so the dialog appends `Z` when
  the value has no zone.

## Create a server from a zip (upstream parity 4.31)

Upstream reference: `8a7c330` (`contentZip.previewStandalone`, `POST /api/servers/from-zip`, the
wizard's "Custom zip" card). Read for behavior only. Files: `server-from-zip.service.ts`
(`ServerFromZipService`, `inferZipTarget`, `fromZipSchema`), the route in
`mod-browser.controller.ts` next to `from-mods`, `frontend/src/components/CreateFromZipPanel.vue`
(the Modpacks page's "Upload zip" tab) and `frontend/src/utils/zip-server.ts`.

### What it is, and what it isn't

The same archives the Mods-tab import takes (a `.mrpack` or a jar zip, see above), installed into
a server created for them. It is not blueprints: a blueprint (`.mcserver.zip`, `manifest.json`
with `msm: 1`) is the panel's own full-server snapshot and has its own import in `blueprints/`.
Nothing here touches that. It's also not the Modpacks page's pinned pack install: a `.mrpack`
upload becomes a plain FABRIC/FORGE/... server with overlay content, not a `MODRINTH`-type server
itzg installs. An uploaded pack has no published version to pin or upgrade to.

### One endpoint, one task

`POST /api/servers/from-zip`, multipart: `file` plus `name`, `loader` (`auto` default, or
fabric/quilt/forge/neoforge/paper), `mcVersion` (blank = auto), `applyOverrides`, and the
optional `portGame` / `diskQuotaGb` / `heapMb` / `containerMemoryMb`. Same auth as `from-mods`
and `from-pack`: any non-viewer (there's no per-server permission before the server exists). The
upload cap is the Mods-tab import's (`IMPORT_MAX_BYTES`). The response is `{ ok, taskId }`; the
task's `result` is a `ServerFromZipResult` (`shared/types/mods.d.ts`): `serverId`, `name`,
`target` (loader, MC version, loader build), the `ContentImportReport`, and `startError`.

Why not "create the server, then call `POST .../mods/import`" from the browser? It would reuse
the same code, but:

- The loader and version have to be known before the server is created, and for a jar zip that
  means identifying the jars, which only the backend can do. A client-side sequence would need a
  preview endpoint that parks the upload under a token (upstream's two-phase design, and what
  blueprint import does), and then upload again or keep the token alive.
- The content has to be in place before first boot (as in `from-mods`), so the client would also
  have to create stopped, import, then start: three round trips.
- If the browser tab closes midway, the half-made server is left behind with nothing to clean it
  up. In a task, cleanup is a `try`/`catch` next to the create.

So there's a new endpoint, but nearly no new pipeline: `ContentImportService` was split into
`stage()` (extract + `describeStagedPack`), `identifyBundled()`, `importStaged()` and `discard()`.
`importArchive()` (the Mods tab) is now `stage` → install → `discard`, with the same behavior.

The task runs:

1. **Stage** the archive into `data/tmp/import-<id>/`. A broken or unrecognized archive fails here.
2. **Target.** `inferZipTarget` fills in whatever was left on auto. If anything can't be
   determined it throws 400 and the task fails. Nothing has been created yet.
3. **Create** the server stopped (`start: false`), `type` = loader upper-cased, `VERSION` = the
   MC version, and the loader-build env var (`envKeyFor`) when there's a build to set.
4. **Import** with `importStaged`, same report as the Mods tab.
5. **Start.**

### Failure handling

- Anything that rejects the archive or the target happens before step 3, so no server exists.
- Per-jar failures (a dead download, a checksum mismatch) are in the report and don't stop
  anything, like the Mods tab and `from-mods`. The server keeps whatever did install.
- If `importStaged` itself throws (quota, DB error, overrides apply is already caught inside
  and reported as a warning), the new server is deleted with `deleteServer` and the task fails.
  The server is seconds old and holds nothing the user made, so there's nothing to lose. A
  deletion failure is logged and the original error is what the task reports.
- A failed start is _not_ rolled back: the server is complete and the report says what's on it.
  The error goes in `startError`, the task still succeeds, and the UI shows it as a warning.

### Loader and version detection

Upstream pre-fills the wizard from a separate preview request. Here there's no preview; detection
runs at create time and the form offers **Auto-detect** or an explicit choice for each. An
explicit choice always wins.

- **`.mrpack`**: the index's `dependencies` (`minecraft`, `fabric-loader`, `quilt-loader`,
  `forge`, `neoforge`), as `parseMrpackIndex` already reads them. The pack's loader build is used
  only when the server runs the pack's loader. A pack that doesn't name one is a 400 asking the
  user to pick.
- **Jar zip**: the bundled jars are identified up front with `identifyBundled`, which remembers
  the results on the `StagedArchive`, so the install step doesn't look them up again (one registry
  round per archive, as before). Then a majority vote, like upstream:
  - **Kind**: plugins outnumber mods → `paper`. Unidentified jars don't vote; a tie goes to mods.
  - **Loader**: the most common of fabric/quilt/forge/neoforge across the jars' `loaders`. A tie
    goes to Fabric, then Forge, NeoForge, Quilt, since a Quilt server runs Fabric mods but not the
    reverse.
  - **Minecraft version**: the release listed by the most jars' `mcVersions` (registry matches
    only: manifests give ranges like `>=1.20`, not versions). Snapshots and pre-releases never
    vote. A tie goes to the newest.
  - No version data: a Paper server gets `LATEST` (plugins mostly work across versions); a mod
    server is a 400. Upstream would guess; a mod zip on the wrong version just crash-loops.

### UI

`CreateFromZipPanel.vue` copies the Mods tab's import interaction: `q-file` (`.zip,.mrpack`), an
"Apply overrides" toggle, `http.postForm`, and `tasksApi.waitFor` with `onProgress` driving a
linear progress bar and the task step. The finished report opens in the Mods tab's
`ModImportReportDialog`, unchanged; closing it navigates to the new server. The server name
defaults to the file name. Port, disk, heap and container memory default the same way the Packwiz
form does (suggested port, admin-configured defaults).

## Quilt fallback and the MC-version override (upstream parity 0.10.0 / 0.11.0)

### Quilt accepts Fabric builds, own loader first

Quilt Loader runs Fabric mods and most projects only tag "fabric", so a strict loader match left
Quilt servers a near-empty catalog. `loader-compat.ts` holds a data table (`LOADER_FALLBACKS`,
today `quilt: ['fabric']`; Fabric does not accept Quilt-only builds) with three helpers:
`acceptedLoaders` (own first), `loaderAccepts`, `preferOwnLoader` (stable partition).

- Modrinth: search facet is one OR-group (`categories:quilt` or `categories:fabric`);
  `getVersions` asks for both loaders, then `preferOwnLoader` puts quilt-tagged versions ahead of
  fabric ones. So a quilt build is taken over a newer fabric build when one exists (upstream just
  OR'd the loaders and took the newest).
- CurseForge: search uses `modLoaderTypes=[5,4]`; the files endpoint takes one type, so `getFiles`
  makes one request per accepted loader and concatenates own-loader files first, deduplicated by
  file id. Callers take `[0]`, so the preference holds.
- Zip import (`jarMisfit`) uses `loaderAccepts`.
- Because it lives in the API clients, updates, the mod browser, blueprint/pack imports and
  add-by-link all follow it. The solver is unaffected (it reads every build unfiltered).

### MC-version override

`POST /api/servers/:id/mods` takes `ignoreVersion: true` (the caller accepts the risk). Resolution
(`ModsService.resolveForServer`) still tries the server's exact MC version first; only if that
finds no build (`NotFoundException`) does it retry with no MC filter, taking the newest build for
the loader (own loader first, as above). The loader is never relaxed. A pinned version URL is
installed as given, as before. The response carries `installed.versionOverridden`, and the
`mod-installed` event names the override and records `details.versionOverridden`. It applies to
every source that filters by MC version (Modrinth, CurseForge, Hangar), and is ignored for
`LATEST`/`SNAPSHOT` servers (already unfiltered). Search: `modrinth/search` hits now carry
`gameVersions`; a client implementing the checkbox omits `mc` and flags hits whose
`gameVersions` lack the server version. There is no frontend for this yet.

The override is refused with a 400 on packwiz servers: the pack declares the Minecraft version, so
a build for another version can't be what runs. A packwiz server is recognised by `isPackwizServer`
(`servers/packwiz.ts`): a `PACKWIZ_URL` in its env, or the legacy `PACKWIZ` type. There is no
`TYPE=PACKWIZ` in the image, so a packwiz server's `type` is its real loader and the env var is the
only marker. The same helper gates manual add/upload/import, the enable/disable toggle, the pack
source label in the content list, and CurseForge key injection.

## Datapacks (upstream parity Tier 4, phase 1)

Datapack logic lives in `datapacks.service.ts` (`DatapacksService`), not in `ModsService`.
`ModsService` only delegates where an existing flow already handles a datapack row: `setEnabled` and
`removeContent` forward rows of `kind: 'datapack'`, `contentDir` returns the active world's
datapacks dir, and `reapplyOverlay` restores datapack rows into the right dir.

### Active world only

A datapack belongs to one world. The panel manages `<level>/datapacks` for the **active** level
only: `LEVEL` env, then `server.properties` `level-name`, then `world` (the same order as
`WorldPropsService.activeLevelName`, which now share `resolveActiveLevel` in
`servers/active-level.ts`). Packs in other worlds are not listed, toggled or removed.
Switching the active world therefore makes the old world's rows show as `missing`; nothing moves
packs between worlds.

The level name is user-editable config, so it is checked as a bare name (no separator, NUL or dot
segment, 400 otherwise) before any path is built, and every path still goes through
`PathGuardService`.

### Why not `WorldPropsService`

`WorldsModule` imports `MapModule`, which sits in the `ServersModule` cycle. Pulling
`WorldPropsService` into `ModsModule` would add another module edge to that cycle. So
`DatapacksService` reads the level through `ServerPropertiesService.get()` (already exported by
`ServersModule`, which `ModsModule` imports) and applies the shared pure helper
`resolveActiveLevel(env, getProp)` from `servers/active-level.ts`, which `WorldPropsService` uses
too. The precedence lives only there.

### Disabling moves, it does not rename

Disabled packs live in `<level>/datapacks.disabled/`, a **sibling** of `datapacks/`. The old toggle
appended `.disabled` to the name, which only works for zips: a directory datapack renamed
`x.disabled` still has its `pack.mcmeta` and Minecraft still loads it. Moving out of `datapacks/`
works for both. The disabled dir is created on demand. A same-named pack already at the destination
is a 409; nothing is ever overwritten. For files the move is `link` (atomic `EEXIST`, mapped to the 409) then `unlink` of the source, falling back to lstat-check + `rename` when linking is unsupported
(`EXDEV`, `EPERM`). Directories cannot be hard-linked, so they only get the lstat check before
`rename`: a pack dropped at the destination between the check and the rename can be replaced (an
empty dir on Linux). Residual race, accepted: it needs a concurrent writer inside the server dir. Toggling reports `applied: 'on-restart'` (a running server
picks it up on `/reload` or restart); no RCON is sent.

### Legacy `.zip.disabled`

Files the old toggle left as `datapacks/x.zip.disabled` are listed as a disabled `x.zip`. Migration
is lazy and only on toggle: enabling renames it back to `x.zip` in place; disabling moves it into
`datapacks.disabled/`. A pre-existing `x.disabled` _directory_ is listed as an enabled pack named
`x.disabled`, because Minecraft loads it.

### Listing and removal

`GET /api/servers/:id/datapacks` (new, so `GET .../mods` and its frontend contract are unchanged),
`POST .../datapacks/toggle`, `DELETE .../datapacks/:file`. Install still goes through add-by-link
(`POST .../mods` with `kind: 'datapack'`). Zips are all listed; a directory only counts when it holds
a `pack.mcmeta`. `description` / `packFormat` come from `pack.mcmeta` (zip entry read via
`pickZipEntries`, directory file read with a 1 MB cap); bad metadata is just absent. Symlinks are
skipped in listings, never counted in a directory's size, and `fs.rm` unlinks (not follows) any
inside a tree being removed.

A pack can sit in both dirs at once (hand-copied); remove deletes every copy, and a fresh install
(`addLibraryContent`) clears a disabled copy and resets the row to `enabled`. Rows and moves match
`file` or `file.disabled`, the legacy form.

`POST mods/toggle` on an orphan datapack (no DB row) falls into the mod `.disabled` path; the
dedicated datapacks route is the supported one until orphan adoption (phase 2).

Possible follow-up: cache `pack.mcmeta` metadata per pack (mtime + size key) so listing doesn't
reopen every zip; not needed yet.
