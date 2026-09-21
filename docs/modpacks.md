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

## How pinning works

When you pick a pack, the panel resolves the exact version, records it, and installs that. On the **Updates** page you'll be told when a newer version is available; upgrading is a deliberate, guarded action with a pre-update backup and rollback — never automatic. Stable-tracking servers are never offered a beta.

## Upgrading a pack

From a pinned server you can upgrade to a newer version in one action. The panel takes a backup first, swaps the pinned version, recreates the container (re-resolving Java if the new version needs a different runtime), and monitors the first boot — with a generous window for large packs like GTNH that download a couple of gigabytes and build a several-hundred-mod world on first start.

## If a server's modpack shows an "unpinned" warning

Every install made through the panel is pinned from the start, and any attempt to save a server with an unpinned selector (raw API call, or a blueprint import carrying one) is rejected outright. The warning only appears for a server that reached this pin-by-default rule some other way — most commonly a server created outside the panel's own install flow, or one whose environment variables were hand-edited directly.

On every panel start, a background check looks for exactly this situation and repairs it automatically **using only the panel's own record of what was actually installed** — it never re-downloads a "latest" version to guess with, since doing that is the exact bug this check exists to prevent (a restart silently swapping in a different, possibly incompatible pack build and orphaning the world already on disk). When no such record exists, the server is left alone and flagged with a warning on its **Settings** tab instead of being guessed at.

If you see this warning, open **Settings** and use **Pick version** to tell the panel which pack and version is actually installed. Pick the pack and version that matches what's already on disk — a mismatch is treated like any other pack change and reinstalls on the server's next recreate.
