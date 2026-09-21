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

For a server installed from a [packwiz](modpacks.md) `pack.toml` URL, this tab is read-only instead: it lists mods parsed straight from the pack's own index rather than the panel's normal editable overlay, since packwiz — not the panel — owns that server's mod set. A banner links back to the pack's `pack.toml` URL, which is also shown on the server's Overview tab under Details.
