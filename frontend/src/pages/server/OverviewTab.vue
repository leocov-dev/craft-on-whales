<template>
  <div v-if="server" class="row q-col-gutter-md">
    <div class="col-12 col-md-6">
      <q-card flat bordered class="q-pa-md">
        <div class="text-subtitle1 q-mb-sm">Connect</div>
        <q-list v-if="server.addresses.length" dense>
          <q-item v-for="addr in server.addresses" :key="addr">
            <q-item-section class="font-mono">{{ addr }}</q-item-section>
            <q-item-section side>
              <q-btn flat dense round icon="content_copy" @click="copy(addr)" />
            </q-item-section>
          </q-item>
        </q-list>
        <q-item-label v-else caption>
          No externally reachable address found. Set a public domain in Settings, or enable
          mc-router for this server, so players have an address to connect to.
        </q-item-label>
      </q-card>
    </div>

    <div class="col-12 col-md-6">
      <q-card flat bordered class="q-pa-md">
        <div class="text-subtitle1 q-mb-sm">Live usage</div>
        <div class="row q-col-gutter-md text-body2">
          <div class="col-6">
            <q-item-label caption>Players</q-item-label>
            <div>{{ server.players.online }}/{{ server.players.max }}</div>
          </div>
          <div class="col-6">
            <q-item-label caption>CPU</q-item-label>
            <div>{{ server.status === 'running' ? `${server.stats.cpuPct}%` : '—' }}</div>
          </div>
        </div>

        <q-item-label caption class="row justify-between q-mt-md q-mb-xs">
          <span>Memory</span>
          <span>
            {{ server.status === 'running' ? `${server.stats.memUsedMb} MB` : '—' }} of
            {{ server.resources.containerMemoryMb }} MB limit
          </span>
        </q-item-label>
        <q-linear-progress
          :value="memFraction"
          :buffer="heapFraction"
          :color="meterColor(server.stats.memUsedMb, server.resources.containerMemoryMb)"
          track-color="grey-9"
          rounded
          size="10px"
        >
          <q-tooltip anchor="top middle" self="bottom middle">{{ heapTooltip }}</q-tooltip>
        </q-linear-progress>
        <q-item-label caption class="q-mt-xs">
          <q-icon name="info" size="14px" class="q-mr-xs" />
          Java heap {{ server.resources.heapMb }} MB of the
          {{ server.resources.containerMemoryMb }} MB container limit.
          {{ server.resources.heapNote }}
        </q-item-label>
      </q-card>
    </div>

    <div class="col-12 col-md-6">
      <q-card flat bordered class="q-pa-md">
        <div class="text-subtitle1 q-mb-sm">Details</div>
        <div class="row q-col-gutter-md text-body2">
          <div class="col-6">
            <q-item-label caption>Type</q-item-label>
            <div>{{ server.flavor }}</div>
          </div>
          <div class="col-6">
            <q-item-label caption>Version</q-item-label>
            <div>{{ server.mcVersion }}</div>
          </div>
          <div class="col-6">
            <q-item-label caption>Java</q-item-label>
            <div>{{ server.javaTag }}</div>
          </div>
          <div class="col-6">
            <q-item-label caption>Created</q-item-label>
            <div>{{ new Date(server.created).toLocaleDateString() }}</div>
          </div>
          <div v-if="server.pack?.platform === 'packwiz' && server.pack.ref" class="col-12">
            <q-item-label caption>Modpack (packwiz)</q-item-label>
            <div>
              <a :href="server.pack.ref" target="_blank" rel="noopener">{{ server.pack.ref }}</a>
            </div>
          </div>
        </div>
      </q-card>
    </div>

    <div class="col-12 col-md-6">
      <q-card flat bordered class="q-pa-md">
        <div class="text-subtitle1 q-mb-sm">Description</div>
        <q-item-label caption>{{ server.description || 'No description.' }}</q-item-label>
        <div v-if="server.tags.length" class="row q-gutter-xs q-mt-sm">
          <q-chip
            v-for="tag in server.tags"
            :key="tag"
            dense
            size="sm"
            color="accent"
            text-color="dark"
            >{{ tag }}</q-chip
          >
        </div>
      </q-card>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useQuasar } from 'quasar';
import { useServerDetail } from '@/composables/useServerDetail';
import { meterColor } from '@/composables/useServerStatus';

const $q = useQuasar();
const { server } = useServerDetail();

const fraction = (part: number, whole: number): number =>
  whole > 0 ? Math.min(1, part / whole) : 0;

/** Live usage on the container-limit scale. */
const memFraction = computed(() =>
  server.value && server.value.status === 'running'
    ? fraction(server.value.stats.memUsedMb, server.value.resources.containerMemoryMb)
    : 0,
);

/**
 * The heap on that same scale, drawn as the progress bar's buffer so the user
 * can see where the JVM's ceiling sits inside the container limit.
 */
const heapFraction = computed(() =>
  server.value
    ? fraction(server.value.resources.heapMb, server.value.resources.containerMemoryMb)
    : 0,
);

const heapTooltip = computed(
  () =>
    server.value?.resources.heapNote ??
    'The lighter mark is the Java heap inside the container memory limit.',
);

async function copy(text: string) {
  await navigator.clipboard.writeText(text);
  $q.notify({ type: 'positive', message: 'Copied.' });
}
</script>
