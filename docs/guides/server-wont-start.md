# Server won't start

[← Back to guides](README.md)

Work down this list. It is ordered by how often each one is the answer.

## 1. Read the end of the log

Open the server's **Console** tab and scroll to the end. A Java stack trace prints the innermost cause last, so look for the final `Caused by:` line. It usually names the problem.

- An exception, or a mention of a crash report, means the game failed. Crash reports are listed under the server's **History** tab; click one to read it, and see which mods it points at.
- A log that just stops, with no error, means something killed the process. Go to point 3.

## 2. Wrong Java

`UnsupportedClassVersionError` means the server needs a newer Java than it runs on. The panel picks Java from the Minecraft version, roughly:

| Minecraft version  | Java |
| ------------------ | ---- |
| 1.16.5 and earlier | 8    |
| 1.17               | 16   |
| 1.18 to 1.20.4     | 17   |
| 1.20.5 and later   | 21   |

Newest versions use the newest Java the panel supports. This follows the version you chose, so the usual fix is correcting the Minecraft version or loader, not Java.

## 3. Out of memory

The log stops mid-line, there is no crash report, and the server shows as crashed. That is typically an out-of-memory kill. On the **Live** tab, the **Health & stability** card shows the last exit code and out-of-memory kills.

Usually the heap was set too close to the container limit. Lower the heap or raise the limit in **Settings**. See [Server memory](server-memory.md).

## 4. EULA and port

- `You need to agree to the EULA`: the panel sets `EULA` for you. If you see this, the server was probably started outside the panel or its settings were overridden; recreate it from the panel.
- `Address already in use` or `FAILED TO BIND TO PORT`: another server or program holds the game port. Give this server a different port, or stop the other one.

## 5. A mod is missing something

Messages like `Mod X requires mod Y` mean a dependency is missing. Fabric mods usually need the Fabric API. Install the version the message names, not the newest.

## 6. A mod is for the wrong loader or version

Mixin errors or `NoClassDefFoundError` often mean a mod built for another loader or Minecraft version. Both must match exactly. Remove the most recently added mod and try again. See [Choosing a loader](choosing-a-loader.md).

## 7. The world is from a newer version

`This world was created by a newer version of Minecraft` cannot be fixed by downgrading. Restore a [backup](backups.md) from before the upgrade (**Restore** on the Backups tab), or run the version the world expects.

## Stuck on "starting"

If a server is still booting after ten minutes, the panel marks it **Stalled**. It is still running; it just has not finished. The Console shows what it is doing. Large modpacks and first-time world generation can legitimately take a long time. A stalled server goes back to Running by itself once it finishes booting. If it never does, stop it and use point 1.

## Crashed after running fine

- **Under load, with long pauses**: look at the heap before the mods.
- **At the same spot in the world**: likely a corrupt chunk or entity. The crash report names coordinates.
- **Right after an update**: suspect whatever updated, and roll it back.
- **On restart**: check free disk space on the [Storage](../storage.md) page and the server's quota.

## Asking for help

Include the whole log, not the last line, plus the Minecraft version, loader, pack and version, and the heap size. Use the **Files** tab or the Console to get the log, and download the crash report if there is one.

Related: [Server memory](server-memory.md), [Console & chat](../console-and-chat.md), [Creating & managing servers](../servers.md).
