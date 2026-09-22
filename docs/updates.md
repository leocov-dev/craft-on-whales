# Updates

[← Back to docs index](README.md)

The **Updates** page tracks what's out of date across your fleet — server versions, [modpack](modpacks.md) versions, and mods — in one place.

![Updates](images/updates.png)

## How it works

The panel checks each server's pinned versions against the upstream source (Modrinth, CurseForge, the GTNH release index, and so on) and lists anything with a newer release. A matching count also appears on the [dashboard](dashboard.md)'s "Updates available" tile.

Checks run on demand and can be scheduled ([Schedules](schedules.md)). Update **policy** is per-server — you decide whether the panel just notifies you, or leaves everything manual.

## Applying an update

Updates are never silent. When you choose to upgrade a pack, the panel:

1. Takes a **pre-update backup** (so it's always reversible).
2. Re-pins the exact new version.
3. Recreates the container, re-resolving the Java runtime if needed.
4. Monitors the first boot, with a per-platform time budget.

If it doesn't come up healthy, you roll back to the pre-update backup. A stable-tracking server is never offered a beta, and the changelog link points at the real per-version diff where the source provides one.

## Ignoring an update

Not every available build is one you want to take right now. Hitting **Ignore** on an entry (a mod, modpack, or server) dismisses that specific version — it drops off the Updates page, the dashboard count, and any per-server "update available" badge.

Ignoring isn't a permanent mute: it only suppresses the build you ignored. As soon as a _newer_ build is published, it reappears as a normal available update. Everything you've dismissed is listed under **Ignored updates** at the bottom of the Updates page, where you can un-ignore it at any time to bring it back immediately.
