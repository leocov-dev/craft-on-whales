# Auth module notes

Non-obvious implementation decisions for `backend/src/auth/`. See `AGENTS.md` at the repo root for
when to check this file vs. re-deriving a decision from scratch.

## TRUST_PROXY: refusing a bare boolean

`ConfigService.resolveTrustProxy()` used to accept `TRUST_PROXY=true` and pass it straight to
Express's `trust proxy` setting. Express's own docs already warn that `true` trusts
`X-Forwarded-For` from **any** connecting client — appropriate only when the app can genuinely
never be reached except through the proxy. On this panel, PANEL_HOST/Docker port publishing/proxy
misconfiguration are all things an operator can get wrong independently of setting `TRUST_PROXY`,
so `true` was silently spoofable the moment any of those went wrong: a direct request forging
`X-Forwarded-For: 127.0.0.1` (or any address) would make `req.ip` — which
`LoginRateLimitService`'s lockout keys on — lie, letting an attacker either impersonate a trusted
IP or spread a brute-force attempt across fake source IPs to dodge the per-IP lockout.

**Change**: `TRUST_PROXY=true` (case-insensitive) is now a hard boot-time config error. Accepted
values are unchanged otherwise — a hop count (`TRUST_PROXY=1`, trust the last N proxies) or a
comma-separated IP/CIDR list (`TRUST_PROXY=127.0.0.1` or `10.0.0.0/8,192.168.0.0/16`) — both of
which Express's `trust proxy` setting already supports, and both of which only trust a header
appended by an actual matching hop rather than trusting the header unconditionally. `false`/unset
(the default) is unaffected.

**Migration path for existing installs with `TRUST_PROXY=true`**: switch to `TRUST_PROXY=1` if
there's exactly one reverse proxy in front of the panel (the overwhelmingly common case — Caddy,
nginx, Traefik, a single Docker Compose proxy service) or to `TRUST_PROXY=<proxy IP>` /
`TRUST_PROXY=<CIDR>` if it's more specific about which host(s) should be trusted (e.g. the proxy
runs in a container with a known IP, or on the same host as `127.0.0.1`). The panel refuses to
boot with a clear error message pointing at this — an existing install with `TRUST_PROXY=true` in
its `.env` will fail loudly (not silently degrade) on the next start after upgrading, forcing the
migration rather than letting a stale insecure setting linger unnoticed.

**Deprecation window considered and rejected**: a soft-deprecation period (warn but still honor
`true`) was considered, but rejected — `TRUST_PROXY=true`'s failure mode is a _silent_ security
regression (spoofable `req.ip`), not a functional break an operator would notice and investigate.
A warning buried in startup logs is exactly the kind of thing that goes unread on a
long-running self-hosted box. A hard, unmissable boot failure with an actionable message is more
in keeping with this project's existing config-validation style (see `numFromEnv`'s and
`DATA_DIR_HOST`'s validation, both hard errors, not warnings) and with `AGENTS.md`'s "Defense in
depth is a project goal" framing. The fix is a one-line `.env` edit either way.

