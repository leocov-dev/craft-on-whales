'use strict';

// Action-history service. Every panel feature routes its notable actions
// through recordEvent() so history can never drift out of sync with behavior.

import type { Row } from '../db/types';

const fs = require('node:fs');
const path = require('node:path');
const { nanoid } = require('nanoid');
const db = require('../db');
const { dataPath } = require('../storage/pathGuard');

/** An `events` row (see db/migrations/001_init.ts), cast from the db layer's
 * generic row shape so property access type-checks normally. */
interface EventRow {
  id: number;
  server_id: string | null;
  actor: string;
  type: string;
  summary: string;
  details_json: string;
  log_excerpt_path: string | null;
  created_at: string;
}

/** An event row with `details_json` parsed into `details`. */
interface HydratedEvent extends Omit<EventRow, 'details_json'> {
  details: Record<string, unknown>;
}

interface RecordEventOptions {
  /** null for panel-global events */
  serverId?: string | null;
  /** username | 'system' | 'scheduler' */
  actor?: string;
  /** kebab-case event type ('started', 'config-changed', …) */
  type: string;
  /** human-readable one-liner */
  summary: string;
  /** structured payload (diffs, versions, sizes…) */
  details?: Record<string, unknown>;
  /** raw text to persist alongside the event */
  logExcerpt?: string | null;
}

/** Record an event. Returns the new event id. */
function recordEvent({
  serverId = null,
  actor = 'system',
  type,
  summary,
  details = {},
  logExcerpt = null,
}: RecordEventOptions): number {
  let excerptRel: string | null = null;
  if (logExcerpt) {
    // nanoid suffix: two events of the same type in the same millisecond must
    // not overwrite each other's captured logs.
    excerptRel = path.posix.join('logs', serverId || '_panel', 'events', `${Date.now()}-${type}-${nanoid(4)}.log`);
    const abs = dataPath(excerptRel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    // Cap captures at 256 KB so a runaway log can't flood the data dir.
    fs.writeFileSync(abs, logExcerpt.slice(-256 * 1024));
  }
  const result = db.run(
    `INSERT INTO events (server_id, actor, type, summary, details_json, log_excerpt_path)
     VALUES (?, ?, ?, ?, ?, ?)`,
    serverId,
    actor,
    type,
    summary,
    JSON.stringify(details),
    excerptRel
  );
  return Number(result.lastInsertRowid);
}

interface ListEventsOptions {
  serverId?: string | null;
  type?: string | null;
  limit?: number;
  offset?: number;
}

function listEvents({ serverId = null, type = null, limit = 50, offset = 0 }: ListEventsOptions = {}): HydratedEvent[] {
  const where: string[] = [];
  const params: Row[keyof Row][] = [];
  if (serverId) {
    where.push('server_id = ?');
    params.push(serverId);
  }
  if (type) {
    where.push('type = ?');
    params.push(type);
  }
  const sql = `SELECT * FROM events ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY id DESC LIMIT ? OFFSET ?`;
  return db.all(sql, ...params, limit, offset).map((row: Row) => hydrate(row as unknown as EventRow));
}

function getEvent(id: number): HydratedEvent | null {
  const row = db.get('SELECT * FROM events WHERE id = ?', id);
  return row ? hydrate(row as unknown as EventRow) : null;
}

function readExcerpt(event: Pick<EventRow, 'log_excerpt_path'>): string | null {
  if (!event.log_excerpt_path) return null;
  try {
    return fs.readFileSync(dataPath(event.log_excerpt_path), 'utf8');
  } catch {
    return null;
  }
}

function hydrate(row: EventRow): HydratedEvent {
  return { ...row, details: JSON.parse(row.details_json || '{}') };
}

function safeParse(json: string | null | undefined): Record<string, unknown> {
  try {
    return JSON.parse(json || '{}');
  } catch {
    return {};
  }
}

const EXPORT_LIMIT = 10000;

interface ExportEventsOptions {
  format?: 'json' | 'csv';
  q?: string;
  type?: string;
}

interface ExportedEvents {
  filename: string;
  contentType: string;
  body: string;
}

/** Export events as a downloadable JSON or CSV string. */
function exportEvents(
  serverId: string | null | undefined,
  { format = 'json', q = '', type = '' }: ExportEventsOptions = {}
): ExportedEvents {
  const fmt = format === 'csv' ? 'csv' : 'json';
  const where: string[] = [];
  const params: Row[keyof Row][] = [];
  if (serverId) {
    where.push('server_id = ?');
    params.push(serverId);
  }
  if (type) {
    where.push('type = ?');
    params.push(String(type));
  }
  if (q) {
    where.push('(summary LIKE ? OR actor LIKE ? OR type LIKE ?)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  const rows = db.all(
    `SELECT id, created_at, server_id, actor, type, summary, details_json FROM events
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`,
    ...params,
    EXPORT_LIMIT
  ) as unknown as EventRow[];
  const stamp = new Date().toISOString().slice(0, 10);
  const filename = `events-${serverId || 'all'}-${stamp}.${fmt}`;
  if (fmt === 'json') {
    const body = JSON.stringify(
      rows.map((r) => ({ ...r, details: safeParse(r.details_json), details_json: undefined })),
      null,
      2
    );
    return { filename, contentType: 'application/json', body };
  }
  const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const body = ['id,created_at,server_id,actor,type,summary']
    .concat(rows.map((r) => [r.id, r.created_at, r.server_id || '', r.actor, r.type, r.summary].map(esc).join(',')))
    .join('\r\n');
  return { filename, contentType: 'text/csv', body };
}

/** Delete events (and their captured log excerpts) older than `days`. */
function pruneEvents(days: number, { actor = 'system' }: { actor?: string } = {}): { removed: number } {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
  const rows = db.all('SELECT id, log_excerpt_path FROM events WHERE created_at < ?', cutoff) as unknown as Pick<
    EventRow,
    'id' | 'log_excerpt_path'
  >[];
  for (const row of rows) {
    if (row.log_excerpt_path) {
      try {
        fs.rmSync(dataPath(row.log_excerpt_path), { force: true });
      } catch {
        /* best-effort */
      }
    }
  }
  db.run('DELETE FROM events WHERE created_at < ?', cutoff);
  recordEvent({
    actor,
    type: 'events-pruned',
    summary: `Event history pruned: ${rows.length} event(s) older than ${days} days removed`,
  });
  return { removed: rows.length };
}

export = { recordEvent, listEvents, getEvent, readExcerpt, exportEvents, pruneEvents };
