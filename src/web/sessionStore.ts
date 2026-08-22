'use strict';

// express-session Store backed by the panel's SQLite (sessions table).

import type { SessionData } from 'express-session';

const { Store } = require('express-session');
const { dbApi: db } = require('../db') as typeof import('../db');

class SqliteSessionStore extends Store {
  get(sid: string, cb: (err: unknown, session?: SessionData | null) => void): void {
    try {
      const row = db.get('SELECT data_json, expires_at FROM sessions WHERE sid = ?', sid);
      if (!row) return cb(null, null);
      if (Date.parse(String(row.expires_at)) < Date.now()) {
        db.run('DELETE FROM sessions WHERE sid = ?', sid);
        return cb(null, null);
      }
      cb(null, JSON.parse(String(row.data_json)));
    } catch (err) {
      cb(err);
    }
  }

  set(sid: string, session: SessionData, cb: (err?: unknown) => void): void {
    try {
      const expires =
        session.cookie && session.cookie.expires
          ? new Date(session.cookie.expires).toISOString()
          : new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
      db.run(
        `INSERT INTO sessions (sid, data_json, expires_at) VALUES (?, ?, ?)
         ON CONFLICT(sid) DO UPDATE SET data_json = excluded.data_json, expires_at = excluded.expires_at`,
        sid,
        JSON.stringify(session),
        expires
      );
      cb(null);
    } catch (err) {
      cb(err);
    }
  }

  destroy(sid: string, cb: (err?: unknown) => void): void {
    try {
      db.run('DELETE FROM sessions WHERE sid = ?', sid);
      cb(null);
    } catch (err) {
      cb(err);
    }
  }

  touch(sid: string, session: SessionData, cb: (err?: unknown) => void): void {
    this.set(sid, session, cb);
  }
}

export { SqliteSessionStore };
