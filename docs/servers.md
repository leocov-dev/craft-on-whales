# Creating & managing servers

[← Back to docs index](README.md)

## Creating a server

Click **New server** (top bar) or the **Create a server** card to open the wizard.

![Create a server](images/create-wizard.png)

You choose:

- A **name** (and optional icon, accent color, and tags to organize your fleet).
- A **server type** — vanilla, Paper, Fabric, Forge, NeoForge, and more, each mapped to the right itzg image behind the scenes.
- A **Minecraft version** — `LATEST`, a snapshot, or a specific version.
- **Resources** — RAM (heap), container memory limit, CPU, and a disk quota. These pre-fill from the panel's configured defaults (an admin can change them under **Settings → Defaults for new servers**) — override any of them per-server right here in the wizard.

Prefer a modpack? The **From modpack** tab installs from a packwiz `pack.toml` URL, CurseForge, Modrinth, FTB, or GT New Horizons instead — see [Modpacks](modpacks.md). You can also start from a saved [Blueprint](blueprints.md).

The panel picks a sensible Java runtime for your version automatically, pulls the image, creates the container, and (optionally) starts it — all from the one form.

## The servers list

The **Servers** page lists your whole fleet with status and quick stats.

![Servers list](images/servers-list.png)

## A single server

Opening a server gives you a tabbed workspace:

- **Overview** — status, live stats, uptime, and the primary start / stop / restart controls.
- **Console** — the live log stream and command input, plus in-game chat ([details](console-and-chat.md)).
- **Players** — who's online, plus inventory, analytics, and [chat commands](console-and-chat.md).
- **World** — [worlds, mods, the live map, and the file manager](worlds-and-files.md).
- **Backups** — [snapshots and restore](backups.md) for this server.
- **Insights** — metrics and per-server history.
- **Settings** — everything about how the server runs.

![Server overview](images/server-overview.png)

## Server settings

The **Settings** tab covers identity (name, description, tags, notes), resources (heap, container memory, CPU, disk quota), and lifecycle (auto-start, auto-restart on crash, modpack update policy).

![Server settings](images/server-settings.png)

> Per-variable environment editing and advanced Docker overrides (custom container name, extra ports/bind mounts, raw overrides) aren't available in this tab yet — see README's "Status & areas that need work".

### Why the memory meter reads high with nobody playing

Java is handed the Java heap as both its _starting_ and its _maximum_ size, and
it fills a heap it was given up front within the first minute of world
generation. A 12 GB heap therefore reads about 12 GB on an empty server. That
is normal, not a leak, and it is not caused by Aikar's or MeowIce's flags:
measured on Paper 1.21.1 with a 2 GB heap, resident memory was 2.60 GB with no
flags at all and 2.59 GB with Aikar's.

The lever that actually lowers idle memory is a smaller **initial heap**. On
that same 2 GB server, `INIT_MEMORY=512M` idled at 1.38 GB with Aikar's flags
and 1.25 GB with no preset — Java then grows the heap on demand instead of
claiming it at boot. Set `INIT_MEMORY` in the server's environment; the panel
adds the missing `M` if you type a bare number, so `512` and `512M` both mean
512 MB (without that, Java would read `512` as 512 _bytes_ and refuse to
start).

The memory meters on the Overview and Metrics tabs mark where the heap sits on
the container memory limit's scale and say which of the two cases you're in;
the server card says the same on hover.

### Settings that live in server.properties

PvP, difficulty and whitelist enforcement are stored in the server's `server.properties`, not in the panel's database. Changing one of them in World Controls, on the Players tab, or by editing the file directly in the file manager now sticks: the panel takes that property out of the container's environment so the Minecraft image stops re-applying its old value every time the server boots.

The trade-off is that such a change marks the server as needing a **recreate**. The running server keeps going; the new container settings apply the next time you restart it from the panel.
