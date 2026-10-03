<template>
  <q-card v-if="overview && overview.servers.length" flat bordered class="q-pa-md q-mb-md">
    <div class="text-subtitle1 q-mb-sm">Live resources</div>

    <div class="row q-col-gutter-md">
      <div class="col-12 col-md-6">
        <div class="row justify-between text-caption">
          <span>Memory</span>
          <span>
            {{ formatBytes(overview.totals.memUsedBytes) }}
            <template v-if="overview.totals.memLimitBytes">
              / {{ formatBytes(overview.totals.memLimitBytes) }}
            </template>
          </span>
        </div>
        <q-linear-progress rounded size="10px" color="teal" :value="memFraction" class="q-mb-sm" />
        <canvas ref="memCanvas" height="80" />
      </div>
      <div class="col-12 col-md-6">
        <div class="row justify-between text-caption">
          <span>CPU (100% = one core)</span>
          <span>{{ overview.totals.cpuPct }}%</span>
        </div>
        <q-linear-progress
          rounded
          size="10px"
          color="positive"
          :value="Math.min(overview.totals.cpuPct / 100, 1)"
          class="q-mb-sm"
        />
        <canvas ref="cpuCanvas" height="80" />
      </div>
    </div>

    <q-list dense class="q-mt-md">
      <q-item v-for="s in overview.servers" :key="s.id" :to="`/servers/${s.id}/metrics`">
        <q-item-section>{{ s.name }}</q-item-section>
        <q-item-section side> {{ s.cpuPct }}% · {{ formatBytes(s.memUsedBytes) }} </q-item-section>
      </q-item>
    </q-list>
  </q-card>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
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

const overview = ref<ResourceOverview | null>(null);
const cpuCanvas = ref<HTMLCanvasElement>();
const memCanvas = ref<HTMLCanvasElement>();

const labels: string[] = [];
const cpuData: number[] = [];
const memData: number[] = [];
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

function makeChart(canvas: HTMLCanvasElement, data: number[], color: string) {
  return new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          data: [...data],
          borderColor: color,
          backgroundColor: `${color}33`,
          fill: true,
          tension: 0.3,
          pointRadius: 0,
        },
      ],
    },
    options: {
      animation: false,
      responsive: true,
      scales: { x: { display: false }, y: { beginAtZero: true } },
      plugins: { legend: { display: false } },
    },
  });
}

function refreshChart(chart: Chart | null, data: number[]) {
  if (!chart) return;
  chart.data.datasets[0]!.data = [...data];
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
    if (labels.length > MAX_POINTS) {
      labels.shift();
      cpuData.shift();
      memData.shift();
    }
    // Canvases only render once there is a running server, so build lazily.
    if (!cpuChart && cpuCanvas.value) cpuChart = makeChart(cpuCanvas.value, cpuData, '#3fa62b');
    if (!memChart && memCanvas.value) memChart = makeChart(memCanvas.value, memData, '#21a7ab');
    refreshChart(cpuChart, cpuData);
    refreshChart(memChart, memData);
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
