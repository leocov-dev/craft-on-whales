'use strict';

// Page routes. Every page renders REAL data — servers, events, crashes,
// backups, updates, schedules, storage, activity, and the global file manager.

import type { Request, Response, NextFunction } from 'express';
import type { ServerExtraPort, ServerExtraBind } from '../../services/types';

const asyncHandler = require('../middleware/asyncHandler') as typeof import('../middleware/asyncHandler');
const express = require('express');
const serversService = require('../../services/servers') as typeof import('../../services/servers');
const eventsService = require('../../events') as typeof import('../../events');
const { serverVM, eventVM, crashVM, safeJsonParse } = require('../viewModels') as typeof import('../viewModels');
const { fetchLogs } = require('../../docker/logs') as typeof import('../../docker/logs');
const db = require('../../db') as typeof import('../../db');
const { requireRole } = require('../middleware/auth') as typeof import('../middleware/auth');
const { PLAYER_NAME_RE, isBedrockName } = require('../../utils/playerName') as typeof import('../../utils/playerName');

const router = express.Router();

/** serverVM's view model, plus the Docker Advanced fields the server-detail
 *  page (and only that page — never serverVM itself, see the comment where
 *  these are assigned below) adds on top. */
type ServerDetailVM = Awaited<ReturnType<typeof serverVM>> & {
  containerName: string | null;
  networkName: string | null;
  extraPorts: ServerExtraPort[];
  extraBinds: ServerExtraBind[];
};

const SERVER_TABS = [
  'overview',
  'console',
  'chat',
  'players',
  'commands',
  'inventory',
  'mods',
  'map',
  'files',
  'worlds',
  'backups',
  'history',
  'analytics',
  'metrics',
  'integrations',
  'settings',
];

// Two-level information architecture: the 15 tabs are grouped into a handful of
// domain sections (top nav), each with a sub-nav of related sections. Inventory is
// not a top tab any more — it lives per-player on the player page. All existing
// routes still work; only the navigation is reorganized.
const TAB_GROUPS = [
  { key: 'overview', label: 'Overview', icon: 'layout-dashboard', tabs: ['overview'] },
  { key: 'console', label: 'Console', icon: 'terminal', tabs: ['console', 'chat'] },
  { key: 'players', label: 'Players', icon: 'users', tabs: ['players', 'inventory', 'analytics', 'commands'] },
  { key: 'world', label: 'World', icon: 'earth', tabs: ['worlds', 'mods', 'map', 'files'] },
  { key: 'backups', label: 'Backups', icon: 'archive', tabs: ['backups'] },
  { key: 'insights', label: 'Insights', icon: 'activity', tabs: ['metrics', 'history'] },
  { key: 'settings', label: 'Settings', icon: 'settings', tabs: ['settings', 'integrations'] },
];
const SUB_LABELS: Record<string, string> = {
  console: 'Console',
  chat: 'Chat',
  players: 'Roster',
  inventory: 'Inventory',
  analytics: 'Stats',
  commands: 'Chat commands',
  worlds: 'Worlds',
  mods: 'Mods',
  map: 'Map',
  files: 'Files',
  metrics: 'Metrics',
  history: 'History',
  settings: 'Configuration',
  integrations: 'Integrations',
};

/** Build the two-level nav (top groups + contextual sub-nav) for a given active tab. */
function buildNav(id: string, tab: string, server: { crashesUnread?: number } | null | undefined) {
  const crashes = server && server.crashesUnread;
  const group = TAB_GROUPS.find((g) => g.tabs.includes(tab)) || TAB_GROUPS[0]!;
  const groups = TAB_GROUPS.map((g) => ({
    label: g.label,
    icon: g.icon,
    href: `/servers/${id}/${g.tabs[0]}`,
    active: g.key === group.key,
    badge: g.tabs.includes('history') && crashes ? crashes : null,
  }));
  const sub =
    group.tabs.length > 1
      ? group.tabs.map((t) => ({
          label: SUB_LABELS[t] || t,
          href: `/servers/${id}/${t}`,
          active: t === tab,
          badge: t === 'history' && crashes ? crashes : null,
        }))
      : null;
  return { groups, sub };
}

// Sidebar data available to every view (lightweight — no live stats).
router.use(
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const rows = serversService.listServers();
    res.locals.servers = await Promise.all(rows.map((s) => serverVM(s, { withLive: false })));
    res.locals.updatesCount = (
      require('../../updates/checker') as typeof import('../../updates/checker')
    ).listOutdated().length;
    // Timezone + locale for client-side date formatting (window.MSM).
    res.locals.panelLocalization = (
      require('../../services/settings') as typeof import('../../services/settings')
    ).clientLocalization();
    next();
  })
);

type ServerVM = Awaited<ReturnType<typeof serverVM>>;

/** res.locals.servers, populated by the sidebar middleware above — typed here
 *  since Express's default Locals shape carries no field types of its own. */
function sidebarServers(res: Response): ServerVM[] {
  return (res.locals.servers as ServerVM[] | undefined) || [];
}

const STATUS_RANK: Record<string, number> = {
  running: 0,
  unhealthy: 1,
  starting: 2,
  updating: 3,
  crashed: 4,
  'over-quota': 5,
  stopped: 6,
};
const DASH_SORTS: Record<string, (a: ServerVM, b: ServerVM) => number> = {
  status: (a, b) => (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9) || a.name.localeCompare(b.name),
  name: (a, b) => a.name.localeCompare(b.name),
  size: (a, b) => b.disk.used - a.disk.used,
  started: (a, b) => String(b.lastStarted).localeCompare(String(a.lastStarted)),
  created: (a, b) => String(b.created).localeCompare(String(a.created)),
};

async function renderServerList(
  req: Request,
  res: Response,
  next: NextFunction,
  { page }: { page: 'dashboard' | 'servers' }
) {
  try {
    const rows = serversService.listServers();
    const servers = await Promise.all(rows.map((s) => serverVM(s)));
    const sort = DASH_SORTS[String(req.query.sort)] ? String(req.query.sort) : 'status';
    servers.sort(DASH_SORTS[sort]!);
    const context: Record<string, unknown> = {
      title: page === 'servers' ? 'Servers' : 'Dashboard',
      active: page,
      serversOnly: page === 'servers', // hides the stat row + activity feed
      servers,
      sort,
      noServers: servers.length === 0,
      totals: {
        // "online" means answering — a server still booting isn't.
        running: servers.filter((s) => s.status === 'running' || s.status === 'unhealthy').length,
        total: servers.length,
        players: servers.reduce((n, s) => n + s.players.online, 0),
        updates: res.locals.updatesCount,
      },
      activity: [] as ReturnType<typeof eventVM>[],
    };
    if (page === 'dashboard') {
      const events = eventsService.listEvents({ limit: 6 }).filter((e) => !e.type.endsWith('-requested'));
      context.activity = events.map(eventVM);
    }
    res.render('dashboard', context);
  } catch (err) {
    next(err);
  }
}

router.get('/', (req: Request, res: Response, next: NextFunction) =>
  renderServerList(req, res, next, { page: 'dashboard' })
);
router.get('/servers', (req: Request, res: Response, next: NextFunction) =>
  renderServerList(req, res, next, { page: 'servers' })
);

router.get('/servers/new', async (req: Request, res: Response) => {
  const mojang = require('../../services/mojang') as typeof import('../../services/mojang');
  let versions: Awaited<ReturnType<typeof mojang.listVersions>> = [];
  let latestRelease = '';
  try {
    // Every channel — releases, snapshots, betas and alphas — so the picker can
    // offer the full history; the template groups them by type.
    versions = await mojang.listVersions({ includeAll: true, limit: 5000 });
    latestRelease = (await mojang.getVersionManifest()).latest.release;
  } catch {
    /* offline — manual entry still works */
  }
  // Whether the "From mods" tab can offer CurseForge search (needs the stored key).
  let curseforgeEnabled = false;
  try {
    curseforgeEnabled = Boolean(
      (require('../../services/apiKeys') as typeof import('../../services/apiKeys')).getKey('curseforge')
    );
  } catch {
    /* no key store yet */
  }
  let suggestedPort = 25565;
  try {
    suggestedPort = (await (require('../../services/ports') as typeof import('../../services/ports')).suggestPorts())
      .game;
  } catch {
    /* daemon down */
  }
  const catalog = require('../../config/field-catalog') as typeof import('../../config/field-catalog');
  const SIMPLE_SECTIONS = new Set(['identity', 'flavor', 'resources']); // covered by the Simple UI
  const advancedSections = catalog.SECTIONS.filter((s) => !SIMPLE_SECTIONS.has(s.id))
    .map((s) => ({ ...s, fields: catalog.forSection(s.id, 'advanced').filter((f) => f.scope === 'env') }))
    .filter((s) => s.fields.length);
  res.render('wizard', {
    title: 'Create server',
    active: 'servers',
    blueprints: (require('../../blueprints') as typeof import('../../blueprints')).listBlueprints(),
    versions,
    latestRelease,
    suggestedPort,
    advancedSections,
    curseforgeEnabled,
  });
});

// Per-player page: opened by clicking a player in the roster. Shows that player's
// roles/ban/teleport controls and their full inventory (the Players+Inventory merge).
router.get(
  '/servers/:id/players/:name',
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const row = serversService.getServer(String(req.params.id));
    if (!row) return next();
    const name = String(req.params.name || '');
    if (!PLAYER_NAME_RE.test(name)) return next();
    const server = await serverVM(row);
    const playersService = require('../../services/players') as typeof import('../../services/players');
    const running = server.status === 'running' || server.status === 'unhealthy';
    let player: ReturnType<typeof playersService.listPlayers>[number] = {
      name,
      bedrock: isBedrockName(name),
      uuid: null,
      online: false,
      whitelisted: false,
      op: false,
      opLevel: null,
      bypassesPlayerLimit: false,
      banned: false,
      banReason: null,
      banDate: null,
      banSource: null,
      lastSeen: null,
    };
    try {
      const onlineNames = running ? await playersService.listOnlineNames(row.id).catch(() => []) : [];
      const found = playersService
        .listPlayers(row.id, onlineNames)
        .find((p) => (p.name || '').toLowerCase() === name.toLowerCase());
      if (found) player = found;
    } catch {
      /* offline / rcon down — render with the fallback */
    }
    res.render('server-player', {
      title: `${player.name} · ${server.name}`,
      active: 'servers',
      server,
      tab: 'players',
      nav: buildNav(row.id, 'players', server),
      player,
    });
  })
);

router.get(
  '/servers/:id/:tab?',
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const row = serversService.getServer(String(req.params.id));
    if (!row) return next();
    const tab = String(req.params.tab || 'overview');
    if (!SERVER_TABS.includes(tab)) return next();

    const server = (await serverVM(row)) as ServerDetailVM;
    // Docker settings (container name, network, extra ports/binds — including
    // host filesystem paths) are added ONLY here, never in serverVM, since
    // that view model is shared with the public /status/:slug page.
    server.containerName = row.containerName;
    server.networkName = row.networkName;
    server.extraPorts = row.extraPorts;
    server.extraBinds = row.extraBinds;
    const context: Record<string, unknown> = {
      title: server.name,
      active: 'servers',
      server,
      tab,
      tabs: SERVER_TABS,
      nav: buildNav(row.id, tab, server),
      mods: [],
      backups: [],
      worlds: [],
      consoleLines: [],
      events: [],
      crashReports: [],
      quotaGb: Math.round((row.disk_quota_bytes || 0) / 1024 ** 3),
    };

    if (tab === 'overview') {
      // Connect addresses: the configured public domain first (if any), then LAN
      // IPv4s + game port, ready to copy.
      const os = require('node:os') as typeof import('node:os');
      const addrs: string[] = [];
      const publicAddr = (require('../../services/settings') as typeof import('../../services/settings')).publicAddress(
        row.port_game
      );
      if (publicAddr) addrs.push(publicAddr);
      for (const nics of Object.values(os.networkInterfaces())) {
        for (const nic of nics || []) {
          if (nic.family === 'IPv4' && !nic.internal) addrs.push(`${nic.address}:${row.port_game}`);
        }
      }
      addrs.push(`localhost:${row.port_game}`);
      context.addresses = [...new Set(addrs)];
    } else if (tab === 'chat') {
      const live = (require('../../services/liveCache') as typeof import('../../services/liveCache')).get(row.id);
      context.onlinePlayers = (live && live.players && live.players.names) || [];
      // Recent sends (oldest first) so the history pane survives reloads and
      // is shared across admins — chat.js replays them with the live preview.
      context.chatHistory = (require('../../events') as typeof import('../../events'))
        .listEvents({ serverId: row.id, type: 'chat-sent', limit: 50 })
        .map((e) => ({ ts: e.created_at, actor: e.actor, ...e.details }))
        .reverse();
    } else if (tab === 'mods') {
      context.mods = await (require('../../services/mods') as typeof import('../../services/mods'))
        .listContent(row.id)
        .catch(() => []);
    } else if (tab === 'worlds') {
      const worldsService = require('../../services/worlds') as typeof import('../../services/worlds');
      context.worlds = await worldsService.listServerWorlds(row.id).catch(() => []);
      context.libraryWorlds = worldsService.libraryWorlds();
      // Copy-to target list, serialized in one piece by the json helper — the
      // view used to hand-assemble this JSON attribute field by field.
      context.serverOptions = sidebarServers(res).map((s) => ({
        id: s.id,
        name: s.name,
        flavor: s.flavor,
        status: s.status,
      }));
    } else if (tab === 'files') {
      const filesService = require('../../services/files') as typeof import('../../services/files');
      const rel = String(req.query.path || '');
      try {
        const listing = await filesService.list(row.id, rel);
        context.files = listing.entries;
        context.filePath = listing.path;
        const crumbs = listing.path
          ? listing.path.split('/').map((seg, i, a) => ({ name: seg, path: a.slice(0, i + 1).join('/') }))
          : [];
        context.crumbs = crumbs;
        context.parentPath = crumbs.length > 1 ? crumbs[crumbs.length - 2]!.path : '';
      } catch {
        context.files = [];
        context.filePath = '';
        context.crumbs = [];
        context.parentPath = '';
      }
    } else if (tab === 'map') {
      const mapService = require('../../services/map') as typeof import('../../services/map');
      const cfg = mapService.getMapConfig(row.id);
      context.mapEnabled = cfg.enabled;
      context.mapSupported = mapService.supportsMap(row);
    } else if (tab === 'metrics') {
      // Real per-category sizes from the storage index (view contract:
      // [{label, size, pct, color}]; empty → "run a scan" state).
      const indexer = require('../../storage/indexer') as typeof import('../../storage/indexer');
      const total = indexer.sizeOf(`servers/${row.id}`);
      if (total > 0) {
        const cats = [
          { label: 'World(s)', rel: 'world', color: 'bg-grass-500' },
          { label: 'Mods', rel: 'mods', color: 'bg-diamond-400' },
          { label: 'Plugins', rel: 'plugins', color: 'bg-diamond-400' },
          { label: 'Logs', rel: 'logs', color: 'bg-gold-400' },
          { label: 'Config', rel: 'config', color: 'bg-stone-500' },
        ];
        const rows = [];
        let accounted = 0;
        for (const c of cats) {
          const size = indexer.sizeOf(`servers/${row.id}/${c.rel}`);
          if (size > 0) {
            rows.push({ label: c.label, size, pct: Math.round((size / total) * 100), color: c.color });
            accounted += size;
          }
        }
        const other = total - accounted;
        if (other > 0)
          rows.push({
            label: 'Config & other',
            size: other,
            pct: Math.max(1, Math.round((other / total) * 100)),
            color: 'bg-stone-500',
          });
        context.breakdown = rows;
      }
    } else if (tab === 'settings') {
      // MOTD editing: expose the env for a client-side merge-and-PATCH; the
      // stored §-codes become &-codes for friendly editing.
      context.settingsEnv = JSON.stringify(row.env);
      context.motd = String(row.env.MOTD || '').replace(/§([0-9a-fk-orA-FK-OR])/g, '&$1');
    } else if (tab === 'integrations') {
      context.integrations = {
        discord: (require('../../integrations/discord') as typeof import('../../integrations/discord')).getConfig(
          row.id
        ),
        statusPage: (
          require('../../integrations/statusPage') as typeof import('../../integrations/statusPage')
        ).getStatusPage(row.id),
        invite: await (require('../../integrations/invites') as typeof import('../../integrations/invites'))
          .inviteInfo(row.id)
          .catch(() => null),
      };
    } else if (tab === 'players') {
      const playersService = require('../../services/players') as typeof import('../../services/players');
      let online: string[] = [];
      if (server.status === 'running') {
        online = await Promise.resolve(playersService.listOnlineNames(row.id)).catch(() => []);
      }
      try {
        context.players = playersService.listPlayers(row.id, online);
        context.bannedIps = playersService.listBannedIps(row.id);
        context.whitelistEnforced = playersService.getWhitelistEnforced(row.id);
      } catch {
        context.players = [];
        context.bannedIps = [];
        context.whitelistEnforced = false;
      }
    } else if (tab === 'commands') {
      const chatCommands = require('../../services/chatCommands') as typeof import('../../services/chatCommands');
      context.chatPrefix = chatCommands.getPrefix(row.id);
      context.chatCommands = chatCommands.listCommands(row.id).map((c) => ({
        ...c,
        actionSummary: chatCommands.actionSummary(c),
        cooldownLabel: c.cooldown_sec > 0 ? `${c.cooldown_sec}s` : 'none',
        lastUsed: c.last_used_at || null,
      }));
      context.chatCommandEvents = eventsService
        .listEvents({ serverId: row.id, type: 'chat-command', limit: 10 })
        .map((e) => ({ ts: e.created_at, summary: e.summary, failed: e.details && e.details.success === false }));
    } else if (tab === 'console') {
      const { stripAnsi } = require('../../utils/ansi') as typeof import('../../utils/ansi');
      const raw = await fetchLogs(row.id, { tail: 300 }).catch(() => '');
      context.consoleLines = raw
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => {
          const text = stripAnsi(line); // SSR lines are plain; live WS lines get real ANSI rendering
          return { text, level: /\/(ERROR|FATAL)\]/.test(text) ? 'ERROR' : /\/WARN\]/.test(text) ? 'WARN' : 'INFO' };
        });
      context.wsConsole = true;
    } else if (tab === 'history') {
      context.events = eventsService.listEvents({ serverId: row.id, limit: 100 }).map(eventVM);
      context.crashReports = db
        .all('SELECT * FROM crash_reports WHERE server_id = ? ORDER BY file_mtime DESC', row.id)
        .map((r) => crashVM(r as unknown as Parameters<typeof crashVM>[0]));
    } else if (tab === 'backups') {
      context.backups = db
        .all('SELECT * FROM backups WHERE server_id = ? ORDER BY created_at DESC', row.id)
        .map((b) => ({ id: b.id, file: b.filename, size: b.size_bytes, reason: b.reason, ts: b.created_at }));
    }

    res.render('server-detail', context);
  })
);

router.get('/modpacks', async (req: Request, res: Response) => {
  const withPacks = sidebarServers(res).filter((s) => s.pack);
  // NB: never pass this under the `servers` key — that shadows res.locals.servers
  // and silently filters the sidebar's server list.
  res.render('modpacks', { title: 'Modpacks', active: 'modpacks', packServers: withPacks });
});

router.get('/worlds', (req: Request, res: Response) => {
  res.render('worlds', {
    title: 'Worlds',
    active: 'worlds',
    worlds: (require('../../services/worlds') as typeof import('../../services/worlds')).libraryWorlds(),
    // Install/extract target list — one json call, not hand-assembled JSON.
    serverOptions: sidebarServers(res).map((s) => ({
      id: s.id,
      name: s.name,
      flavor: s.flavor,
      status: s.status,
    })),
  });
});

router.get('/blueprints', (req: Request, res: Response) => {
  res.render('blueprints', {
    title: 'Blueprints',
    active: 'blueprints',
    blueprints: (require('../../blueprints') as typeof import('../../blueprints')).listBlueprints(),
  });
});

router.get('/updates', (req: Request, res: Response) => {
  const checker = require('../../updates/checker') as typeof import('../../updates/checker');
  res.render('updates', {
    title: 'Updates',
    active: 'updates',
    // Changelog URLs come from remote platform APIs — allow only http(s) so a
    // hostile response can never plant a javascript: link.
    updates: checker.listOutdated().map((u) => ({
      ...u,
      changelog: /^https?:\/\//i.test(u.changelogUrl || '') ? u.changelogUrl : null,
    })),
    lastChecked: checker.lastCheckedAt() || null,
  });
});

router.get('/backups', (req: Request, res: Response) => {
  const backups = db
    .all(`SELECT b.*, s.display_name FROM backups b JOIN servers s ON s.id = b.server_id ORDER BY b.created_at DESC`)
    .map((b) => ({
      id: b.id,
      serverId: b.server_id,
      server: b.display_name,
      file: b.filename,
      size: Number(b.size_bytes) || 0,
      reason: b.reason,
      ts: b.created_at,
    }));
  res.render('backups', {
    title: 'Backups',
    active: 'backups',
    backups,
    totals: { count: backups.length, bytes: backups.reduce((n, b) => n + (b.size || 0), 0) },
  });
});

router.get('/schedules', (req: Request, res: Response) => {
  const scheduler = require('../../services/scheduler') as typeof import('../../services/scheduler');
  res.render('schedules', {
    title: 'Schedules',
    active: 'schedules',
    schedules: scheduler.listSchedules(),
    taskTypes: Object.entries(scheduler.TASK_TYPES).map(([value, t]) => ({
      value,
      label: t.label,
      serverScoped: t.serverScoped,
    })),
    serverOptions: sidebarServers(res).map((s) => ({ id: s.id, name: s.name })),
  });
});

router.get(
  '/storage',
  requireRole('admin'),
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const indexer = require('../../storage/indexer') as typeof import('../../storage/indexer');
    const { free, total } = await indexer.diskFree().catch(() => ({ free: 0, total: 0 }));
    const catNames = {
      servers: 'Servers',
      backups: 'Backups',
      'library/worlds': 'Library — worlds',
      'library/mods': 'Library — mods & content',
      'library/modpacks': 'Library — modpacks',
      'library/icons': 'Library — icons',
      logs: 'Logs & event captures',
      blueprints: 'Blueprints',
      tmp: 'tmp',
    };
    const categories = Object.entries(catNames)
      .map(([rel, name]) => ({
        name,
        path: `${rel}/`,
        link: `/files?path=${encodeURIComponent(rel)}`,
        size: indexer.sizeOf(rel),
      }))
      .filter((c) => c.size > 0 || ['servers', 'backups', 'tmp'].includes(c.path.replace(/\/$/, '')));
    const snapshots = db.all('SELECT total_bytes FROM storage_snapshots ORDER BY id DESC LIMIT 14').reverse();
    const maxSnap = Math.max(1, ...snapshots.map((s) => Number(s.total_bytes) || 0));

    const totalUsed = indexer.sizeOf('');
    // Real category bar: servers / backups / library / other, from the index.
    const segs = [
      { label: 'Servers', cls: 'bg-grass-600', size: indexer.sizeOf('servers') },
      { label: 'Backups', cls: 'bg-diamond-500', size: indexer.sizeOf('backups') },
      { label: 'Library', cls: 'bg-gold-400', size: indexer.sizeOf('library') },
    ];
    segs.push({
      label: 'Logs, blueprints, tmp',
      cls: 'bg-stone-500',
      size: Math.max(0, totalUsed - segs.reduce((n, s) => n + s.size, 0)),
    });
    const breakdown = segs.map((s) => ({
      ...s,
      width: totalUsed ? Math.max(0.5, (s.size / totalUsed) * 100).toFixed(1) : 0,
    }));

    const { runCleanup, largestFiles, DEFAULT_DAYS } = require('./storageCleanup') as typeof import('./storageCleanup');
    const preview = async (action: Parameters<typeof runCleanup>[0], label: string, olderThanDays?: number) => {
      const p = await runCleanup(action, { olderThanDays, dryRun: true }).catch(() => ({ freedBytes: 0, removed: 0 }));
      return { key: action, action: label, frees: p.freedBytes, count: p.removed, days: olderThanDays || null };
    };
    const cleanup = await Promise.all([
      preview('tmp', 'Purge tmp/ (files older than 1 h)'),
      preview('orphans', 'Remove orphaned library files'),
      preview('old-logs', `Delete archived logs older than ${DEFAULT_DAYS} days`, DEFAULT_DAYS),
      preview('old-crashes', `Delete crash reports older than ${DEFAULT_DAYS} days`, DEFAULT_DAYS),
    ]);

    const largest = (await largestFiles({ top: 15, maxScan: 3000 }).catch(() => [])).map((f) => ({
      ...f,
      link: `/files?path=${encodeURIComponent(f.path.split('/').slice(0, -1).join('/'))}`,
    }));

    res.render('storage', {
      title: 'Storage',
      active: 'storage',
      storage: {
        totalUsed,
        diskFree: free,
        diskTotal: total,
        lastScan: indexer.lastScan() || 'not yet',
        categories,
        breakdown,
        largestFiles: largest,
        cleanup,
        trend: snapshots.map((s) => Math.max(4, Math.round(((Number(s.total_bytes) || 0) / maxSnap) * 100))),
      },
    });
  })
);

const ACTIVITY_PER_PAGE = 50;

router.get('/activity', (req: Request, res: Response) => {
  const q = String(req.query.q || '')
    .trim()
    .slice(0, 200);
  const server = String(req.query.server || '')
    .trim()
    .slice(0, 40);
  const type = String(req.query.type || '')
    .trim()
    .slice(0, 60);
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (server) {
    where.push('server_id = ?');
    params.push(server);
  }
  if (type) {
    where.push('type = ?');
    params.push(type);
  }
  if (q) {
    where.push('(summary LIKE ? OR actor LIKE ? OR type LIKE ?)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const total = Number(db.get(`SELECT COUNT(*) AS n FROM events ${whereSql}`, ...params)?.n) || 0;
  const pages = Math.max(1, Math.ceil(total / ACTIVITY_PER_PAGE));
  const page = Math.min(pages, Math.max(1, parseInt(String(req.query.page || ''), 10) || 1));
  const events = db
    .all(
      `SELECT * FROM events ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`,
      ...params,
      ACTIVITY_PER_PAGE,
      (page - 1) * ACTIVITY_PER_PAGE
    )
    .map((r) =>
      eventVM({ ...r, details: safeJsonParse(String(r.details_json)) } as unknown as Parameters<typeof eventVM>[0])
    );

  const filterParams = new URLSearchParams();
  if (q) filterParams.set('q', q);
  if (server) filterParams.set('server', server);
  if (type) filterParams.set('type', type);
  const filterQs = filterParams.toString(); // without page
  const pageHref = (p: number) => `/activity?${filterQs ? filterQs + '&' : ''}page=${p}`;

  res.render('activity', {
    title: 'Activity',
    active: 'activity',
    events,
    types: db.all('SELECT DISTINCT type FROM events ORDER BY type').map((r) => r.type),
    filters: { q, server, type },
    exportQs: filterQs ? `&${filterQs}` : '',
    total,
    page,
    pages,
    from: total ? (page - 1) * ACTIVITY_PER_PAGE + 1 : 0,
    to: Math.min(page * ACTIVITY_PER_PAGE, total),
    prevHref: page > 1 ? pageHref(page - 1) : null,
    nextHref: page < pages ? pageHref(page + 1) : null,
  });
});

// Global file manager over ./data (admin only — full panel data access).
router.get(
  '/files',
  (require('../middleware/auth') as typeof import('../middleware/auth')).requireRole('admin'),
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const filesService = require('../../services/files') as typeof import('../../services/files');
    const rel = String(req.query.path || '');
    let listing;
    try {
      listing = await filesService.list(null, rel);
    } catch {
      return res.redirect('/files'); // stale/invalid path — back to the root
    }
    const crumbs = listing.path
      ? listing.path.split('/').map((seg, i, a) => {
          const p = a.slice(0, i + 1).join('/');
          return { name: seg, path: p, enc: encodeURIComponent(p) };
        })
      : [];
    res.render('files-global', {
      title: 'File manager',
      active: 'storage',
      files: listing.entries.map((e) => ({ ...e, enc: encodeURIComponent(e.path) })),
      filePath: listing.path,
      crumbs,
      parentEnc: crumbs.length > 1 ? crumbs[crumbs.length - 2]!.enc : '',
    });
  })
);

router.get('/settings', requireRole('admin'), (req: Request, res: Response) => {
  const apiKeys = require('../../services/apiKeys') as typeof import('../../services/apiKeys');
  const config = require('../../config') as typeof import('../../config');
  res.render('settings', {
    title: 'Settings',
    active: 'settings',
    cfKeyMasked: apiKeys.maskedKey('curseforge'),
    publicHost: (require('../../services/settings') as typeof import('../../services/settings')).getPublicHost(),
    users: (require('../../services/auth') as typeof import('../../services/auth')).listUsers(),
    panel: { host: config.host, port: config.port },
    defaults: config.defaults,
  });
});

router.get('/login', (req: Request, res: Response) => {
  res.render('login', { title: 'Sign in', layout: 'bare' });
});

export = router;
