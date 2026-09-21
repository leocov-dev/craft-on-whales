// Mirrors STATUS_META/STATUS_DOT/STATUS_TEXT and iconSrc() in src/web/app.ts —
// Quasar color names stand in for the original Tailwind classes.

export interface StatusMeta {
  label: string;
  color: 'positive' | 'warning' | 'info' | 'negative' | 'grey';
  pulse: boolean;
}

const STATUS_META: Record<string, StatusMeta> = {
  running: { label: 'Running', color: 'positive', pulse: true },
  starting: { label: 'Starting', color: 'warning', pulse: true },
  unhealthy: { label: 'Unhealthy', color: 'warning', pulse: true },
  updating: { label: 'Updating', color: 'info', pulse: true },
  stopped: { label: 'Stopped', color: 'grey', pulse: false },
  // 'stalled' = still running but never finished booting (see the backend's
  // STARTUP_STALL_MS watchdog) — alive and actionable, not dead.
  stalled: { label: 'Stalled', color: 'warning', pulse: false },
  crashed: { label: 'Crashed', color: 'negative', pulse: false },
  'over-quota': { label: 'Over quota', color: 'negative', pulse: false },
};

export function statusMeta(status: string): StatusMeta {
  return STATUS_META[status] ?? STATUS_META.stopped!;
}

const BUNDLED_ICONS = new Set([
  'chest',
  'creeper',
  'diamond',
  'grass',
  'portal',
  'potion',
  'sword',
  'tnt',
]);

export function iconSrc(name: string | null | undefined): string {
  if (typeof name === 'string' && name.startsWith('custom:')) {
    return `/api/icons/custom/${encodeURIComponent(name.slice('custom:'.length))}`;
  }
  return `/icons/servers/${typeof name === 'string' && BUNDLED_ICONS.has(name) ? name : 'grass'}.png`;
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const idx = Math.min(i, units.length - 1);
  return `${(bytes / 1024 ** idx).toFixed(idx === 0 ? 0 : 1)} ${units[idx]}`;
}

export function pctUsed(used: number, total: number): number {
  return total ? Math.min(100, Math.round((used / total) * 100)) : 0;
}

// Thresholds mirror the panel defaults (config.defaults.quotaWarnPct/quotaCriticalPct);
// hardcoded here until the Settings API is wired up to expose them to the client.
const QUOTA_WARN_PCT = 80;
const QUOTA_CRITICAL_PCT = 95;

export function meterColor(
  used: number,
  total: number,
): 'info' | 'negative' | 'warning' | 'positive' {
  if (!total) return 'info';
  const p = (used / total) * 100;
  if (p >= QUOTA_CRITICAL_PCT) return 'negative';
  if (p >= QUOTA_WARN_PCT) return 'warning';
  return 'positive';
}

/**
 * Field help shown wherever the Java heap is chosen. Java is handed the heap
 * as both its starting and its maximum size, and it fills a heap given up
 * front within the first minute of world generation — with or without Aikar's
 * flags. Measured on Paper 1.21.1 with a 2 GB heap: 2.6 GB resident either
 * way; the same server with a 512 MB initial heap idled at 1.25–1.4 GB.
 */
export const HEAP_FIELD_HINT =
  'Java takes the whole heap up front, so idle memory settles near this figure. Set a smaller INIT_MEMORY to let it grow on demand.';
