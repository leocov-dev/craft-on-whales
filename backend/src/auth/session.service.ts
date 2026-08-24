import { Injectable } from '@nestjs/common';
import { Store, type SessionData } from 'express-session';
import * as signature from 'cookie-signature';
import { eq, lt } from 'drizzle-orm';
import { ConfigService } from '../config/config.service';
import { DbService } from '../db/db.service';
import { sessions } from '../db/schema';
import { AuthService, type PublicUser } from './auth.service';

/** The express-session cookie name — also used to parse the raw cookie header
 * on WS upgrades, where express-session's own middleware never runs. */
export const SESSION_COOKIE_NAME = 'msm.sid';

/**
 * express-session Store backed by the panel's `sessions` table, via Drizzle
 * instead of raw SQL strings. The Store base class's methods are
 * callback-style (not `async`) specifically because a persistent store's
 * operations may be asynchronous — kept that way here (rather than marking
 * these `async`, which would change their declared return type from `void`
 * and risk mismatching the base class's signature) and promise-chained
 * internally so it works unchanged against either DB driver.
 */
export class SqliteSessionStore extends Store {
  constructor(private readonly db: DbService) {
    super();
  }

  override get(
    sid: string,
    cb: (err: unknown, session?: SessionData | null) => void,
  ): void {
    this.db.db
      .select()
      .from(sessions)
      .where(eqSid(sid))
      .then(async (rows) => {
        const row = rows[0];
        if (!row) return cb(null, null);
        if (Date.parse(row.expiresAt) < Date.now()) {
          await this.db.db.delete(sessions).where(eqSid(sid));
          return cb(null, null);
        }
        cb(null, JSON.parse(row.dataJson));
      })
      .catch((err: unknown) => cb(err));
  }

  override set(
    sid: string,
    session: SessionData,
    cb?: (err?: unknown) => void,
  ): void {
    const expires = session.cookie?.expires
      ? new Date(session.cookie.expires).toISOString()
      : new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
    this.db.db
      .insert(sessions)
      .values({ sid, dataJson: JSON.stringify(session), expiresAt: expires })
      .onConflictDoUpdate({
        target: sessions.sid,
        set: { dataJson: JSON.stringify(session), expiresAt: expires },
      })
      .then(() => cb?.(null))
      .catch((err: unknown) => cb?.(err));
  }

  override destroy(sid: string, cb?: (err?: unknown) => void): void {
    this.db.db
      .delete(sessions)
      .where(eqSid(sid))
      .then(() => cb?.(null))
      .catch((err: unknown) => cb?.(err));
  }

  override touch(
    sid: string,
    session: SessionData,
    cb?: (err?: unknown) => void,
  ): void {
    this.set(sid, session, cb);
  }
}

function eqSid(sid: string) {
  return eq(sessions.sid, sid);
}

@Injectable()
export class SessionService {
  readonly cookieName = SESSION_COOKIE_NAME;
  readonly store: SqliteSessionStore;

  constructor(
    private readonly config: ConfigService,
    private readonly dbService: DbService,
    private readonly authService: AuthService,
  ) {
    this.store = new SqliteSessionStore(dbService);
  }

  /**
   * Delete expired session rows. Lives here (service layer) rather than a web
   * middleware so the scheduler doesn't have to reach into an HTTP-layer file.
   * expires_at is ISO-8601 ('…T…Z'); compare against the same ISO shape (a
   * naive datetime('now') would always sort as less-than because 'T' > ' ').
   */
  async pruneExpiredSessions(): Promise<void> {
    // expires_at is ISO-8601 ('…T…Z'); the cutoff must be too — a naive
    // space-separated 'now' would always sort as less-than because 'T' > ' '.
    await this.dbService.db
      .delete(sessions)
      .where(lt(sessions.expiresAt, new Date().toISOString()));
  }

  /**
   * Authenticate a raw `Cookie` header (WS upgrades never run express-session's
   * own middleware) → the signed-in user, or null. Mirrors legacy
   * `src/ws/index.ts`'s `sessionUser()` — the one place that duplicated
   * express-session's cookie-signature verification; unifying it here means
   * both the HTTP guard (via express-session itself) and future WS gateways
   * share one implementation of "what counts as a valid session."
   */
  async authenticateFromCookieHeader(
    cookieHeader: string | undefined,
  ): Promise<PublicUser | null> {
    try {
      const cookies = Object.fromEntries(
        (cookieHeader || '').split(';').map((c) => {
          const idx = c.indexOf('=');
          return [c.slice(0, idx).trim(), decodeURIComponent(c.slice(idx + 1))];
        }),
      );
      const raw = cookies[SESSION_COOKIE_NAME];
      if (!raw || !raw.startsWith('s:')) return null;
      const sid = signature.unsign(raw.slice(2), this.config.sessionSecret);
      if (!sid) return null;
      const [row] = await this.dbService.db
        .select()
        .from(sessions)
        .where(eqSid(sid))
        .limit(1);
      if (!row || Date.parse(row.expiresAt) < Date.now()) return null;
      const data: { userId?: string } = JSON.parse(row.dataJson);
      if (!data.userId) return null;
      return this.authService.getUser(data.userId);
    } catch {
      return null;
    }
  }
}
