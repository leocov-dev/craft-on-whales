<template>
  <div class="row q-col-gutter-md">
    <div class="col-12 col-md-7">
      <div class="row items-center q-mb-sm">
        <div class="text-subtitle1">Timeline</div>
        <q-space />
        <q-btn flat dense icon="refresh" label="Ingest now" :loading="ingesting" @click="ingest" />
      </div>
      <q-card flat bordered>
        <q-list separator>
          <q-item v-for="e in events" :key="e.id">
            <q-item-section avatar
              ><q-badge outline color="primary">{{ e.type }}</q-badge></q-item-section
            >
            <q-item-section>{{
              e.message ?? `${e.player ?? ''} ${e.target ?? ''}`.trim()
            }}</q-item-section>
            <q-item-section side class="text-caption text-ink-faint">{{
              new Date(e.ts).toLocaleString()
            }}</q-item-section>
          </q-item>
          <q-item v-if="events.length === 0">
            <q-item-section class="text-center text-ink-faint"
              >No activity recorded yet.</q-item-section
            >
          </q-item>
        </q-list>
      </q-card>
    </div>

    <div class="col-12 col-md-5">
      <div class="row items-center q-mb-sm">
        <div class="text-subtitle1">Scoreboard</div>
        <q-space />
        <q-select
          v-model="metric"
          dense
          outlined
          :options="metricOptions"
          emit-value
          map-options
          style="min-width: 160px"
          @update:model-value="loadScoreboard"
        />
      </div>
      <q-card flat bordered>
        <q-list separator>
          <q-item v-for="r in rows" :key="r.uuid">
            <q-item-section avatar>
              <q-badge :color="r.crown ? 'warning' : 'grey'" :label="String(r.rank)" />
            </q-item-section>
            <q-item-section>{{ r.name }}</q-item-section>
            <q-item-section side class="text-caption">{{
              r.value.toLocaleString()
            }}</q-item-section>
          </q-item>
          <q-item v-if="rows.length === 0">
            <q-item-section class="text-center text-ink-faint">No data yet.</q-item-section>
          </q-item>
        </q-list>
      </q-card>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useQuasar } from 'quasar';
import {
  analyticsApi,
  type TimelineEvent,
  type ScoreboardRow,
  type ScoreboardMetric,
} from '@/api/analytics';
import { useServerDetail } from '@/composables/useServerDetail';

const $q = useQuasar();
const { server } = useServerDetail();

const events = ref<TimelineEvent[]>([]);
const rows = ref<ScoreboardRow[]>([]);
const metric = ref<ScoreboardMetric>('playtimeTicks');
const ingesting = ref(false);

const metricOptions: { label: string; value: ScoreboardMetric }[] = [
  { label: 'Playtime', value: 'playtimeTicks' },
  { label: 'Deaths', value: 'deaths' },
  { label: 'Mob kills', value: 'mobKills' },
  { label: 'Player kills', value: 'playerKills' },
  { label: 'Blocks mined', value: 'blocksMinedTotal' },
  { label: 'Diamonds mined', value: 'diamondsMined' },
];

async function loadTimeline() {
  if (!server.value) return;
  const res = await analyticsApi.timeline(server.value.id, { limit: 50 });
  events.value = res.events;
}

async function loadScoreboard() {
  if (!server.value) return;
  const res = await analyticsApi.scoreboard(server.value.id, metric.value);
  rows.value = res.rows;
}

async function ingest() {
  if (!server.value) return;
  ingesting.value = true;
  try {
    await analyticsApi.ingestNow(server.value.id);
    $q.notify({ type: 'positive', message: 'Ingested.' });
    await Promise.all([loadTimeline(), loadScoreboard()]);
  } catch (err) {
    $q.notify({ type: 'negative', message: err instanceof Error ? err.message : 'Ingest failed.' });
  } finally {
    ingesting.value = false;
  }
}

onMounted(() => {
  void loadTimeline();
  void loadScoreboard();
});
</script>
