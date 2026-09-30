# Modpacks

[← Back to docs index](README.md)

The **Modpacks** page (and the **From modpack** tab in the [creation wizard](servers.md)) installs a modpack as a server, always **pinned to an exact pack version** so a restart can never silently upgrade the pack out from under you.

![Modpacks](images/modpacks.png)

## Supported platforms

- **Packwiz** — paste a `pack.toml` URL (the format packwiz authors publish). Packwiz packs aren't
  searchable, so this is a direct-URL install only. The pack URL is shown on the server's Overview
  tab, and its Mods tab becomes a read-only list parsed from the pack rather than the editable mod
  overlay other install methods get — see [Worlds & files](worlds-and-files.md#mods).
- **CurseForge** — search or paste a pack URL. Needs a CurseForge API key for search and private packs (add it under Settings → API keys).
- **Modrinth** — search by name.
- **FTB** — Feed The Beast packs.
- **GT New Horizons** — the 1.7.10 expert pack, installed from GTNH's own release index. GTNH picks its Java runtime per pack version (2.8.0+ runs on **Java 25** via bundled lwjgl3ify patches, older releases on Java 21 or 17), and the wizard raises the server's RAM and disk to sensible minimums for it.

## Creating a server from a zip

The **Upload zip** tab creates a new server from a file on your computer: a Modrinth pack
(`.mrpack`) or any zip of mod or plugin jars, such as a pack you exported yourself.

- Leave **Loader** and **Minecraft version** on **Auto-detect** and the panel reads them from the
  `.mrpack`, or works them out from what most of the jars in a zip were built for. A zip of mostly
  plugins becomes a Paper server. If it can't tell, it asks you to pick, and nothing is created.
- Each jar is identified and installed as normal tracked content before the server's first start.
  Jars recognized on Modrinth or CurseForge get update checks like a mod you added by link. The
  `.mrpack`'s own downloads are checked against the pack's hashes.
- **Apply overrides** copies the archive's `overrides/` config files in. On the new server's Mods
  tab, **Imports** can remove the whole pack again, config files included.
- A report of what was installed, skipped or failed opens when it's done. Closing it takes you to
  the new server.

This is different from a pack you pick under Packwiz URL or Browse packs: those stay pinned to a
published pack version and upgrade through the Updates page. A server made from a zip is an
ordinary server with the zip's content on it. CurseForge's own `manifest.json` export zips aren't
supported yet. Blueprints (`.mcserver.zip`) are the panel's own server snapshots and are imported
on the [Blueprints](blueprints.md) page.

## How pinning works

When you pick a pack, the panel resolves the exact version, records it, and installs that. On the **Updates** page you'll be told when a newer version is available; upgrading is a deliberate, guarded action with a pre-update backup and rollback — never automatic. Stable-tracking servers are never offered a beta.

## Upgrading a pack

From a pinned server you can upgrade to a newer version in one action. The panel takes a backup first, swaps the pinned version, recreates the container (re-resolving Java if the new version needs a different runtime), and monitors the first boot — with a generous window for large packs like GTNH that download a couple of gigabytes and build a several-hundred-mod world on first start.

## If a server's modpack shows an "unpinned" warning

Every install made through the panel is pinned from the start, and any attempt to save a server with an unpinned selector (raw API call, or a blueprint import carrying one) is rejected outright. The warning only appears for a server that reached this pin-by-default rule some other way — most commonly a server created outside the panel's own install flow, or one whose environment variables were hand-edited directly.

On every panel start, a background check looks for exactly this situation and repairs it automatically **using only the panel's own record of what was actually installed** — it never re-downloads a "latest" version to guess with, since doing that is the exact bug this check exists to prevent (a restart silently swapping in a different, possibly incompatible pack build and orphaning the world already on disk). When no such record exists, the server is left alone and flagged with a warning on its **Settings** tab instead of being guessed at.

If you see this warning, open **Settings** and use **Pick version** to tell the panel which pack and version is actually installed. Pick the pack and version that matches what's already on disk — a mismatch is treated like any other pack change and reinstalls on the server's next recreate.
