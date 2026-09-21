# Backups

[← Back to docs index](README.md)

The **Backups** page is every snapshot across your fleet, with size, reason, and age.

![Backups](images/backups.png)

## Creating a backup

From a server's **Backups** tab (or via a [schedule](schedules.md)) you can snapshot the whole server directory in one click. The panel quiesces the world first (`save-off` → `save-all`), zips the data, then re-enables saving (`save-on`), so backups are consistent even on a running server. Each backup can carry a note.

![Server backups](images/server-backups.png)

## Backup reasons

Backups are tagged by why they were taken:

- **manual** — you clicked the button.
- **scheduled** — created by a [schedule](schedules.md).
- **pre-update** — taken automatically before a pack upgrade, so an upgrade is always reversible.
- **pre-restore** — a safety snapshot taken automatically before something destructive: restoring a backup, resetting a world, or replacing a server's active world from the library.

## Retention

Each reason keeps its own set of backups, pruned independently as new ones are taken:

| Reason      | Kept per server |
| ----------- | --------------- |
| manual      | 20              |
| scheduled   | 10              |
| pre-update  | 10              |
| pre-restore | 5               |

Because the buckets are separate, an automatic snapshot can never push out a backup you took yourself — a run of restores only ever trims older `pre-restore` snapshots. Once a bucket is full, its oldest entry is deleted (file and record) when a new one is added. To keep a backup permanently, download it.

## Restoring

Restoring a backup stops the server, takes a **pre-restore** safety snapshot, replaces its world data with the snapshot, and leaves it stopped for you to start again. Because pack upgrades always take a pre-update backup first, you can always roll back a bad upgrade.

> Backups count toward a server's [disk quota](storage.md), so keep an eye on how many you retain for large modded servers.
