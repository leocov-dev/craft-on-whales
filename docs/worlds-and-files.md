# Worlds & files

[← Back to docs index](README.md)

## Worlds

The **Worlds** page manages the world data across your servers — swap the active world, upload a world, or download one.

![Worlds](images/worlds.png)

### Shrinking a world

Worlds only grow: every chunk a player flies past stays on disk. **Shrink** (the compress button on a world in the server's Worlds tab) removes chunks that were barely visited, then repacks the region files so the world really gets smaller. Minecraft regenerates a removed chunk from the seed if someone goes there again.

- A chunk is removed when players spent less than the chosen time in it (30 seconds by default).
- Chunks near the world spawn are always kept (8 chunks by default; set 0 to turn this off). Only the overworld has this protection.
- Every dimension is covered, including custom ones, and the removed chunks' entities and villager job sites go with them.
- Chunks the panel can't read are kept and counted, and a damaged region file is left alone.
- **Preview** shows how much would be freed and works while the server runs. Shrinking itself needs the server stopped, and can't be undone, so take a [backup](backups.md) first.

## The file manager

Under a server's **World** section, the **Files** tab is a full in-browser file manager for that server's data directory. List, read, edit, create, rename, move, copy, delete, and upload files — everything you'd normally do over SSH, from the browser.

![File manager](images/server-files.png)

Text files open in an editor with a 2 MB limit; larger files can be downloaded. Uploads accept multiple files at once.

### Staying inside the sandbox

Every file operation is confined to the server's own data directory. The panel resolves each path and refuses anything that would escape — `..` traversal, absolute paths, and even symlinks that point outside the directory (including dangling ones that don't exist yet). A mod or plugin can't plant a link to trick the file manager into reading or writing elsewhere on the host.

## Mods

For modded servers, the **Mods** tab (also under **World**) manages the mod set — browse and add mods, and see what's installed. Mod and pack updates surface on the [Updates](updates.md) page.

### Files you have to download yourself

Some files can't be downloaded by the panel: CurseForge projects whose author has turned off third-party downloads, paid (premium) SpigotMC resources, and plugins hosted outside SpigotMC or Hangar. When you add one of these by link, the Mods tab says why and links to the download page. Download the jar in your browser, pick it under the message, and click **Upload & install**. For CurseForge, the panel checks that the jar is exactly the file it was expecting.

### Importing a pack

You can also import a whole set of mods or plugins at once: pick a Modrinth `.mrpack` or a `.zip` of jars under the add-by-link box and click **Import**. The panel works out what each jar is, installs the ones that fit the server, and shows a report of what was installed, what was skipped (and why), and what failed. Jars already on the server are never overwritten.

If **Apply overrides** is on, the pack's `overrides/` files (configs and the like) are copied into the server too. Files they replace are backed up first.

Imported mods are grouped under their pack in the list. To undo an import, open **Imports** and remove it: its mods are deleted, replaced files are restored, and files it added are deleted. Files you've changed since the import are left alone. CurseForge modpack exports aren't supported yet.

For a server installed from a [packwiz](modpacks.md) `pack.toml` URL, this tab is read-only instead: it lists mods parsed straight from the pack's own index rather than the panel's normal editable overlay, since packwiz — not the panel — owns that server's mod set. A banner links back to the pack's `pack.toml` URL, which is also shown on the server's Overview tab under Details.
