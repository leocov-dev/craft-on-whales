# Worlds & files

[← Back to docs index](README.md)

## Worlds

The **Worlds** page manages the world data across your servers — swap the active world, upload a world, or download one.

![Worlds](images/worlds.png)

## The file manager

Under a server's **World** section, the **Files** tab is a full in-browser file manager for that server's data directory. List, read, edit, create, rename, move, copy, delete, and upload files — everything you'd normally do over SSH, from the browser.

![File manager](images/server-files.png)

Text files open in an editor with a 2 MB limit; larger files can be downloaded. Uploads accept multiple files at once.

### Staying inside the sandbox

Every file operation is confined to the server's own data directory. The panel resolves each path and refuses anything that would escape — `..` traversal, absolute paths, and even symlinks that point outside the directory (including dangling ones that don't exist yet). A mod or plugin can't plant a link to trick the file manager into reading or writing elsewhere on the host.

## Mods

For modded servers, the **Mods** tab (also under **World**) manages the mod set — browse and add mods, and see what's installed. Mod and pack updates surface on the [Updates](updates.md) page.

### Importing a pack

You can also import a whole set of mods or plugins at once: pick a Modrinth `.mrpack` or a `.zip` of jars under the add-by-link box and click **Import**. The panel works out what each jar is, installs the ones that fit the server, and shows a report of what was installed, what was skipped (and why), and what failed. Jars already on the server are never overwritten.

If **Apply overrides** is on, the pack's `overrides/` files (configs and the like) are copied into the server too. Files they replace are backed up first.

Imported mods are grouped under their pack in the list. To undo an import, open **Imports** and remove it: its mods are deleted, replaced files are restored, and files it added are deleted. Files you've changed since the import are left alone. CurseForge modpack exports aren't supported yet.

For a server installed from a [packwiz](modpacks.md) `pack.toml` URL, this tab is read-only instead: it lists mods parsed straight from the pack's own index rather than the panel's normal editable overlay, since packwiz — not the panel — owns that server's mod set. A banner links back to the pack's `pack.toml` URL, which is also shown on the server's Overview tab under Details.
