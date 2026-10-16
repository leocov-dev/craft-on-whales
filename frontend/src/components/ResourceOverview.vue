<template>
  <q-card v-if="overview" flat bordered class="q-pa-md q-mb-md">
    <div class="text-subtitle1 q-mb-sm">Live resources</div>

    <div class="row q-col-gutter-md">
      <div class="col-12 col-md-6">
        <div class="row justify-between text-caption">
          <span>Memory</span>
          <span>
            <span class="swatch" :style="{ borderTopColor: MEM_COLOR }" />
            Servers {{ formatBytes(overview.totals.memUsedBytes) }}
            <template v-if="overview.totals.memLimitBytes">
              / {{ formatBytes(overview.totals.memLimitBytes) }}
            </template>
          </span>
        </div>
        <q-linear-progress rounded size="10px" color="teal" :value="memFraction" class="q-mb-xs" />
        <div class="row justify-between text-caption text-grey q-mb-sm">
          <span><span class="swatch swatch--dashed" />Host</span>
          <span>
            {{ formatBytes(overview.host.memUsedBytes) }} /
            {{ formatBytes(overview.host.memTotalBytes) }}
          </span>
        </div>
        <div class="chart-box"><canvas ref="memCanvas" /></div>
        <q-list v-if="topByMem.length" dense class="q-mt-sm">
          <q-item v-for="s in topByMem" :key="s.id" :to="`/servers/${s.id}/metrics`">
            <q-item-section>{{ s.name }}</q-item-section>
            <q-item-section side>{{ formatBytes(s.memUsedBytes) }}</q-item-section>
          </q-item>
        </q-list>
      </div>
      <div class="col-12 col-md-6">
        <div class="row justify-between text-caption">
          <span>CPU (100% = one core)</span>
          <span>
            <span class="swatch" :style="{ borderTopColor: CPU_COLOR }" />
            Servers {{ overview.totals.cpuPct }}%
          </span>
        </div>
        <q-linear-progress
          rounded
          size="10px"
          color="positive"
          :value="Math.min(overview.totals.cpuPct / 100, 1)"
          class="q-mb-xs"
        />
        <div class="row justify-between text-caption text-grey q-mb-sm">
          <span><span class="swatch swatch--dashed" />Host ({{ overview.host.ncpu }} cores)</span>
          <span>{{ overview.host.cpuPct }}%</span>
        </div>
        <div class="chart-box"><canvas ref="cpuCanvas" /></div>
        <q-list v-if="topByCpu.length" dense class="q-mt-sm">
          <q-item v-for="s in topByCpu" :key="s.id" :to="`/servers/${s.id}/metrics`">
            <q-item-section>{{ s.name }}</q-item-section>
            <q-item-section side>{{ s.cpuPct }}%</q-item-section>
          </q-item>
        </q-list>
      </div>
    </div>

  </q-card>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';
import {
  Chart,
  LineController,
  LineElement,
  PointElement,
  LinearScale,
  CategoryScale,
  Filler,
} from 'chart.js';
import { monitoringApi, type ResourceOverview } from '@/api/monitoring';

Chart.register(LineController, LineElement, PointElement, LinearScale, CategoryScale, Filler);

// Docker's one-shot stats take ~1-2 s per container, so don't poll faster.
const POLL_MS = 5000;
const MAX_POINTS = 60;
const HOST_COLOR = '#9e9e9e';
const CPU_COLOR = '#3fa62b';
const MEM_COLOR = '#21a7ab';

const overview = ref<ResourceOverview | null>(null);
const cpuCanvas = ref<HTMLCanvasElement>();
const memCanvas = ref<HTMLCanvasElement>();

const labels: string[] = [];
const cpuData: number[] = [];
const memData: number[] = [];
const hostCpuData: number[] = [];
const hostMemData: number[] = [];
let cpuChart: Chart | null = null;
let memChart: Chart | null = null;
let timer: ReturnType<typeof setInterval> | undefined;
let inFlight = false;

const memFraction = computed(() => {
  const t = overview.value?.totals;
  return t && t.memLimitBytes ? Math.min(t.memUsedBytes / t.memLimitBytes, 1) : 0;
});

const TOP_SERVERS = 3;
const topByMem = computed(() =>
  [...(overview.value?.servers ?? [])]
    .sort((a, b) => b.memUsedBytes - a.memUsedBytes)
    .slice(0, TOP_SERVERS),
);
const topByCpu = computed(() =>
  [...(overview.value?.servers ?? [])].sort((a, b) => b.cpuPct - a.cpuPct).slice(0, TOP_SERVERS),
);

function formatBytes(bytes: number): string {
  const mb = bytes / 1024 / 1024;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

function makeChart(canvas: HTMLCanvasElement, data: number[], hostData: number[], color: string) {
  return new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Servers',
          data: [...data],
          borderColor: color,
          backgroundColor: `${color}33`,
          fill: true,
          tension: 0.3,
          pointRadius: 0,
        },
        {
          label: 'Host',
          data: [...hostData],
          borderColor: HOST_COLOR,
          borderDash: [6, 4],
          fill: false,
          tension: 0.3,
          pointRadius: 0,
        },
      ],
    },
    options: {
      animation: false,
      responsive: true,
      maintainAspectRatio: false,
      scales: { x: { display: false }, y: { beginAtZero: true } },
      plugins: { legend: { display: false } },
    },
  });
}

function refreshChart(chart: Chart | null, data: number[], hostData: number[]) {
  if (!chart) return;
  chart.data.datasets[0]!.data = [...data];
  chart.data.datasets[1]!.data = [...hostData];
  chart.update('none');
}

async function poll() {
  if (inFlight) return;
  inFlight = true;
  try {
    const next = (await monitoringApi.overview()).overview;
    overview.value = next;
    labels.push(new Date().toLocaleTimeString());
    cpuData.push(next.totals.cpuPct);
    memData.push(Math.round(next.totals.memUsedBytes / 1024 / 1024));
    hostCpuData.push(next.host.cpuPct);
    hostMemData.push(Math.round(next.host.memUsedBytes / 1024 / 1024));
    if (labels.length > MAX_POINTS) {
      labels.shift();
      cpuData.shift();
      memData.shift();
      hostCpuData.shift();
      hostMemData.shift();
    }
    // The card only renders once the first response lands, so build lazily.
    // Axes auto-scale to the largest value currently in the window.
    await nextTick();
    if (!cpuChart && cpuCanvas.value)
      cpuChart = makeChart(cpuCanvas.value, cpuData, hostCpuData, CPU_COLOR);
    if (!memChart && memCanvas.value)
      memChart = makeChart(memCanvas.value, memData, hostMemData, MEM_COLOR);
    refreshChart(cpuChart, cpuData, hostCpuData);
    refreshChart(memChart, memData, hostMemData);
  } catch {
    /* transient; next tick retries */
  } finally {
    inFlight = false;
  }
}

onMounted(() => {
  void poll();
  timer = setInterval(() => void poll(), POLL_MS);
});

onUnmounted(() => {
  if (timer) clearInterval(timer);
  cpuChart?.destroy();
  memChart?.destroy();
});
</script>

<style scoped>
/* Fixed height so the chart fills it; the swatches above replace a legend row. */
.chart-box {
  position: relative;
  height: 180px;
}
.swatch {
  display: inline-block;
  width: 14px;
  margin-right: 6px;
  vertical-align: middle;
  border-top: 2px solid #9e9e9e;
}
.swatch--dashed {
  border-top-style: dashed;
}
</style>
