<template>
  <div v-if="server?.status !== 'running'" class="text-center text-ink-faint q-pa-xl">
    Metrics are only available while the server is running.
  </div>
  <div v-else class="row q-col-gutter-md">
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
      </q-card>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue';
import {
  Chart,
  LineController,
  LineElement,
  PointElement,
  LinearScale,
  CategoryScale,
  Filler,
} from 'chart.js';
import { useStatsSocket } from '@/composables/useStatsSocket';
import { useServerDetail } from '@/composables/useServerDetail';

Chart.register(LineController, LineElement, PointElement, LinearScale, CategoryScale, Filler);

const { server } = useServerDetail();
const cpuCanvas = ref<HTMLCanvasElement>();
const memCanvas = ref<HTMLCanvasElement>();

let cpuChart: Chart | null = null;
let memChart: Chart | null = null;
let socket: ReturnType<typeof useStatsSocket> | null = null;

const MAX_POINTS = 60;
const cpuData: number[] = [];
const memData: number[] = [];
const labels: string[] = [];

function makeChart(canvas: HTMLCanvasElement, label: string, color: string) {
  return new Chart(canvas, {
    type: 'line',
    data: {
      labels,
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
      scales: { x: { display: false }, y: { beginAtZero: true } },
      plugins: { legend: { display: false } },
    },
  });
}

onMounted(() => {
  if (cpuCanvas.value) cpuChart = makeChart(cpuCanvas.value, 'CPU %', '#3fa62b');
  if (memCanvas.value) memChart = makeChart(memCanvas.value, 'Memory MB', '#21a7ab');
  if (server.value) startSocket();
});

function startSocket() {
  if (!server.value) return;
  socket = useStatsSocket(server.value.id);
  watch(
    () => socket!.sample.value,
    (s) => {
      if (!s || s.kind !== 'stats') return;
      const t = new Date().toLocaleTimeString();
      labels.push(t);
      cpuData.push(Math.round((s.cpuPct ?? 0) * 10) / 10);
      memData.push(Math.round((s.memUsedBytes ?? 0) / 1024 / 1024));
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
  );
}

onUnmounted(() => {
  socket?.close();
  cpuChart?.destroy();
  memChart?.destroy();
});
</script>
