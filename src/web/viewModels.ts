'use strict';

// Maps DB rows + live Docker data into the shape the views render.

import type { Server } from '../services/types';

const { getVersionManifest } = require('../services/mojang') as typeof import('../services/mojang');
const db = require('../db') as typeof import('../db');

const GB = 1024 ** 3;

/** An `events` row shape as passed to {@link eventVM} — either the events
 * service's HydratedEvent, or an equivalent object assembled by callers
 * (server_id/details_json spread + parsed `details`). */
interface EventLike {
  id: number;
  server_id: string | null;
  actor: string;
  type: string;
  summary: string;
  log_excerpt_path: string | null;
  created_at: string;
  details: Record<string, unknown>;
}

/** A `crash_reports` row shape as passed to {@link crashVM}. */
interface CrashLike {
  id: string;
  filename: string;
  file_mtime: string;
  size_bytes: number;
  summary: string;
  exception: string;
  suspected_json: string | null;
  viewed: number;
}

/**
 * UX rule (user-mandated): LATEST/SNAPSHOT are never shown bare — always
 * resolve to "LATEST (26.2)" style using the cached Mojang manifest.
 */
async function displayVersion(mcVersion: string): Promise<string> {
  if (mcVersion !== 'LATEST' && mcVersion !== 'SNAPSHOT') return mcVersion;
  try {
    const manifest = await getVersionManifest();
    const resolved = mcVersion === 'LATEST' ? manifest.latest.release : manifest.latest.snapshot;
    return `${mcVersion} (${resolved})`;
  } catch {
    return mcVersion;
  }
}

/**
 * The server view model rendered by templates. NOTE: unlike some other
 * services' row->VM mappers, this one does NOT spread the raw `Server` row —
 * it hand-picks and renames fields into an explicit literal. Every field
 * listed here must match the original .js's explicit object literal 1:1.
 */
interface ServerViewModel {
  id: string;
  name: string;
  description: string;
  icon: string;
  accent: string;
  tags: string[];
  type: string;
  flavor: string;
  loader: string | null;
  mcVersion: string;
  javaTag: string;
  status: string;
  ports: { game: number; rcon: number; bedrock: number | null };
  resources: { heapMb: number; containerMemoryMb: number; cpus: number };
  stats: { cpuPct: number; memUsedMb: number; uptime: string | null };
  players: { online: number; max: number; names: string[] };
  disk: { used: number; quota: number };
  pack: ReturnType<typeof packVM>;
  updateAvailable: boolean;
  crashesUnread: number;
  autoStart: boolean;
  autoRestart: boolean;
  notes: string;
  updatePolicy: 'manual' | 'notify' | 'auto';
  pendingRecreate: boolean;
  lastStarted: string;
  created: string;
  consoleLabel: string;
  statusDetail?: string;
}

async function serverVM(s: Server, { withLive = true }: { withLive?: boolean } = {}): Promise<ServerViewModel> {
  const vm: ServerViewModel = {
    id: s.id,
    name: s.display_name,
    description: s.description,
    icon: s.icon,
    accent: s.accent,
    tags: s.tags,
    type: s.type,
    flavor: flavorLabel(s.type),
    loader: (require('../services/mods') as typeof import('../services/mods')).loaderOf(s), // resolved loader (detects the pack's for modpacks)
    mcVersion: await displayVersion(s.mc_version),
    javaTag: s.java_tag || 'auto',
    status: s.status,
    ports: { game: s.port_game, rcon: s.port_rcon, bedrock: s.port_bedrock },
    resources: { heapMb: s.heap_mb, containerMemoryMb: s.container_memory_mb, cpus: s.cpus },
    stats: { cpuPct: 0, memUsedMb: 0, uptime: null },
    players: { online: 0, max: Number(s.env.MAX_PLAYERS) || 20, names: [] },
    disk: { used: diskUsed(s.id), quota: s.disk_quota_bytes || 25 * GB },
    pack: packVM(s.id),
    updateAvailable: hasPackUpdate(s.id),
    crashesUnread:
      Number(db.get('SELECT COUNT(*) AS n FROM crash_reports WHERE server_id = ? AND viewed = 0', s.id)?.n) || 0,
    autoStart: Boolean(s.auto_start),
    autoRestart: Boolean(s.auto_restart),
    notes: s.notes,
    updatePolicy: s.update_policy,
    pendingRecreate: Boolean(s.pending_recreate),
    lastStarted: s.last_started_at || '—',
    created: s.created_at,
    consoleLabel: s.console_label || '',
  };

  if (withLive && (s.status === 'running' || s.status === 'starting' || s.status === 'unhealthy')) {
    // Never block a page render on Docker: everything comes from the in-memory
    // live cache (fed by streaming stats + periodic rcon list).
    const liveCache = require('../services/liveCache') as typeof import('../services/liveCache');
    const live = liveCache.get(s.id);
    if (live.stats) {
      vm.stats.cpuPct = live.stats.cpuPct;
      vm.stats.memUsedMb = Math.round(live.stats.memUsedBytes / 1024 / 1024);
    }
    if (live.startedAt) vm.stats.uptime = formatUptime(Date.now() - Date.parse(live.startedAt));
    if (live.players) vm.players = { ...vm.players, ...live.players };
    // Boot-phase detail ("Downloading mods…", "Generating world") or the
    // latched "Player count unavailable" state — one shared derivation with
    // the live-poll route, so the SSR chip and the hydrated one can't drift.
    const detail = liveCache.statusDetail(live);
    if (detail) vm.statusDetail = detail;
  }
  return vm;
}

interface PackViewModel {
  platform: string;
  name: string;
  version: string;
  versionId: string;
  latest: string;
  latestVersionId: string | null;
}

function packVM(serverId: string): PackViewModel | null {
  const pack = db.get('SELECT * FROM server_packs WHERE server_id = ?', serverId);
  if (!pack) return null;
  const check = db.get(
    "SELECT latest_version, latest_name FROM update_checks WHERE subject_type = 'pack' AND subject_id = ?",
    serverId
  );
  const platform = String(pack.platform);
  const platformName = ({ curseforge: 'CurseForge', modrinth: 'Modrinth', ftb: 'FTB' } as Record<string, string>)[
    platform
  ];
  return {
    platform: platformName || platform,
    name: String(pack.project_name),
    version: String(pack.pinned_version_name),
    versionId: String(pack.pinned_version_id),
    latest: check && check.latest_name ? String(check.latest_name) : String(pack.pinned_version_name),
    // The real platform id behind `latest` (a display NAME — differs from the id
    // for CurseForge/Modrinth). Modpacks-page "Upgrade" posts this so the request
    // names the exact version the card showed, rather than trusting the server to
    // re-derive "latest" itself. Same pattern as updates.hbs's data-version-id.
    latestVersionId: check && check.latest_version ? String(check.latest_version) : null,
  };
}

function hasPackUpdate(serverId: string): boolean {
  const pack = db.get('SELECT pinned_version_id FROM server_packs WHERE server_id = ?', serverId);
  if (!pack) return false;
  const check = db.get(
    "SELECT latest_version FROM update_checks WHERE subject_type = 'pack' AND subject_id = ?",
    serverId
  );
  return Boolean(check && check.latest_version && check.latest_version !== pack.pinned_version_id);
}

function diskUsed(serverId: string): number {
  const row = db.get('SELECT size_bytes FROM storage_index WHERE rel_path = ?', `servers/${serverId}`);
  return row ? Number(row.size_bytes) : 0;
}

function flavorLabel(type: string): string {
  const map: Record<string, string> = {
    VANILLA: 'Vanilla',
    PAPER: 'Paper',
    PURPUR: 'Purpur',
    PUFFERFISH: 'Pufferfish',
    FOLIA: 'Folia',
    LEAF: 'Leaf',
    SPIGOT: 'Spigot',
    BUKKIT: 'Bukkit',
    FABRIC: 'Fabric',
    FORGE: 'Forge',
    NEOFORGE: 'NeoForge',
    QUILT: 'Quilt',
    AUTO_CURSEFORGE: 'CurseForge pack',
    MODRINTH: 'Modrinth pack',
    FTBA: 'FTB pack',
    CUSTOM: 'Custom jar',
  };
  return map[type] || type;
}

function formatUptime(ms: number): string {
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h ${mins % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function safeJsonParse(json: string | null | undefined): Record<string, unknown> {
  try {
    return JSON.parse(json || '{}');
  } catch {
    return {};
  }
}

interface EventViewModel {
  id: number;
  serverId: string | null;
  server: string;
  type: string;
  actor: string;
  ts: string;
  summary: string;
  hasLog: boolean;
  diff: unknown;
}

function eventVM(e: EventLike): EventViewModel {
  const server = e.server_id
    ? (db.get('SELECT display_name, deleted_at FROM servers WHERE id = ?', e.server_id) as
        { display_name: string; deleted_at: string | null } | undefined)
    : null;
  return {
    id: e.id,
    // Deleted servers keep their name in history but must not be linked (404).
    serverId: server && !server.deleted_at ? e.server_id : null,
    server: server ? server.display_name + (server.deleted_at ? ' (deleted)' : '') : '— panel —',
    type: e.type,
    actor: e.actor,
    ts: e.created_at,
    summary: e.summary,
    hasLog: Boolean(e.log_excerpt_path),
    diff: e.details && e.details.diff ? e.details.diff : null,
  };
}

interface CrashViewModel {
  id: string;
  file: string;
  ts: string;
  size: number;
  summary: string;
  suspected: unknown[];
  viewed: boolean;
}

function crashVM(c: CrashLike): CrashViewModel {
  return {
    id: c.id,
    file: c.filename,
    ts: c.file_mtime,
    size: c.size_bytes,
    summary: c.summary || c.exception,
    suspected: JSON.parse(c.suspected_json || '[]'),
    viewed: Boolean(c.viewed),
  };
}

export = { serverVM, flavorLabel, displayVersion, eventVM, crashVM, safeJsonParse };
