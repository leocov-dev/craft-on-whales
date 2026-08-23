# Local Docker Compose example

Run the panel locally, built from this repo's own source, instead of pulling
the published image.

## Requirements

- Docker with Compose v2 (`docker compose`, not the older `docker-compose`)
- The Docker daemon reachable from wherever you run this (a local daemon is
  simplest; a remote one works too as long as `DOCKER_HOST` is set before you
  run the commands below)

## Run it

```bash
cd examples/docker-compose
docker compose up --build
```

Then open **http://localhost:3000** and follow the first-run setup.

All panel data (worlds, mods, backups, the database) lands in `./data` next
to this file. Delete that folder to reset the panel to a clean slate.

## Stopping / resetting

```bash
docker compose down        # stop the panel, keep ./data
docker compose down -v     # stop the panel (no named volumes here, same as above)
rm -rf data                # wipe all panel data
```

## Changing the port

The panel listens on `3000` inside the container. To publish it on a
different host port, set `PANEL_PORT_HOST` before starting:

```bash
PANEL_PORT_HOST=8080 docker compose up --build
```

## More

- [Top-level README](../../README.md) — what the panel does
- [`docs/getting-started.md`](../../docs/getting-started.md) — first-run walkthrough
- The repo root's [`docker-compose.yml`](../../docker-compose.yml) is the
  *production* compose file (pulls the published image instead of building
  from source) — use that one for a real deployment.
