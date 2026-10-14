<template>
  <q-card v-if="overview" flat bordered class="q-pa-md q-mb-md">
    <div class="text-subtitle1 q-mb-sm">Live resources</div>

    <div class="row q-col-gutter-md">
      <div class="col-12 col-md-6">
        <div class="row justify-between text-caption">
          <span>Memory</span>
          <span>
            Servers {{ formatBytes(overview.totals.memUsedBytes) }}
            <template v-if="overview.totals.memLimitBytes">
              / {{ formatBytes(overview.totals.memLimitBytes) }}
            </template>
          </span>
        </div>
        <q-linear-progress rounded size="10px" color="teal" :value="memFraction" class="q-mb-xs" />
        <div class="row justify-between text-caption text-grey q-mb-sm">
          <span>Host</span>
          <span>
            {{ formatBytes(overview.host.memUsedBytes) }} /
            {{ formatBytes(overview.host.memTotalBytes) }}
          </span>
        </div>
        <canvas ref="memCanvas" height="80" />
      </div>
      <div class="col-12 col-md-6">
        <div class="row justify-between text-caption">
          <span>CPU (100% = one core)</span>
          <span>Servers {{ overview.totals.cpuPct }}%</span>
        </div>
        <q-linear-progress
          rounded
          size="10px"
          color="positive"
          :value="Math.min(overview.totals.cpuPct / 100, 1)"
          class="q-mb-xs"
        />
        <div class="row justify-between text-caption text-grey q-mb-sm">
          <span>Host ({{ overview.host.ncpu }} cores)</span>
          <span>{{ overview.host.cpuPct }}%</span>
        </div>
        <canvas ref="cpuCanvas" height="80" />
      </div>
    </div>

    <q-list v-if="overview.servers.length" dense class="q-mt-md">
      <q-item v-for="s in overview.servers" :key="s.id" :to="`/servers/${s.id}/metrics`">
        <q-item-section>{{ s.name }}</q-item-section>
        <q-item-section side> {{ s.cpuPct }}% · {{ formatBytes(s.memUsedBytes) }} </q-item-section>
      </q-item>
    </q-list>
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
  Legend,
} from 'chart.js';
import { monitoringApi, type ResourceOverview } from '@/api/monitoring';

Chart.register(
  LineController,
  LineElement,
  PointElement,
  LinearScale,
  CategoryScale,
  Filler,
  Legend,
);

// Docker's one-shot stats take ~1-2 s per container, so don't poll faster.
const POLL_MS = 5000;
const MAX_POINTS = 60;
const HOST_COLOR = '#9e9e9e';

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

function formatBytes(bytes: number): string {
  const mb = bytes / 1024 / 1024;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

function makeChart(
  canvas: HTMLCanvasElement,
  data: number[],
  hostData: number[],
  color: string,
  max: number,
) {
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
      scales: { x: { display: false }, y: { beginAtZero: true, max } },
      plugins: { legend: { display: true, labels: { boxHeight: 2 } } },
    },
  });
}

function refreshChart(chart: Chart | null, data: number[], hostData: number[], max: number) {
  if (!chart) return;
  chart.data.datasets[0]!.data = [...data];
  chart.data.datasets[1]!.data = [...hostData];
  chart.options.scales!.y!.max = max;
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
    // Pin the axes to the machine's capacity so servers read as a share of it.
    const cpuMax = next.host.ncpu * 100;
    const memMax = Math.round(next.host.memTotalBytes / 1024 / 1024);
    // The card only renders once the first response lands, so build lazily.
    await nextTick();
    if (!cpuChart && cpuCanvas.value)
      cpuChart = makeChart(cpuCanvas.value, cpuData, hostCpuData, '#3fa62b', cpuMax);
    if (!memChart && memCanvas.value)
      memChart = makeChart(memCanvas.value, memData, hostMemData, '#21a7ab', memMax);
    refreshChart(cpuChart, cpuData, hostCpuData, cpuMax);
    refreshChart(memChart, memData, hostMemData, memMax);
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
