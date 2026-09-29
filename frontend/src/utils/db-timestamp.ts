// `date part`, `time part`, optional fractional seconds, optional zone. The zone accepts `Z`
// and every offset shape a database emits: `+00` (Postgres timestamptz::text under the default
// ISO DateStyle when the offset has no minutes), `+0000`, and `+00:00`.
const DB_TIMESTAMP =
  /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?)(?:\.(\d+))?(Z|[+-]\d{2}(?::?\d{2})?)?$/i;

/**
 * Parse a timestamp string as stored by either database backend into a `Date`.
 *
 * - SQLite's `datetime('now')` is zoneless (`YYYY-MM-DD HH:MM:SS`) but always UTC, so a
 *   missing zone is treated as UTC rather than local time.
 * - Postgres's `timestamptz::text` carries an offset, which may be just `+00` / `-05`. Those
 *   hour-only offsets aren't valid in the ECMAScript date-time format (V8 returns
 *   `Invalid Date` for them), so every offset is normalized to `±HH:MM`. Fractional seconds
 *   are cut to milliseconds for the same reason (Postgres emits microseconds).
 *
 * Anything that doesn't look like a database timestamp falls through to `new Date()` as-is.
 */
export function parseDbTimestamp(value: string): Date {
  const match = DB_TIMESTAMP.exec(value.trim());
  if (!match) return new Date(value);
  const [, date, time, fraction, zone] = match;
  const millis = fraction ? `.${fraction.slice(0, 3).padEnd(3, '0')}` : '';
  let offset = 'Z';
  if (zone && zone.toUpperCase() !== 'Z') {
    const digits = zone.slice(1).replace(':', '');
    offset = `${zone[0]}${digits.slice(0, 2)}:${digits.slice(2) || '00'}`;
  }
  return new Date(`${date}T${time}${millis}${offset}`);
}
