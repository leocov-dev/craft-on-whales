<template>
  <div class="row q-col-gutter-md">
    <template v-if="server?.status === 'running'">
      <div v-for="stat in statStrip" :key="stat.label" class="col-6 col-md-3">
        <q-card flat bordered class="q-pa-md text-center">
          <div class="text-h5" :class="stat.color">{{ stat.value }}</div>
          <q-item-label caption>{{ stat.label }}</q-item-label>
        </q-card>
      </div>

      <div class="col-12 col-md-6">
        <q-card flat bordered class="q-pa-md">
          <div class="text-subtitle1 q-mb-sm">CPU</div>
          <canvas ref="cpuCanvas" height="120" />
        </q-card>
      </div>
      <div class="col-12 col-md-6">
        <q-card flat bordered class="q-pa-md">
          <div class="text-subtitle1 q-mb-sm">Memory</div>
          <canvas ref="memCanvas" height="120" />
          <q-item-label v-if="server?.resources.heapNote" caption class="q-mt-sm">
            <q-icon name="info" size="14px" class="q-mr-xs" />
            Java heap {{ server.resources.heapMb }} MB of the
            {{ server.resources.containerMemoryMb }} MB container limit.
            {{ server.resources.heapNote }}
          </q-item-label>
        </q-card>
      </div>

      <div class="col-12">
        <q-card flat bordered class="q-pa-md">
          <div class="text-subtitle1 q-mb-sm">Tick rate</div>
          <q-banner v-if="tpsUnavailable" rounded dense>
            <template #avatar>
              <q-icon name="info" color="primary" />
            </template>
            This server doesn't report TPS. It needs Paper, Purpur, Forge, NeoForge or the spark mod
            — vanilla has no command for it.
          </q-banner>
          <div v-show="!tpsUnavailable">
            <canvas ref="tpsCanvas" height="90" />
            <q-item-label v-if="!tpsReading" caption class="q-mt-sm"
              >Waiting for a reading…</q-item-label
            >
          </div>
        </q-card>
      </div>
    </template>
    <div v-else class="col-12">
      <q-banner rounded>
        <template #avatar>
          <q-icon name="info" color="primary" />
        </template>
        Live graphs are only available while the server is running.
      </q-banner>
    </div>

    <div class="col-12">
      <q-card flat bordered class="q-pa-md">
        <div class="text-subtitle1 q-mb-sm">Health &amp; stability</div>
        <q-spinner v-if="!health && !healthError" color="primary" size="24px" />
        <q-banner v-else-if="healthError" rounded dense class="text-negative">
          {{ healthError }}
        </q-banner>
        <q-list v-else-if="health" dense>
          <q-item>
            <q-item-section>Container health</q-item-section>
            <q-item-section side>
              <q-badge :color="healthColor" :label="health.health ?? 'no healthcheck'" />
            </q-item-section>
          </q-item>
          <q-item v-if="health.status !== 'running'">
            <q-item-section>Last exit code</q-item-section>
            <q-item-section side>
              <q-badge
                :color="health.exitCode ? 'negative' : 'positive'"
                :label="health.exitCode ?? 'n/a'"
              />
            </q-item-section>
          </q-item>
          <q-item v-if="health.oomKilled">
            <q-item-section class="text-negative">
              Killed for running out of memory — raise the container memory limit.
            </q-item-section>
          </q-item>
          <q-item>
            <q-item-section>Crashes, last {{ health.windowDays }} days</q-item-section>
            <q-item-section side>
              <q-badge :color="health.crashes ? 'negative' : 'positive'" :label="health.crashes" />
            </q-item-section>
          </q-item>
          <q-item>
            <q-item-section>Out-of-memory kills</q-item-section>
            <q-item-section side>
              <q-badge
                :color="health.oomKills ? 'negative' : 'positive'"
                :label="health.oomKills"
              />
            </q-item-section>
          </q-item>
          <q-item>
            <q-item-section>Crash loops</q-item-section>
            <q-item-section side>
              <q-badge
                :color="health.crashLoops ? 'negative' : 'positive'"
                :label="health.crashLoops"
              />
            </q-item-section>
          </q-item>
          <q-item>
            <q-item-section>Stalled startups</q-item-section>
            <q-item-section side>
              <q-badge
                :color="health.stalledStarts ? 'warning' : 'positive'"
                :label="health.stalledStarts"
              />
            </q-item-section>
          </q-item>
          <q-item v-if="health.lastCrash">
            <q-item-section>
              <q-item-label>Last crash</q-item-label>
              <q-item-label caption
                >{{ health.lastCrash.at }} — {{ health.lastCrash.summary }}</q-item-label
              >
            </q-item-section>
          </q-item>
          <q-item v-if="health.lastCrashReport">
            <q-item-section>
              <q-item-label>Latest crash report</q-item-label>
              <q-item-label caption>
                {{ health.lastCrashReport.filename }}
                <span v-if="health.lastCrashReport.summary">
                  — {{ health.lastCrashReport.summary }}
                </span>
              </q-item-label>
            </q-item-section>
          </q-item>
        </q-list>
      </q-card>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, onMounted, onUnmounted, watch } from 'vue';
import {
  Chart,
  LineController,
  LineElement,
  PointElement,
  LinearScale,
  CategoryScale,
  Filler,
} from 'chart.js';
import { useStatsSocket, type StatsSocket } from '@/composables/useStatsSocket';
import { useServerDetail } from '@/composables/useServerDetail';
import { monitoringApi, type ServerHealth } from '@/api/monitoring';

Chart.register(LineController, LineElement, PointElement, LinearScale, CategoryScale, Filler);

const { server, statusVersion } = useServerDetail();
const cpuCanvas = ref<HTMLCanvasElement>();
const memCanvas = ref<HTMLCanvasElement>();
const tpsCanvas = ref<HTMLCanvasElement>();

let cpuChart: Chart | null = null;
let memChart: Chart | null = null;
let tpsChart: Chart | null = null;
let socket: StatsSocket | null = null;
let stopWatchingSocket: (() => void)[] = [];

const MAX_POINTS = 60;
const MAX_TPS_POINTS = 90; // one reading per 10 s -> 15 min
const cpuData: number[] = [];
const memData: number[] = [];
const labels: string[] = [];
const tpsData: number[] = [];
const tpsLabels: string[] = [];

const cpuNow = ref<number | null>(null);
const memNowMb = ref<number | null>(null);

const tpsReading = computed(() => socket?.tps.value ?? null);
const tpsUnavailable = computed(() => !!socket?.tpsProbed.value && !socket.tps.value);

const statStrip = computed(() => {
  const t = tpsReading.value;
  const tps = t?.tps1 ?? null;
  return [
    { label: 'CPU', value: cpuNow.value === null ? '—' : `${cpuNow.value}%`, color: '' },
    { label: 'Memory', value: memNowMb.value === null ? '—' : `${memNowMb.value} MB`, color: '' },
    {
      label: 'TPS',
      value: tps === null ? '—' : tps.toFixed(1),
      color:
        tps === null
          ? ''
          : tps >= 19
            ? 'text-positive'
            : tps >= 15
              ? 'text-warning'
              : 'text-negative',
    },
    { label: 'MSPT', value: t?.mspt == null ? '—' : t.mspt.toFixed(1), color: '' },
  ];
});

function makeChart(
  canvas: HTMLCanvasElement,
  chartLabels: string[],
  label: string,
  color: string,
  yMax?: number,
) {
  return new Chart(canvas, {
    type: 'line',
    data: {
      labels: chartLabels,
      datasets: [
        {
          label,
          data: [],
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
      scales: {
        x: { display: false },
        y: yMax ? { beginAtZero: true, suggestedMax: yMax } : { beginAtZero: true },
      },
      plugins: { legend: { display: false } },
    },
  });
}

function destroyCharts() {
  cpuChart?.destroy();
  memChart?.destroy();
  tpsChart?.destroy();
  cpuChart = memChart = tpsChart = null;
}

function stopSocket() {
  stopWatchingSocket.forEach((stop) => stop());
  stopWatchingSocket = [];
  socket?.close();
  socket = null;
}

function startLive() {
  const s = server.value;
  if (!s || socket) return;
  socket = useStatsSocket(s.id);
  const live = socket;
  if (cpuCanvas.value) cpuChart = makeChart(cpuCanvas.value, labels, 'CPU %', '#3fa62b');
  if (memCanvas.value) memChart = makeChart(memCanvas.value, labels, 'Memory MB', '#21a7ab');
  if (tpsCanvas.value) tpsChart = makeChart(tpsCanvas.value, tpsLabels, 'TPS', '#e0a526', 20);

  stopWatchingSocket.push(
    watch(
      () => live.sample.value,
      (sample) => {
        if (!sample || sample.kind !== 'stats') return;
        labels.push(new Date().toLocaleTimeString());
        cpuNow.value = Math.round((sample.cpuPct ?? 0) * 10) / 10;
        memNowMb.value = Math.round((sample.memUsedBytes ?? 0) / 1024 / 1024);
        cpuData.push(cpuNow.value);
        memData.push(memNowMb.value);
        if (labels.length > MAX_POINTS) {
          labels.shift();
          cpuData.shift();
          memData.shift();
        }
        if (cpuChart) {
          cpuChart.data.datasets[0]!.data = [...cpuData];
          cpuChart.update('none');
        }
        if (memChart) {
          memChart.data.datasets[0]!.data = [...memData];
          memChart.update('none');
        }
      },
    ),
    watch(
      () => live.tps.value,
      (t) => {
        if (t?.tps1 == null) return;
        tpsLabels.push(new Date().toLocaleTimeString());
        tpsData.push(t.tps1);
        if (tpsLabels.length > MAX_TPS_POINTS) {
          tpsLabels.shift();
          tpsData.shift();
        }
        if (tpsChart) {
          tpsChart.data.datasets[0]!.data = [...tpsData];
          tpsChart.update('none');
        }
      },
    ),
  );
}

// Canvases only exist while the server runs, so charts + socket follow status.
watch(
  () => server.value?.status === 'running',
  async (running) => {
    if (running) {
      await nextTick();
      startLive();
    } else {
      stopSocket();
      destroyCharts();
      cpuNow.value = memNowMb.value = null;
    }
  },
);

const health = ref<ServerHealth | null>(null);
const healthError = ref<string | null>(null);
let healthTimer: ReturnType<typeof setInterval> | undefined;

async function loadHealth() {
  const id = server.value?.id;
  if (!id) return;
  try {
    health.value = (await monitoringApi.health(id)).health;
    healthError.value = null;
  } catch {
    healthError.value = 'Could not load health details.';
  }
}

const healthColor = computed(() => {
  switch (health.value?.health) {
    case 'healthy':
      return 'positive';
    case 'unhealthy':
      return 'negative';
    case 'starting':
      return 'warning';
    default:
      return 'grey';
  }
});

watch(statusVersion, () => void loadHealth());

onMounted(() => {
  if (server.value?.status === 'running') startLive();
  void loadHealth();
  healthTimer = setInterval(() => void loadHealth(), 30_000);
});

onUnmounted(() => {
  if (healthTimer) clearInterval(healthTimer);
  stopSocket();
  destroyCharts();
});
</script>
