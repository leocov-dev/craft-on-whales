# backend/src/utils/ notes

Non-obvious decisions for the plain-function helpers in this directory (no
NestJS module of its own — everything here is imported directly, DI-free,
matching the rest of `utils/`).

## safe-zip-extractor.ts — consolidating the three zip-handling paths (Tier 2 item 2.13)

Before this, the repo had three independent zip-handling code paths, each
grown its own copy of the "is this entry safe to extract" checks:

1. `worlds/world-archive.service.ts` — `WorldArchiveService.extractZip()` /
   `.extractArchive()` (world upload, backup restore, world-library install).
   Already had zip-slip containment (manual `path.resolve`+`relative` check)
   and a decompression-bomb ceiling (50 GB total / 200,000 entries) before
   this change, but no backslash-separator rejection and no entry-type check.
2. `blueprints/zip.util.ts` — `extractZipSafe()` / `readZipIndex()`
   (blueprint import/preview). Already had zip-slip containment, backslash
   rejection, and a total-size cap (8 GB, matching the blueprint upload size
   limit) — but no entry-type check, and its own copy of the same
   containment/backslash logic as (1), independently maintained.
3. `items/item-zip-parser.ts` — `openZip()`/`pickZipEntries()` (background
   mod-jar scan). See "item-zip-parser.ts is out of scope" below.

(1) and (2) are now both thin wrappers around one shared guard,
`extractZipSafely()` here, which every extract-to-disk path funnels through:

- **Zip-slip containment** — resolved via `PathGuardService.safeJoin()`
  (`storage/path-guard.service.ts`), the repo's one path-containment
  primitive (AGENTS.md calls it a load-bearing invariant), rather than
  reinventing the lexical `resolve`+`relative` check a second time. This is
  strictly more defense than either prior implementation had on its own:
  `safeJoin` also does a real-symlink-containment pass once `destDir`
  exists (an entry can't escape through a symlinked subdirectory created by
  an earlier entry in the same archive), which neither (1) nor (2) checked
  before.
- **Backslash-separator rejection** — `isSafeZipEntryName()`. A `\`-separated
  entry name reads as one opaque path segment on POSIX (no `..` traversal
  visible to a naive forward-slash-only check), so it's rejected outright
  rather than normalized — no legitimate zip tool emits backslash-separated
  names (the zip spec mandates `/`).
- **Size caps** — both a per-entry cap and a running total cap, checked
  against both the entry's _declared_ `uncompressedSize` (fails fast, before
  opening a read stream) and the _actual_ streamed byte count (defends
  against a declared size that lies). Numbers were **reused, not
  reinvented**: world-archive keeps its existing 50 GB total / 200,000
  entries; blueprints keeps its existing 8 GB total (matches the upload size
  limit enforced in `blueprints.controller.ts`). Per-entry defaults to the
  total cap when not overridden — a single entry was never allowed to
  exceed the whole archive's budget in either prior implementation, so
  making that a `maxEntryBytes` default just makes an already-true bound
  explicit and fails fast on it.
- **Unsupported-entry-type refusal** — `isSupportedZipEntryType()` rejects
  symlink/device/FIFO/socket entries (detected via the zip central
  directory's unix mode bits, when present) rather than silently extracting
  or following them. Neither prior implementation checked this: in practice
  neither ever calls `fs.symlink` (a "symlink" entry would just land as an
  inert regular file containing the link-target text), but that safety
  depended on the writer never changing — this makes the entry's declared
  type the thing being checked, not an accident of what the writer happens
  to do.

### item-zip-parser.ts is out of scope

`items/item-zip-parser.ts` (`openZip`/`pickZipEntries`/`readZipEntry`) never
extracts to disk — it reads selected entries into in-memory `Buffer`s for
mod/item metadata identification (a background, non-fatal scan) and nothing
it does ever calls `fs.writeFile`/`fs.mkdir`/etc. Zip-slip containment is a
disk-write-path risk (an entry's name controls a filesystem write location);
with no filesystem write in this path, entry _names_ are inert strings used
only as `Map` keys. It already has its own per-entry decompressed-size cap
(`MAX_ZIP_ENTRY_BYTES`, 16 MB) for a different reason — bounding in-memory
read size so a crafted jar can't OOM the panel — which is a real but
separate concern from the shared extract-to-disk guard and was left as-is.
Deliberately not folded into `safe-zip-extractor.ts`.

### Symlink detection needed extending `types/yauzl.d.ts`

The hand-rolled yauzl type declaration (yauzl ships no types; see that
file's own header comment) didn't expose `versionMadeBy` /
`externalFileAttributes` — needed to read a zip entry's unix mode bits.
Extended, not replaced; both fields exist on yauzl's real runtime `Entry`
object (confirmed against `node_modules/yauzl/index.js`).
