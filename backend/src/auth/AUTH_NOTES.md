# Auth module notes

Non-obvious implementation decisions for `backend/src/auth/`. See `AGENTS.md` at the repo root for
when to check this file vs. re-deriving a decision from scratch.

## Setup-PIN gate

`SetupPinService` (`setup-pin.service.ts`) gates `POST /setup` — first-run admin-account creation
— behind a PIN printed to the server's own console/log output, but **only** when the panel is
reachable from outside localhost during first run.

**Threat**: `/setup` is `@Public()` (it has to be — there's no admin account yet to authenticate
against) and accepts whatever username/password is posted first. If `PANEL_HOST` is bound to a
LAN/`0.0.0.0` address, anyone who can reach the port before the real operator finishes the wizard
can claim the first admin account — the panel then has an attacker-controlled admin from the
start, no compromise required beyond network reachability.

**Why gated on bind, not per-request IP**: `ConfigService.isExposedBind` (already existed, derived
from `PANEL_HOST`) is the signal — computed once at boot from how the operator configured the
panel, not from the shape of an individual request. A loopback-only bind means nothing off the
host can reach `/setup` at all (even through a reverse proxy on the same host, since the proxy's
own request to the app still originates from localhost), so there's nothing an in-app gate could
usefully add there. Once `PANEL_HOST` is a LAN/`0.0.0.0` address, the PIN gate turns on.

**Lifecycle**: `SetupPinService.onModuleInit()` runs once, after migrations (so `firstRunNeeded()`
can query the `users` table) but as part of Nest's normal module bootstrap. If exposed-bind and
first-run-needed both hold, it generates a random 6-digit PIN (`crypto.randomInt`, not
`Math.random`) and logs it via `Logger.warn` — deliberately the server's own stdout/log stream,
never returned by any HTTP response. `POST /setup` requires and verifies it
(`SetupPinService.verify()`, constant-time compare), then calls `consume()` so the PIN is one-shot:
once the first admin account exists, the PIN (and the requirement) are gone for good, matching
`firstRunNeeded()`'s own one-way flip.

A loopback bind, or a first run that completes before this service's `onModuleInit` even runs
(startup ordering makes this effectively impossible in practice, but see `required()`), skips the
gate entirely — `GET /auth/status` exposes `setupPinRequired` so the SPA only shows the PIN field
when it's actually needed.

## Setup-PIN lockout

Reuses `LoginRateLimitService` **unchanged** — no new rate-limiting code was added. The existing
service's public API (`checkLoginAllowed(subject, ip)` / `recordLoginFailure` /
`clearLoginFailures`) is already generic: `subject` doesn't have to be a real username, it's just
the first half of the `subject|ip` lockout key.

`AuthController.setup()` calls it twice per attempt, under two fixed pseudo-subjects:

- **Per-IP**: `checkLoginAllowed('setup-pin', req.ip)` — the real caller IP, so one attacker can't
  burn through guesses from a single address past `LoginRateLimitService`'s existing
  `MAX_ATTEMPTS`/`LOCK_MS`.
- **Global**: `checkLoginAllowed('setup-pin-global', '*')` — a fixed pseudo-IP (`'*'`), so every
  caller regardless of source address shares **one** decaying counter. A 6-digit PIN only has
  1,000,000 possibilities; without a global cap, an attacker spreading guesses across many source
  IPs (or IPv6 addresses, trivially rotated) could still brute-force it by only ever tripping the
  per-IP lock on each address once. The global counter closes that gap using the exact same
  primitive, just keyed differently.

This was a deliberate reuse decision per `AGENTS.md`'s SOLID guidance: the shape needed here (an
extra global-scope counter) is achievable by calling the existing generic API with a second fixed
key pair, so no new service, no new methods, and no duplicated lockout logic were needed.

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

## SameSite cookie policy + Origin/Referer checks (CSRF defense-in-depth)

The session cookie's `SameSite` attribute and `OriginGuard`
(`guards/origin.guard.ts`) are two independent layers against
cross-site request forgery, deliberately kept both:

- `SameSite` is a _browser-enforced_ control — it stops the cookie from even
  being attached to a cross-site request in the first place. It's the
  cheaper, earlier layer, but it has known gaps (older browsers that predate
  `SameSite` defaults, some top-level-navigation edge cases under `Lax`) and
  is entirely opt-out for a caller that isn't a browser.
- `OriginGuard`'s `Origin`/`Referer` check is a _server-enforced_ control —
  it doesn't trust the browser to have done the right thing; it independently
  verifies the request's stated origin matches this panel's own `Host`
  before allowing a state-changing verb through. This is the "layer checks
  at the boundary and again in the service" pattern AGENTS.md's
  Defense-in-depth section asks for, applied to CSRF specifically rather
  than added speculatively.

### `COOKIE_SAMESITE` (`ConfigService.cookieSameSite`)

Configurable via `COOKIE_SAMESITE=lax|strict|none` (default `lax`, validated
in `ConfigService`'s constructor — an unrecognized value throws at boot
rather than silently falling back). `lax` is the default rather than
`strict` specifically _because_ `OriginGuard` already covers the CSRF case
`strict` exists for: `Lax` still blocks the cookie on cross-site
sub-requests (images, fetches, iframes) while allowing normal top-level
navigation into the panel to work exactly like a browser expects, and the
Origin check picks up the CSRF slack. `strict`/`none` remain available for
operators who want the stricter browser-side behavior (`strict`) or need
the panel embedded/linked cross-site (`none`, e.g. behind another app that
iframes it) and are willing to accept the wider cross-site cookie exposure.

`SameSite=None` requires the browser to also see `Secure` on the cookie
(browsers silently drop a `None` cookie that isn't `Secure` — a failure
mode a lot worse than refusing to boot), so `ConfigService` throws at
startup if `COOKIE_SAMESITE=none` is set with `COOKIE_SECURE` left at its
default `false`. `COOKIE_SECURE=auto` is accepted (it tracks the request's
actual scheme at runtime via `trust proxy` — see README's `.env` table),
since that's the correct setting behind a TLS-terminating reverse proxy.

### `OriginGuard` and `COOKIE_SAMESITE=none`

Under `lax`/`strict`, a state-changing request with neither `Origin` nor
`Referer` is let through — some legitimate same-site browser requests
(older browsers, certain redirect chains) still omit both, and `SameSite`
is the layer actually relied on there. Under `none`, the cookie provides
_no_ CSRF protection on its own (it's sent cross-site by design), so a
write request carrying neither header has nothing left backing it and is
rejected outright rather than assumed same-site.

### Guard scoping: no Bearer/API-key bypass needed (yet)

`OriginGuard` is registered as a global `APP_GUARD` (see `auth.module.ts`)
and applies to every route uniformly. This is safe today because every
inbound-authenticated route in this app is cookie-session-authenticated —
`ApiKeysService`/`ApiKeysController` store _outbound_ third-party keys
(CurseForge) for the panel to present to external APIs, not an inbound
Bearer/API-key auth scheme for callers of this panel's own API. There is
no non-browser API consumer today that an Origin check could wrongly
block. If an inbound API-key auth mode is ever added (see
`UPSTREAM_PARITY.md` item 3.17, "Public read-only API" — not built), scope
`OriginGuard` to skip requests authenticated that way (e.g. a
`@SkipOriginCheck()` decorator checked the same way `@Public()` is, or an
explicit check for the presence of a validated `Authorization: Bearer`
principal on `req`) rather than exempting routes by path.

### WS handshake origin check

See `backend/src/ws/WS_NOTES.md` — the same host-match rule is applied at
`authenticateGatewayConnection()` time in `backend/src/ws/gateway-auth.ts`,
since the browser `WebSocket` API is exempt from same-origin policy (unlike
`fetch`/XHR) and socket.io's own `cors` option was never configured, so no
existing layer was actually checking the handshake's `Origin`.

### Why no `ALLOWED_ORIGINS` config

The panel is served single-origin: `backend/src/app.module.ts`'s
`ServeStaticModule` serves the built SPA from the same origin as the API in
production, and there's no CORS setup anywhere in `backend/` (`grep -rn
cors backend/src` turns up nothing) — this app has never needed a
multi-origin allowlist. `OriginGuard` and the WS handshake check therefore
compare the request's stated `Origin`/`Referer` host against that _same_
request's own `Host` header (respecting `TRUST_PROXY`, same as everywhere
else `req.hostname`/`req.protocol` are relied on) rather than a configured
allowlist — this is the standard same-origin CSRF check and avoids adding a
new, redundant config surface per AGENTS.md's "don't add speculative
configuration" rule.
