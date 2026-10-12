<template>
  <q-dialog :model-value="true" maximized persistent @hide="emit('close')">
    <q-card class="column no-wrap">
      <q-toolbar>
        <q-toolbar-title>Chunk editor · {{ world }}</q-toolbar-title>
        <q-select
          v-if="map && map.dimensions.length > 1"
          v-model="dimension"
          :options="map.dimensions.map((d) => d.label)"
          dense
          outlined
          label="Dimension"
          style="min-width: 160px"
          :disable="busy"
        />
        <q-btn
          flat
          round
          dense
          icon="close"
          class="q-ml-sm"
          :disable="busy"
          @click="emit('close')"
        />
      </q-toolbar>

      <q-banner v-if="!serverStopped" dense class="bg-warning text-dark">
        <template #avatar><q-icon name="info" /></template>
        The server is running. You can look around, but it must be stopped before deleting chunks.
      </q-banner>
      <q-linear-progress
        v-if="heatTotal > 0 && heatLoaded < heatTotal"
        :value="heatLoaded / heatTotal"
      />

      <div ref="host" class="col relative-position overflow-hidden">
        <q-inner-loading :showing="loading" />
        <q-banner v-if="error" dense class="text-negative absolute-top z-top">{{ error }}</q-banner>
        <q-banner v-else-if="map && !cells.length" dense class="absolute-top z-top">
          No generated chunks in this dimension.
        </q-banner>
        <q-btn
          round
          dense
          unelevated
          color="primary"
          :icon="showHelp ? 'close' : 'help_outline'"
          class="absolute-top-right q-ma-sm z-top"
          @click="showHelp = !showHelp"
        >
          <q-tooltip>{{ showHelp ? 'Hide controls' : 'Show controls' }}</q-tooltip>
        </q-btn>
        <q-card
          v-if="showHelp"
          flat
          bordered
          class="absolute-top-left q-ma-sm z-top"
          style="pointer-events: none; opacity: 0.93"
        >
          <q-list dense>
            <q-item v-for="hint in HINTS" :key="hint.action">
              <q-item-section avatar style="min-width: 32px">
                <q-icon :name="hint.icon" size="sm" />
              </q-item-section>
              <q-item-section>
                <q-item-label>{{ hint.action }}</q-item-label>
                <q-item-label caption>{{ hint.keys }}</q-item-label>
              </q-item-section>
            </q-item>
          </q-list>
        </q-card>
        <canvas
          ref="canvas"
          :style="{ touchAction: 'none', cursor: dragging ? 'grabbing' : 'grab' }"
          @pointerdown="onPointerDown"
          @pointermove="onPointerMove"
          @pointerup="onPointerUp"
          @pointercancel="onPointerUp"
          @pointerleave="hover = null"
          @wheel.prevent="onWheel"
          @dblclick="onDoubleClick"
        />
      </div>

      <q-separator />
      <div class="row items-center q-pa-sm q-gutter-x-md">
        <div class="col text-caption">
          <template v-if="hover">
            Chunk {{ hover.cx }}, {{ hover.cz }} · blocks {{ hover.cx * 16 }}…{{
              hover.cx * 16 + 15
            }}, {{ hover.cz * 16 }}…{{ hover.cz * 16 + 15 }}
            <template v-if="hoverTime"> · {{ hoverTime }}</template>
          </template>
          <template v-else> {{ cells.length }} chunks </template>
        </div>
        <div class="row items-center q-gutter-x-sm text-caption">
          <span v-for="(step, i) in HEAT_STEPS" :key="step.label" class="row items-center">
            <span class="q-mr-xs" :style="swatch(i)" />{{ step.label }}
          </span>
        </div>
        <q-btn
          flat
          no-caps
          label="Clear selection"
          :disable="!selected.size || busy"
          @click="selected = new Set()"
        />
        <q-btn
          color="negative"
          no-caps
          icon="delete"
          :label="`Delete ${selected.size} chunk${selected.size === 1 ? '' : 's'}`"
          :disable="!canDelete"
          @click="confirming = true"
        >
          <q-tooltip v-if="!serverStopped">Stop the server first</q-tooltip>
        </q-btn>
      </div>

      <q-dialog v-model="confirming">
        <q-card style="min-width: 320px">
          <q-card-section>
            <div class="text-h6">
              Delete {{ selected.size }} chunk{{ selected.size === 1 ? '' : 's' }}?
            </div>
            <div class="text-body2 q-mt-sm">
              They regenerate from the seed the next time someone loads them. Anything built there
              is lost, including mobs and villager workstations.
            </div>
            <q-checkbox v-model="backup" label="Take a backup first" class="q-mt-sm" />
          </q-card-section>
          <q-card-actions align="right">
            <q-btn flat label="Cancel" :disable="busy" @click="confirming = false" />
            <q-btn color="negative" label="Delete" :loading="busy" @click="deleteSelected" />
          </q-card-actions>
        </q-card>
      </q-dialog>
    </q-card>
  </q-dialog>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { useQuasar } from 'quasar';
import { serverWorldsApi, type WorldChunkMap } from '@/api/serverWorlds';
import {
  HEAT_STEPS,
  cellsInRect,
  chunkKey,
  heatColor,
  slotToChunk,
  type ChunkCell,
} from '@/utils/chunk-map';

const props = defineProps<{ serverId: string; world: string; serverStopped: boolean }>();
const emit = defineEmits<{ close: []; changed: [] }>();

const $q = useQuasar();

/** Mirrors the backend's per-request cap; larger selections are sent in batches of this size. */
const DELETE_BATCH = 4096;
const MIN_SCALE = 1;
const MAX_SCALE = 48;
const HEAT_CONCURRENCY = 3;

const HINTS = [
  { icon: 'pan_tool', action: 'Pan', keys: 'Drag' },
  { icon: 'zoom_in', action: 'Zoom', keys: 'Scroll, pinch or double-click (shift to zoom out)' },
  { icon: 'touch_app', action: 'Select or deselect one chunk', keys: 'Click' },
  { icon: 'highlight_alt', action: 'Select an area', keys: 'Shift + drag' },
  { icon: 'deselect', action: 'Deselect an area', keys: 'Alt, Ctrl or Cmd + drag' },
];
const HEAT_REFRESH_ROUNDS = 5;
const HEAT_REFRESH_DELAY_MS = 2000;

interface Region {
  rx: number;
  rz: number;
  /** InhabitedTime per slot once fetched. */
  ticks: Array<number | null> | null;
}
interface Cell extends ChunkCell {
  key: string;
  slot: number;
  region: Region;
}

const host = ref<HTMLDivElement | null>(null);
const canvas = ref<HTMLCanvasElement | null>(null);

const loading = ref(true);
const busy = ref(false);
const error = ref<string | null>(null);
const map = ref<WorldChunkMap | null>(null);
const dimension = ref('');
const dragging = ref(false);
const showHelp = ref(true);
const cells = shallowRef<Cell[]>([]);
const cellByKey = new Map<string, Cell>();
const selected = shallowRef<Set<string>>(new Set());
const hover = ref<ChunkCell | null>(null);
const confirming = ref(false);
const backup = ref(true);
const heatLoaded = ref(0);
const heatTotal = ref(0);

// View: chunk coordinate under the canvas centre, and pixels per chunk.
const view = { cx: 0, cz: 0, scale: 8 };
let width = 0;
let height = 0;
let dpr = 1;
let frame = 0;
let generation = 0;
let resizeObserver: ResizeObserver | null = null;

const canDelete = computed(() => props.serverStopped && !busy.value && selected.value.size > 0);

const hoverTime = computed(() => {
  const c = hover.value && cellByKey.get(chunkKey(hover.value.cx, hover.value.cz));
  const ticks = c?.region.ticks?.[c.slot];
  if (ticks == null) return '';
  const seconds = Math.round(ticks / 20);
  if (seconds < 90) return `${seconds} s played here`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} min played here`;
  return `${(seconds / 3600).toFixed(1)} h played here`;
});

function swatch(step: number) {
  const ticks = HEAT_STEPS[step]!.minTicks;
  return {
    display: 'inline-block',
    width: '12px',
    height: '12px',
    background: heatColor(ticks, $q.dark.isActive),
  };
}

// ---- data ----------------------------------------------------------------

async function load() {
  loading.value = true;
  error.value = null;
  try {
    const res = await serverWorldsApi.chunks(props.serverId, props.world);
    map.value = res;
    dimension.value = res.dimensions.some((d) => d.label === dimension.value)
      ? dimension.value
      : (res.dimensions[0]?.label ?? '');
    buildCells(true);
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not read the world.';
  } finally {
    loading.value = false;
  }
}

function buildCells(fit: boolean) {
  generation++;
  const dim = map.value?.dimensions.find((d) => d.label === dimension.value);
  const out: Cell[] = [];
  cellByKey.clear();
  const regions: Region[] = [];
  for (const r of dim?.regions ?? []) {
    const region: Region = { rx: r.rx, rz: r.rz, ticks: null };
    regions.push(region);
    for (const slot of r.slots) {
      const { cx, cz } = slotToChunk(r.rx, r.rz, slot);
      const cell: Cell = { cx, cz, slot, key: chunkKey(cx, cz), region };
      out.push(cell);
      cellByKey.set(cell.key, cell);
    }
  }
  cells.value = out;
  selected.value = new Set();
  if (fit) fitView();
  schedule();
  void loadHeat(regions, generation);
}

/**
 * Fetch InhabitedTime region by region, a few at a time, so shading fills in progressively.
 * The server answers from its cache straight away; regions it flags `stale` are refreshing in
 * the background, so ask for those again a few times.
 */
async function loadHeat(regions: Region[], gen: number) {
  heatLoaded.value = 0;
  heatTotal.value = regions.length;
  const pass = async (list: Region[], countProgress: boolean) => {
    const queue = [...list];
    const stale: Region[] = [];
    const worker = async () => {
      for (let r = queue.shift(); r; r = queue.shift()) {
        try {
          const res = await serverWorldsApi.regionInhabited(
            props.serverId,
            props.world,
            dimension.value,
            r.rx,
            r.rz,
          );
          if (gen !== generation) return;
          r.ticks = res.ticks;
          if (res.stale) stale.push(r);
        } catch {
          if (gen !== generation) return;
          /* leave this region as it was; the grid is still usable */
        }
        if (countProgress) heatLoaded.value++;
        schedule();
      }
    };
    await Promise.all(Array.from({ length: HEAT_CONCURRENCY }, worker));
    return stale;
  };
  let pending = await pass(regions, true);
  for (let round = 0; round < HEAT_REFRESH_ROUNDS && pending.length; round++) {
    await new Promise((resolve) => setTimeout(resolve, HEAT_REFRESH_DELAY_MS));
    if (gen !== generation) return;
    pending = await pass(pending, false);
  }
}

async function deleteSelected() {
  busy.value = true;
  let removed = 0;
  let skipped = 0;
  try {
    const chunks = [...selected.value].map((k) => {
      const c = cellByKey.get(k)!;
      return { cx: c.cx, cz: c.cz };
    });
    for (let i = 0; i < chunks.length; i += DELETE_BATCH) {
      const res = await serverWorldsApi.deleteChunks(props.serverId, {
        world: props.world,
        dimension: dimension.value,
        chunks: chunks.slice(i, i + DELETE_BATCH),
        // One backup up front covers the whole selection.
        backup: backup.value && i === 0,
      });
      removed += res.result.chunksRemoved;
      skipped += res.result.regionsSkipped;
    }
    confirming.value = false;
    $q.notify({
      type: 'positive',
      message: `Deleted ${removed} chunk${removed === 1 ? '' : 's'}.`,
    });
    if (skipped)
      $q.notify({
        type: 'warning',
        message: `${skipped} damaged region file(s) were left untouched.`,
      });
  } catch (err) {
    $q.notify({
      type: 'negative',
      message:
        (err instanceof Error ? err.message : 'Delete failed.') +
        (removed ? ` ${removed} chunk(s) were already deleted.` : ''),
    });
  } finally {
    busy.value = false;
  }
  if (removed) {
    emit('changed');
    await load();
  }
}

// ---- view ----------------------------------------------------------------

function fitView() {
  const list = cells.value;
  if (!list.length || !width || !height) {
    view.cx = map.value?.spawn.cx ?? 0;
    view.cz = map.value?.spawn.cz ?? 0;
    return;
  }
  let x0 = Infinity;
  let x1 = -Infinity;
  let z0 = Infinity;
  let z1 = -Infinity;
  for (const c of list) {
    x0 = Math.min(x0, c.cx);
    x1 = Math.max(x1, c.cx + 1);
    z0 = Math.min(z0, c.cz);
    z1 = Math.max(z1, c.cz + 1);
  }
  view.cx = (x0 + x1) / 2;
  view.cz = (z0 + z1) / 2;
  const fit = Math.min(width / (x1 - x0 + 4), height / (z1 - z0 + 4));
  view.scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, fit));
}

const toChunk = (px: number, py: number): ChunkCell => ({
  cx: Math.floor((px - width / 2) / view.scale + view.cx),
  cz: Math.floor((py - height / 2) / view.scale + view.cz),
});

function localPoint(e: PointerEvent | WheelEvent) {
  const r = canvas.value!.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

// ---- input ---------------------------------------------------------------

/**
 * Maps-style gestures: plain drag pans, wheel / double-click zooms, click toggles a chunk,
 * and a modifier-drag draws a selection rectangle (shift adds, alt/ctrl/cmd removes).
 */
let drag: {
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  moved: boolean;
  mode: 'pan' | 'add' | 'subtract';
  from: ChunkCell;
  to: ChunkCell;
} | null = null;

function onPointerDown(e: PointerEvent) {
  if (e.button !== 0) return;
  const { x, y } = localPoint(e);
  const c = toChunk(x, y);
  drag = {
    startX: x,
    startY: y,
    lastX: x,
    lastY: y,
    moved: false,
    mode: e.altKey || e.ctrlKey || e.metaKey ? 'subtract' : e.shiftKey ? 'add' : 'pan',
    from: c,
    to: c,
  };
  canvas.value!.setPointerCapture(e.pointerId);
}

function onPointerMove(e: PointerEvent) {
  const { x, y } = localPoint(e);
  hover.value = toChunk(x, y);
  if (drag) {
    if (Math.hypot(x - drag.startX, y - drag.startY) > 4) {
      drag.moved = true;
      dragging.value = drag.mode === 'pan';
    }
    if (drag.mode === 'pan' && drag.moved) {
      view.cx -= (x - drag.lastX) / view.scale;
      view.cz -= (y - drag.lastY) / view.scale;
    } else {
      drag.to = hover.value;
    }
    drag.lastX = x;
    drag.lastY = y;
  }
  schedule();
}

function onPointerUp() {
  if (!drag) return;
  const d = drag;
  drag = null;
  dragging.value = false;
  const next = new Set(selected.value);
  if (d.moved && d.mode !== 'pan') {
    for (const c of cellsInRect(cells.value, { a: d.from, b: d.to })) {
      if (d.mode === 'subtract') next.delete(c.key);
      else next.add(c.key);
    }
  } else if (!d.moved) {
    // A click toggles the one chunk under it.
    const c = cellByKey.get(chunkKey(d.from.cx, d.from.cz));
    if (c) {
      if (next.has(c.key)) next.delete(c.key);
      else next.add(c.key);
    }
  } else {
    schedule();
    return;
  }
  selected.value = next;
  schedule();
}

function zoomAt(x: number, y: number, factor: number) {
  // Zoom about the cursor: keep the world point under it fixed.
  const wx = (x - width / 2) / view.scale + view.cx;
  const wz = (y - height / 2) / view.scale + view.cz;
  view.scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, view.scale * factor));
  view.cx = wx - (x - width / 2) / view.scale;
  view.cz = wz - (y - height / 2) / view.scale;
  schedule();
}

function onDoubleClick(e: MouseEvent) {
  // The two clicks of a double-click toggle the chunk twice, so the selection is unchanged.
  const { x, y } = localPoint(e as PointerEvent);
  zoomAt(x, y, e.shiftKey ? 0.5 : 2);
}

function onWheel(e: WheelEvent) {
  const { x, y } = localPoint(e);
  // ctrl+wheel is a trackpad pinch, which reports small deltas.
  zoomAt(x, y, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)));
}

// ---- drawing -------------------------------------------------------------

function schedule() {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    draw();
  });
}

function draw() {
  const el = canvas.value;
  const ctx = el?.getContext('2d');
  if (!el || !ctx || !width || !height) return;
  const dark = $q.dark.isActive;
  const s = view.scale;
  const sx = (cx: number) => Math.round((cx - view.cx) * s + width / 2);
  const sy = (cz: number) => Math.round((cz - view.cz) * s + height / 2);

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = dark ? '#121212' : '#fafafa';
  ctx.fillRect(0, 0, width, height);

  const gap = s >= 6 ? 1 : 0;
  const size = Math.ceil(s) - gap;
  const left = view.cx - width / 2 / s - 1;
  const right = view.cx + width / 2 / s + 1;
  const top = view.cz - height / 2 / s - 1;
  const bottom = view.cz + height / 2 / s + 1;
  for (const c of cells.value) {
    if (c.cx < left || c.cx > right || c.cz < top || c.cz > bottom) continue;
    ctx.fillStyle = heatColor(c.region.ticks?.[c.slot], dark);
    ctx.fillRect(sx(c.cx), sy(c.cz), size, size);
  }

  // Region boundaries (every 32 chunks) once zoomed in enough to read them.
  if (s >= 3) {
    ctx.strokeStyle = dark ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.18)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = Math.floor(left / 32) * 32; x <= right; x += 32) {
      ctx.moveTo(sx(x) + 0.5, 0);
      ctx.lineTo(sx(x) + 0.5, height);
    }
    for (let z = Math.floor(top / 32) * 32; z <= bottom; z += 32) {
      ctx.moveTo(0, sy(z) + 0.5);
      ctx.lineTo(width, sy(z) + 0.5);
    }
    ctx.stroke();
  }

  // Selection (committed + the rectangle being dragged).
  ctx.fillStyle = 'rgba(244, 67, 54, 0.65)';
  for (const key of selected.value) {
    const c = cellByKey.get(key);
    if (!c || c.cx < left || c.cx > right || c.cz < top || c.cz > bottom) continue;
    ctx.fillRect(sx(c.cx), sy(c.cz), size, size);
  }
  if (drag && drag.mode !== 'pan' && drag.moved) {
    const x0 = Math.min(drag.from.cx, drag.to.cx);
    const z0 = Math.min(drag.from.cz, drag.to.cz);
    const x1 = Math.max(drag.from.cx, drag.to.cx) + 1;
    const z1 = Math.max(drag.from.cz, drag.to.cz) + 1;
    ctx.fillStyle = drag.mode === 'subtract' ? 'rgba(33,150,243,0.25)' : 'rgba(244,67,54,0.25)';
    ctx.strokeStyle = drag.mode === 'subtract' ? '#2196f3' : '#f44336';
    ctx.fillRect(sx(x0), sy(z0), sx(x1) - sx(x0), sy(z1) - sy(z0));
    ctx.strokeRect(sx(x0) + 0.5, sy(z0) + 0.5, sx(x1) - sx(x0), sy(z1) - sy(z0));
  }

  // World spawn (overworld only) and the hovered chunk.
  const spawn = map.value?.spawn;
  if (spawn && dimension.value === '.') {
    ctx.strokeStyle = '#ffb300';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(sx(spawn.cx) + s / 2, sy(spawn.cz) + s / 2, Math.max(4, s / 2), 0, Math.PI * 2);
    ctx.stroke();
  }
  if (hover.value) {
    ctx.strokeStyle = dark ? '#fff' : '#000';
    ctx.lineWidth = 1;
    ctx.strokeRect(sx(hover.value.cx) + 0.5, sy(hover.value.cz) + 0.5, size - 1, size - 1);
  }
}

function resize() {
  const el = canvas.value;
  const box = host.value;
  if (!el || !box) return;
  const first = !width;
  width = box.clientWidth;
  height = box.clientHeight;
  dpr = window.devicePixelRatio || 1;
  el.width = Math.round(width * dpr);
  el.height = Math.round(height * dpr);
  el.style.width = `${width}px`;
  el.style.height = `${height}px`;
  if (first && cells.value.length) fitView();
  schedule();
}

watch(dimension, () => {
  if (map.value) buildCells(true);
});
watch([hover, () => $q.dark.isActive], schedule);

// q-dialog mounts its content a tick after this component, so wait for the host element.
watch(host, (el) => {
  resizeObserver?.disconnect();
  if (!el) return;
  resize();
  resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(el);
});

onMounted(load);

onBeforeUnmount(() => {
  generation++;
  resizeObserver?.disconnect();
  if (frame) cancelAnimationFrame(frame);
});
</script>
