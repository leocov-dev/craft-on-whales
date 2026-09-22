# Router

[← Back to docs index](README.md)

The **Router** page manages an optional, panel-run [`itzg/mc-router`](https://github.com/itzg/mc-router) container that proxies Minecraft client connections to your servers by hostname — so multiple servers can share one public port instead of each needing its own.

## Enabling it

Turn on **Enable mc-router** and set the **Listen port** — the single public port players will connect to. The router container needs the same read-write Docker access as the panel itself, since auto-scale starts and stops your servers automatically.

Optionally set a **Base domain** (e.g. `example.com`). Once set, each server's subdomain (below) is combined with it to form the full route hostname — `survival` + `example.com` gives `survival.example.com`. Point a wildcard DNS record (`*.example.com`) at your machine and every new server is reachable without further DNS changes. Leave it blank to type a full hostname per server instead.

## Routes

Each server gets its subdomain and auto-scale mode from its own **Settings** tab, under **mc-route** (shown there once mc-router is enabled). The field defaults to a URL-safe version of the server's name — lowercase, spaces and other unsafe characters replaced with hyphens, capped at 30 characters — which you can accept or override. Setting or clearing it takes effect the next time the server starts, or immediately if it's already running. The Router page's Routes list is a read-only overview; click a row to jump to that server's settings.

## Auto-scale

- **Start a server when a player connects to its hostname** — the server doesn't have to be running for players to reach it; the first connection attempt starts it.
- **Stop a server after it's idle** — after the configured **idle timeout** (e.g. `10m`, `1h`) with no players, the server is stopped automatically.
- **Asleep MOTD** / **Loading MOTD** — what players see in the server list while a server is stopped or starting back up.

These are the router-wide defaults. Each server's mc-route settings can override them with **On** (always auto-scale) or **Off** (never auto-scale this server, even if the router-wide settings are on); **Default** follows the settings above.
