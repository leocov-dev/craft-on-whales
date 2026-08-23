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
