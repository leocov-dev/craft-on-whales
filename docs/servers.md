# Creating & managing servers

[← Back to docs index](README.md)

## Creating a server

Click **New server** (top bar) or the **Create a server** card to open the wizard.

![Create a server](images/create-wizard.png)

You choose:

- A **name** (and optional icon, accent color, and tags to organize your fleet).
- A **server type** — vanilla, Paper, Fabric, Forge, NeoForge, and more, each mapped to the right itzg image behind the scenes.
- A **Minecraft version** — `LATEST`, a snapshot, or a specific version.
- **Resources** — RAM (heap), container memory limit, CPU, and a disk quota.

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
