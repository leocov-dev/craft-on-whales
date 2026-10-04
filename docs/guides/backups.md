# Backups that restore

[← Back to guides](README.md)

A backup you have never restored is a hope, not a backup. This guide covers what to keep, how often, and how to check it works. For the buttons and retention rules, see [Backups](../backups.md).

## What to back up

The whole server directory, not just the world. Configs, the whitelist, ops, plugin data and mod settings all live beside the world, and a world without them is a different server. The panel's backups cover the whole server directory.

Things the panel does not back up for you:

- **Data outside the server folder**, such as a plugin that stores data in an external database.
- **The panel's own database** (users, schedules, history). The panel snapshots that nightly on its own; see [The panel's own database](../backups.md#the-panels-own-database).

## How often

Match it to how much play you can afford to lose.

- **Small private server**: one [scheduled](../schedules.md) backup a day is plenty.
- **Active public server**: every few hours, plus a manual backup before anything risky.
- **Before any change you are unsure of**: take a manual backup first. Adding mods, changing loader or version, and editing files by hand are the usual culprits.

Backups taken before a pack upgrade or a restore happen automatically, so you do not need to remember those.

## Keep one off the machine

Backups on the same disk as the server die with it. Open the server's **Backups** tab and use a backup's download button to keep a copy elsewhere now and then. A downloaded copy is also safe from the panel's age and size limits.

## Prove it works

Once, before you need it:

1. Create a new throwaway server and bring a recent backup's world over (download it, then upload it on the **Worlds** page and install it; see [Worlds & files](../worlds-and-files.md)). A backup is a whole-server zip; the panel finds the world inside it by its `level.dat`.
2. Start it and join.
3. Check that the base you care about is there.

Restoring on the real server is one click (**Restore** on the backup's row). It stops the server, takes a **pre-restore** safety snapshot of what is there now, replaces the data, and leaves the server stopped for you to start. If you restore the wrong backup, the safety snapshot is your way back.

## Watch the disk

Backups count toward the server's [disk quota](../storage.md), and modded worlds are big. If a server is near its quota, lower how many backups you keep, shrink the world ([Shrinking a world](../worlds-and-files.md#shrinking-a-world)), or raise the quota.

Related: [Moving a server](moving-a-server.md), [Schedules](../schedules.md).
