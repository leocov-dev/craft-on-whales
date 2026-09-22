import { SetMetadata } from '@nestjs/common';

export const SKIP_ORIGIN_CHECK_KEY = 'skipOriginCheck';

/**
 * Exempts a route from `OriginGuard`'s Origin/Referer CSRF check — for
 * routes authenticated by a validated `Authorization: Bearer` token instead
 * of the session cookie. Bearer tokens aren't auto-attached by the browser
 * the way a cookie is, so they carry no CSRF exposure for `OriginGuard` to
 * defend against; the check only exists to stop a *cookie-authenticated*
 * cross-site request. See AUTH_NOTES.md's "Guard scoping" section and
 * API_TOKENS_NOTES.md.
 *
 * Checked the same way `@Public()` is (`Reflector.getAllAndOverride`), on
 * the public-API controller — not a path-based exemption.
 */
export const SkipOriginCheck = () => SetMetadata(SKIP_ORIGIN_CHECK_KEY, true);
