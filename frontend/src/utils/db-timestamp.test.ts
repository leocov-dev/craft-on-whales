import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDbTimestamp } from './db-timestamp.ts';

const UTC_NOON = '2026-09-29T12:34:56.000Z';

const cases: Array<[input: string, expected: string]> = [
  // SQLite datetime('now'): zoneless, always UTC.
  ['2026-09-29 12:34:56', UTC_NOON],
  ['2026-09-29T12:34:56', UTC_NOON],
  // Postgres now()::text, default ISO DateStyle: hour-only offset, microseconds.
  ['2026-09-29 12:34:56.789012+00', '2026-09-29T12:34:56.789Z'],
  ['2026-09-29 12:34:56+00', UTC_NOON],
  ['2026-09-29 12:34:56-00', UTC_NOON],
  ['2026-09-29 12:34:56+0000', UTC_NOON],
  ['2026-09-29 12:34:56+00:00', UTC_NOON],
  ['2026-09-29 07:34:56-05', UTC_NOON],
  ['2026-09-29 07:34:56-05:00', UTC_NOON],
  ['2026-09-29 17:34:56+05', UTC_NOON],
  ['2026-09-29 18:04:56+05:30', UTC_NOON],
  ['2026-09-29T12:34:56Z', UTC_NOON],
  ['2026-09-29T12:34:56.5z', '2026-09-29T12:34:56.500Z'],
];

for (const [input, expected] of cases) {
  void test(`parseDbTimestamp(${JSON.stringify(input)})`, () => {
    const parsed = parseDbTimestamp(input);
    assert.ok(!Number.isNaN(parsed.getTime()), 'parsed to Invalid Date');
    assert.equal(parsed.toISOString(), expected);
  });
}
