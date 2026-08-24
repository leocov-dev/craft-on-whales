# Docker Compose with Postgres

Run the panel with a Postgres database instead of the default SQLite file.
Uses the published image, plus a `db` service.

## Requirements

- Docker with Compose v2 (`docker compose`, not the older `docker-compose`)
- `DATA_DIR_HOST` — the absolute host path where panel data (worlds, mods,
  backups) should live

## Run it

```bash
cd examples/docker-compose-postgres
DATA_DIR_HOST=/opt/msm/data docker compose up
```

Or put `DATA_DIR_HOST=/opt/msm/data` in a `.env` file next to the compose
file and just run `docker compose up`.

Then open **http://localhost:3000** and follow the first-run setup.

The panel's database now lives in Postgres, in the named volume `pgdata`.
World data, mods, and backups still live under `DATA_DIR_HOST` as usual.

## Moving existing data over

Already running the panel with SQLite and want to switch? See
[`tools/sqlite-to-postgres/README.md`](../../tools/sqlite-to-postgres/README.md)
for the one-time data copy — switching `DB_DRIVER` alone starts the panel on
an empty database.

## Stopping / resetting

```bash
docker compose down        # stop everything, keep data
docker compose down -v     # stop and delete the Postgres volume (pgdata)
```

## More

- [Top-level README](../../README.md) — what the panel does
- [`examples/docker-compose`](../docker-compose) — build-from-source example, SQLite
- The repo root's [`docker-compose.yml`](../../docker-compose.yml) — production compose file, SQLite
