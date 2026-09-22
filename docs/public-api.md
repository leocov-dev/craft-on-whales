# Public API

[← Back to docs index](README.md)

The panel can expose a small, read-only HTTP API for other tools — a status page, a dashboard
widget, a monitoring script — to check on your servers without signing in. It's **off by default**.

## Turning it on

Under **Settings → Public API** (admin only):

1. Switch **Public API** on.
2. Click **New token**, give it a label (e.g. `Grafana dashboard`), optionally scope it to specific
   servers (leave blank for every server) and an optional expiry date.
3. Copy the token shown — it's only ever displayed once. If you lose it, revoke it and mint a new
   one.

Each token can be revoked at any time from the same page, which takes effect immediately.

## Using a token

Send it as a Bearer token:

```
curl -H "Authorization: Bearer cow_pat_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" \
  https://your-panel.example.com/api/v1/servers
```

### `GET /api/v1/servers`

The servers this token can see, with an online/offline summary.

```json
{
  "ok": true,
  "summary": { "total": 3, "online": 2, "offline": 1 },
  "servers": [
    {
      "id": "srv_abc123",
      "name": "Survival",
      "type": "vanilla",
      "mcVersion": "1.21.1",
      "status": "running",
      "online": true
    }
  ]
}
```

### `GET /api/v1/servers/:id`

One server's detail. A server the token isn't scoped to returns `404`, identical to an unknown id
— the API never confirms a hidden server's existence.

```json
{
  "ok": true,
  "server": {
    "id": "srv_abc123",
    "name": "Survival",
    "type": "vanilla",
    "mcVersion": "1.21.1",
    "status": "running",
    "online": true
  }
}
```

## Scoping and limits

- A token sees only the servers it was scoped to at creation time (or every server, if left
  unscoped) — it never grants any write access, regardless of scope.
- An expired or revoked token is rejected the same way as an invalid one.
- Requests are rate-limited per token and per source IP. A burst past the limit gets a `429`
  response; wait a minute and retry.
- Turning **Public API** off immediately stops every token from authenticating, without deleting
  them — turning it back on restores them all.
