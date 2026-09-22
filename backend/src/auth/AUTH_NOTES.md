# Auth module notes

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
