# Choosing a loader

[← Back to guides](README.md)

The loader (the **server type** in the creation wizard) decides what you can add to the server. Pick it before you build anything, because switching later usually means starting the world over with new mods.

## The short answer

| You want                                           | Pick                                      |
| -------------------------------------------------- | ----------------------------------------- |
| Plain Minecraft, friends only                      | **Vanilla**                               |
| Plugins (claims, economy, permissions), good speed | **Paper**, or **Purpur** for more options |
| Client-side-friendly mods, performance mods        | **Fabric** (or **Quilt**)                 |
| Large content mods and most big modpacks           | **Forge** or **NeoForge**                 |
| A specific modpack                                 | Whatever the pack says                    |

## Plugins or mods

- **Plugins** (Paper, Purpur) change server behaviour. Players join with an unmodified game.
- **Mods** (Fabric, Quilt, Forge, NeoForge) change the game itself. Players usually need the same mods installed.

You cannot mix the two on one server. Plugins do not run on Fabric or Forge, and mods do not run on Paper.

## Each option

- **Vanilla**: no plugins, no mods. Simplest.
- **Paper**: fast, widely supported, huge plugin library. The default choice for plugin servers.
- **Purpur**: Paper plus extra gameplay settings.
- **Fabric**: light, fast to update to new Minecraft versions. Many performance and quality-of-life mods. Most Fabric mods need the separate Fabric API mod.
- **Quilt**: a Fabric-compatible loader; Fabric mods generally work.
- **Forge**: the long-standing loader for big content mods, especially older versions.
- **NeoForge**: the Forge successor for newer versions. Forge and NeoForge mods are not interchangeable.

## Modpacks decide for you

If you are running a pack, use the loader and Minecraft version it was built for. The panel sets these when you install from [Modpacks](../modpacks.md). Do not change them afterwards.

## Version matters as much as loader

Mods must match both the loader and the exact Minecraft version: 1.20.1 and 1.20.4 are different targets. Check a mod's page before adding it. The panel also picks a suitable Java for the Minecraft version for you, so you do not need to choose one.

## Things to know before you commit

- Pick the version your must-have mod or plugin supports, then pick the loader, not the reverse.
- A world made with mods needs those mods to load. Removing a content mod from an existing world can break it.
- Taking a [backup](backups.md) before changing loader, version or the mod set is cheap insurance.

Related: [Creating & managing servers](../servers.md), [Worlds & files](../worlds-and-files.md).
