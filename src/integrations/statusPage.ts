'use strict';

// Public status page config (MP9). Opt-in per server; the slug is the only
// thing exposed publicly, stored in plain config_json (nothing secret here).

import type { IntegrationRow } from './types';

import { httpError } from '../utils/httpError';
const { dbApi: db } = require('../db');

const KIND = 'status-page';
const SLUG_RE = /^[a-z0-9-]{3,40}$/;

interface StatusPageConfig {
  enabled: boolean;
  slug: string | null;
  path: string | null;
}

function getStatusPage(serverId: string): StatusPageConfig {
  const r: IntegrationRow | undefined = db.get(
    'SELECT * FROM integrations WHERE server_id = ? AND kind = ?',
    serverId,
    KIND
  );
  const cfg = r ? JSON.parse(String(r.config_json || '{}')) : {};
  return {
    enabled: Boolean(r && r.enabled),
    slug: cfg.slug || null,
    path: cfg.slug ? `/status/${cfg.slug}` : null,
  };
}

function setStatusPage(serverId: string, { enabled, slug }: { enabled?: boolean; slug?: string }): StatusPageConfig {
  // Disabling never needs a slug — keep the stored one so re-enabling
  // restores the same address.
  if (!enabled && !slug) {
    const existing = getStatusPage(serverId);
    db.run(
      `INSERT INTO integrations (server_id, kind, enabled, config_json, updated_at)
       VALUES (?, ?, 0, ?, datetime('now'))
       ON CONFLICT(server_id, kind) DO UPDATE SET enabled = 0, updated_at = excluded.updated_at`,
      serverId,
      KIND,
      JSON.stringify({ slug: existing.slug || null })
    );
    return getStatusPage(serverId);
  }
  if (!slug || !SLUG_RE.test(slug))
    throw httpError(400, 'Slug must be 3–40 chars of lowercase letters, digits, or dashes');
  const clash = (
    db.all('SELECT server_id, config_json FROM integrations WHERE kind = ?', KIND) as IntegrationRow[]
  ).find((r) => r.server_id !== serverId && JSON.parse(String(r.config_json || '{}')).slug === slug);
  if (clash) throw httpError(409, `The slug "${slug}" is already used by another server`);

  db.run(
    `INSERT INTO integrations (server_id, kind, enabled, config_json, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(server_id, kind) DO UPDATE SET
       enabled = excluded.enabled, config_json = excluded.config_json, updated_at = excluded.updated_at`,
    serverId,
    KIND,
    enabled ? 1 : 0,
    JSON.stringify({ slug })
  );
  return getStatusPage(serverId);
}

/** Resolve an ENABLED status page by slug → server_id, or null. */
function findBySlug(slug: string): string | null {
  if (!SLUG_RE.test(String(slug))) return null;
  const r = (
    db.all('SELECT server_id, config_json FROM integrations WHERE kind = ? AND enabled = 1', KIND) as IntegrationRow[]
  ).find((row) => JSON.parse(String(row.config_json || '{}')).slug === slug);
  return r ? r.server_id : null;
}

export { getStatusPage, setStatusPage, findBySlug, SLUG_RE };
