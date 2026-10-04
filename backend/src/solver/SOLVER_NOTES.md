# Solver notes

## CurseForge projects (upstream parity 0.10.0 `2fe2aba`)

`POST /api/solver/solve` takes `projects: (string | {platform, ref})[]`. A bare string is a Modrinth
slug/id (the original contract); `platform` is `modrinth` or `curseforge`. `GET /api/solver/search`
takes `platform` (default `modrinth`) and goes through `ModBrowserService.search`, so CurseForge needs
the stored API key (412 without it) like every other CurseForge route.

- **Identity is `platform:slug`.** Slugs collide across registries, so de-duping, `perProject[].key`
  and `partial.coveredKeys` (replaces the old `coveredSlugs`) all use the composite key.
  `dropped[]` and `perProject[]` also carry `platform`.
- **Loader map from `gameVersions`.** CurseForge files mix MC versions and loader names ("Fabric",
  "NeoForge", "Java 21", "Client") in one list. Release-style versions are MC versions; the rest are
  lower-cased tags matched against the same loader buckets as Modrinth. Alpha files are skipped (same
  policy as Modrinth).
- **Bukkit Plugins (classId 5) count as Paper.** Their files carry no loader tag, so they land in the
  `paper` bucket; a _mod_ with a stray Bukkit tag does not.
- **Whole file history.** `CurseforgeApiService.getAllFiles` pages 50 at a time (cap 10 pages, 500
  files); the newest page alone would miss older MC versions. Responses go through the shared API cache.
- No frontend consumer exists yet; the wizard's "Auto-detect" panel is not ported.
