# Server memory

[← Back to guides](README.md)

How much RAM to give a server, and why the meter reads high on an empty one.

## Two numbers

In a server's **Settings** tab, under **Resources**:

- **Java heap (MB)**: the memory Java may use for the game itself.
- **Container memory limit (MB)**: the most the whole container may use. If it goes over, the system kills it.

The limit must be bigger than the heap. Java needs extra room beyond the heap for itself, roughly 0.5 to 1.5 GB on a modded server. Setting the heap equal to the limit is the classic way to get a server that dies with no error.

## How much to give

These are starting points, not rules:

| Server                                | Heap       |
| ------------------------------------- | ---------- |
| Vanilla or Paper, a few friends       | 2 to 4 GB  |
| Paper, a busy public server           | 4 to 8 GB  |
| Light mods (Fabric, a few dozen mods) | 4 to 6 GB  |
| Large modpack                         | 6 to 10 GB |

Use what the pack's page recommends if it gives a number. More is not better: a very large heap makes garbage collection pauses longer. Watch the **Live** tab under real load and adjust.

## Why an idle server shows 12 GB

Java starts with the heap set to its maximum, and fills it during world generation in the first minute. A 12 GB heap therefore reads about 12 GB with nobody online. That is normal, not a leak, and the memory meters on **Overview** and **Live** say which case you are looking at.

Flag presets such as Aikar's do not cause it. The one thing that lowers idle memory is a smaller **initial** heap (`INIT_MEMORY`), so Java grows the heap on demand. The panel adds the missing `M` if the value is a bare number: `512` becomes `512M`. The Settings tab does not have a field for `INIT_MEMORY` yet; it can be set through the API or a [blueprint](../blueprints.md). Changing the heap itself is a normal setting.

## Signs you have too little

- The server stops without a Java error, and the **Live** tab's **Health & stability** card counts an out-of-memory kill.
- Long freezes and TPS drops under load (TPS and MSPT show on Paper, Purpur, Forge, NeoForge, or with the spark mod).

Raise the heap, and the container limit with it.

Related: [Server won't start](server-wont-start.md), [Creating & managing servers](../servers.md).
