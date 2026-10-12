import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cellsInRect, chunkToSlot, heatStep, slotToChunk } from './chunk-map.ts';

void test('slotToChunk and chunkToSlot round-trip, including negative chunks', () => {
  for (const [cx, cz] of [
    [0, 0],
    [31, 31],
    [32, 0],
    [-1, -1],
    [-32, -33],
    [100, -7],
  ] as const) {
    const { rx, rz, slot } = chunkToSlot(cx, cz);
    assert.deepEqual(slotToChunk(rx, rz, slot), { cx, cz });
  }
  assert.deepEqual(chunkToSlot(-1, -1), { rx: -1, rz: -1, slot: 31 + 31 * 32 });
});

void test('cellsInRect is inclusive and corner-order independent', () => {
  const cells = [
    { cx: 0, cz: 0 },
    { cx: 2, cz: 2 },
    { cx: 3, cz: 3 },
    { cx: -1, cz: 1 },
  ];
  const inside = cellsInRect(cells, { a: { cx: 2, cz: 2 }, b: { cx: -1, cz: 0 } });
  assert.deepEqual(inside, [cells[0], cells[1], cells[3]]);
});

void test('heatStep buckets InhabitedTime and flags unknown', () => {
  assert.equal(heatStep(null), -1);
  assert.equal(heatStep(undefined), -1);
  assert.equal(heatStep(0), 0);
  assert.equal(heatStep(599), 0);
  assert.equal(heatStep(600), 1);
  assert.equal(heatStep(20 * 60 * 20), 2);
  assert.equal(heatStep(10_000_000), 3);
});
