// Pure helpers for the chunk editor's canvas: coordinates, selection, shading.

export interface ChunkCell {
  cx: number;
  cz: number;
}

export interface ChunkCoordRect {
  a: ChunkCell;
  b: ChunkCell;
}

export const chunkKey = (cx: number, cz: number): string => `${cx},${cz}`;

/** Chunk coordinate of a region-local slot (`x + z * 32`). */
export function slotToChunk(rx: number, rz: number, slot: number): ChunkCell {
  return { cx: rx * 32 + (slot % 32), cz: rz * 32 + Math.floor(slot / 32) };
}

/** Region + slot of a chunk; floor-based so negative chunks land in the right region. */
export function chunkToSlot(cx: number, cz: number): { rx: number; rz: number; slot: number } {
  const rx = Math.floor(cx / 32);
  const rz = Math.floor(cz / 32);
  return { rx, rz, slot: cx - rx * 32 + (cz - rz * 32) * 32 };
}

/** The cells whose chunk lies inside the rectangle spanned by two corner chunks (inclusive). */
export function cellsInRect<T extends ChunkCell>(cells: Iterable<T>, rect: ChunkCoordRect): T[] {
  const x0 = Math.min(rect.a.cx, rect.b.cx);
  const x1 = Math.max(rect.a.cx, rect.b.cx);
  const z0 = Math.min(rect.a.cz, rect.b.cz);
  const z1 = Math.max(rect.a.cz, rect.b.cz);
  const out: T[] = [];
  for (const c of cells) {
    if (c.cx >= x0 && c.cx <= x1 && c.cz >= z0 && c.cz <= z1) out.push(c);
  }
  return out;
}

const TICKS_PER_MINUTE = 20 * 60;

/** Legend steps, least to most player time. Also drives {@link heatColor}. */
export const HEAT_STEPS: Array<{ label: string; minTicks: number }> = [
  { label: '< 30 s', minTicks: 0 },
  { label: '30 s – 20 min', minTicks: 600 },
  { label: '20 min – 3 h', minTicks: 20 * TICKS_PER_MINUTE },
  { label: '> 3 h', minTicks: 180 * TICKS_PER_MINUTE },
];

/** Index into {@link HEAT_STEPS}, or -1 when the time isn't known (yet). */
export function heatStep(ticks: number | null | undefined): number {
  if (ticks == null) return -1;
  let step = 0;
  HEAT_STEPS.forEach((s, i) => {
    if (ticks >= s.minTicks) step = i;
  });
  return step;
}

/** Fill colour for a chunk: grey until its InhabitedTime is known, then greener the more it's been visited. */
export function heatColor(ticks: number | null | undefined, dark: boolean): string {
  const step = heatStep(ticks);
  if (step < 0) return dark ? '#546e7a' : '#b0bec5';
  const light = dark ? [30, 38, 48, 58] : [78, 64, 50, 36];
  return `hsl(145, 55%, ${light[step]}%)`;
}
