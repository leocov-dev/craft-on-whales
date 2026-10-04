# Moving a server

[← Back to guides](README.md)

Moving a world is easy. Moving a server players can still join, with inventories and permissions intact, takes a little care. Pick the case that fits.

## Before you start

Write down:

- **Minecraft version and loader**, exactly.
- **Mods or plugins and their versions.** The world needs them.
- **`level-name`** in `server.properties`. The world folder is not always called `world`.
- **Online mode.** If it differs between the old and new server, players get new UUIDs and empty inventories. Keep it the same.
- **Anything stored outside the server folder**, such as an external plugin database.

Take a [manual backup](backups.md) first.

## Move to another panel

Use the world and the server's own files.

1. **Stop the server** so the world is flushed.
2. Download the world: on the server's **Worlds** tab, use the download button on the world's row.
3. Download anything else you need from the **Files** tab (configs, `whitelist.json`, `ops.json`, plugin folders). See [Worlds & files](../worlds-and-files.md).
4. On the new panel, create a server with the same loader and version (see [Creating & managing servers](../servers.md)). Match the memory settings.
5. Open the **Worlds** page, **Upload world**, then **Install…** it on the new server, replacing the current world.
6. Upload the other files with the **Files** tab and add the same mods.
7. Start it and join before telling anyone.

If you want a ready-made recipe, [Blueprints](../blueprints.md) can recreate a server's configuration, and optionally its world, on any panel. Import the blueprint file on the new panel.

## Move the whole panel to a new machine

Everything the panel owns lives in one data directory (`DATA_DIR`, `./data` by default): servers, backups, and the panel database.

1. Stop the panel and let its servers stop.
2. Copy the whole data directory to the new machine, keeping file ownership and permissions.
3. Install the panel there and point it at the copied directory. If it runs in a container, `DATA_DIR_HOST` must be the new absolute host path (see the main README's setup section).
4. Start it and check each server before opening it to players.

Two things differ by host: Docker must be running, and the game ports you used must be free.

## Keep the old one

Leave the old copy stopped but intact for a few days. It is your rollback, and stopping it means nobody builds on the abandoned copy by mistake.

## Make the address survive

If players connect by IP, every move breaks every saved entry. Use a hostname you control; moving then becomes a DNS change. The [Router](../mc-router.md) can also give each server its own hostname on one shared port.

Related: [Backups that restore](backups.md).
