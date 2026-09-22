# Library module notes

## Checksum verification (Tier 2 item 2.14)

`LibraryService.downloadToLibrary` verifies a downloaded file's bytes against
a registry-published checksum, when the caller has one, before the file is
dedupe-checked, moved into `./data/library/`, or installed anywhere.

**This is integrity verification only.** It is not, and must not become, the
SSRF/URL-allowlisting guard that was deliberately removed from server-side
downloads in `3719117` (`fix: remove SSRF guard on server-side downloads`,
see `UPSTREAM_PARITY.md`'s "Rejected" table). That removal was intentional —
this is a homelab/self-hosted panel and the guard blocked legitimate fetches
from trusted internal hosts (e.g. an internal packwiz server on a private
domain) with no way to allow specific hosts. Checksum verification answers a
different question ("are these the bytes the registry told us to expect?"),
not "is this URL/host safe to fetch from?" — it adds no URL/host/IP
allowlisting, and none should be added here as part of this feature.

### How `expectedHash` is threaded through

`DownloadMeta.expectedHash?: ExpectedHash` (`{ algorithm, hex }`,
`backend/src/mods/mods.types.ts`) carries whatever checksum the source's own
API/manifest already gave us for that exact file, filled in by the caller
before calling `downloadToLibrary`:

- **Modrinth** — version file objects always carry `hashes: { sha1, sha512 }`
  in practice; we use `sha512` (the stronger of the two Modrinth publishes).
- **CurseForge** — file objects carry a `hashes[]` array of
  `{ value, algo }` (CurseForge's own enum: `1` = Sha1, `2` = Md5), which is
  _not_ guaranteed to be present on every file. `curseforgeExpectedHash()`
  (`backend/src/mods/curseforge-api.service.ts`) picks sha1 when present,
  falling back to md5, or `null` when the file has no hash at all. We do
  **not** use CurseForge's `fileFingerprint` (a murmur2 hash of a
  whitespace-normalized byte stream, not the raw file) — sha1/md5 from
  `hashes[]` is already directly verifiable with Node's `crypto` module, so
  there is no reason to take on a murmur2 implementation (none already
  existed in this repo — checked `backend/src/analytics/` and repo-wide,
  contrary to a prior assumption) for a weaker, purpose-built comparison
  hash instead of a general-purpose cryptographic one.
- **packwiz** — `pack.toml`/`index.toml`/per-mod `*.toml` files do carry a
  `hash`/`hash-format` per file (see `mods.types.ts`'s `PackwizModToml`), but
  this backend never downloads the mod _file_ bytes for a packwiz-managed
  server — `PackwizApiService` only fetches the pack's TOML metadata for
  listing/pinning. Installing the pack's mods is delegated entirely to the
  itzg container image's own packwiz installer at container start, which
  this codebase never talks to over HTTP. There is currently no download
  path in this backend to attach packwiz per-file verification to; if one is
  added later (e.g. a panel-side packwiz installer), thread `hash`/
  `hash-format` through the same `expectedHash` field.
- **Direct URL installs** (`source.kind === 'direct'`, and any blueprint
  overlay item with only a bare `sourceUrl`) have no registry to ask, so
  `expectedHash` is left unset for these.

### Missing-hash judgment call

Not every source/response guarantees a checksum (a direct URL has none to
give; a CurseForge file can legally have an empty `hashes[]`). When
`meta.expectedHash` is absent, `downloadToLibrary` **skips verification and
logs a `Logger.warn`** rather than hard-failing the download. Rationale:
hard-failing would break direct-URL installs and any CurseForge file that
happens to lack hashes entirely — both are legitimate, pre-existing
workflows — for a check that can only ever be as strong as what the source
chooses to publish. The warning still gives an operator a signal to notice
if a source they expected to be hashed silently wasn't.

### Where the check lives

The verification happens inside the same streaming pipeline that already
computes the `sha256` used for library dedupe (so no separate read pass):
a second `crypto.createHash()` is only allocated when the expected
algorithm differs from `sha256`. On mismatch, the partially-downloaded temp
file is deleted (`fsp.rm(tmpFile, { force: true })`) and a `BadGatewayException`
is thrown naming both hashes (truncated via `truncateHash`) — the file is
never dedupe-checked, renamed into `./data/library/`, or given a
`library_files` row, so nothing corrupted or unverified is ever left on disk
pretending to be installed.
