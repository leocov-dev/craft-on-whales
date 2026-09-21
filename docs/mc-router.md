# Router

[← Back to docs index](README.md)

The **Router** page manages an optional, panel-run [`itzg/mc-router`](https://github.com/itzg/mc-router) container that proxies Minecraft client connections to your servers by hostname — so multiple servers can share one public port instead of each needing its own.

## Enabling it

Turn on **Enable mc-router** and set the **Listen port** — the single public port players will connect to. The router container needs the same read-write Docker access as the panel itself, since auto-scale starts and stops your servers automatically.

## Routes

Each server can be given a **hostname** (e.g. `survival.example.com`) under Routes. Point that hostname's DNS at your machine, and players connecting to it land on that server — no per-server port needed. Setting or clearing a hostname takes effect the next time the server starts, or immediately if it's already running.

## Auto-scale

- **Start a server when a player connects to its hostname** — the server doesn't have to be running for players to reach it; the first connection attempt starts it.
- **Stop a server after it's idle** — after the configured **idle timeout** (e.g. `10m`, `1h`) with no players, the server is stopped automatically.
- **Asleep MOTD** / **Loading MOTD** — what players see in the server list while a server is stopped or starting back up.
