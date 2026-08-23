# Minecraft Server Manager — backend

The [NestJS](https://nestjs.com) API server for Minecraft Server Manager: a JSON HTTP API plus
socket.io WebSocket gateways for the live console and stats streams. It talks to Docker (via
[dockerode](https://github.com/apocas/dockerode)) to run Minecraft servers as containers, and
stores all panel state in a single SQLite database under `../data`.

This package is the rewrite target for the original `src/` implementation at the repo root — see
the [top-level README](../README.md) for what the panel does, and
[`docs/architecture.md`](../docs/architecture.md) for how this backend is put together.

## Requirements

- Node.js 24+
- Docker (optional at boot — the API stays usable without it; Docker-dependent features light up
  once the daemon is reachable)

## Running it

```bash
npm install
npm run start:dev   # auto-restart on change
```

The API listens on `http://localhost:25564` by default (same port as the legacy app). Configuration
is read from environment variables — see the top-level README's configuration table; nothing needs
to be set to start.

Other scripts:

```bash
npm run build        # nest build -> dist/
npm run start:prod   # node dist/main.js
npm run lint          # ESLint
```

## Database

The schema lives in `src/db/schema/*.ts` (Drizzle ORM). Migrations are generated with `drizzle-kit`
and applied automatically on boot — nothing to run by hand in normal use.

---

Coding agent working in this package? See [AGENTS.md](../AGENTS.md).
