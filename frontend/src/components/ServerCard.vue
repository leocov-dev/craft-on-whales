<template>
  <q-card class="server-card" :style="{ borderTop: `3px solid ${server.accent}` }" flat bordered>
    <q-card-section class="row no-wrap items-start q-gutter-x-sm">
      <q-avatar size="44px" square>
        <img :src="iconSrc(server.icon)" :alt="server.name" @error="onIconError" />
      </q-avatar>

      <div class="col min-width-0">
        <div class="row items-center q-gutter-x-xs">
          <div class="text-subtitle2 ellipsis">{{ server.name }}</div>
          <q-badge v-if="server.updateAvailable" color="warning" label="update" />
          <q-badge
            v-if="server.crashesUnread"
            color="negative"
            :label="`${server.crashesUnread} crash${server.crashesUnread === 1 ? '' : 'es'}`"
          />
        </div>
        <q-item-label caption>
          {{ server.flavor }}
          · {{ server.mcVersion }} · :{{ server.ports.game }}
        </q-item-label>
      </div>

      <div class="column items-end">
        <div class="row items-center q-gutter-x-xs text-caption" :class="`text-${meta.color}`">
          <q-badge rounded :color="meta.color" :class="{ 'pulse-dot': meta.pulse }" />
          {{ meta.label }}
        </div>
        <div
          v-if="server.statusDetail"
          class="text-caption text-warning ellipsis"
          style="max-width: 160px"
        >
          {{ server.statusDetail }}
        </div>
      </div>
    </q-card-section>

    <q-card-section class="q-pt-none">
      <div class="row q-col-gutter-sm text-caption">
        <div class="col-4">
          <q-item-label caption>Players</q-item-label>
          <div class="text-weight-medium">
            {{ server.players.online
            }}<span class="q-item__label q-item__label--caption text-caption">/{{ server.players.max }}</span>
          </div>
        </div>
        <div class="col-4">
          <q-item-label caption>CPU</q-item-label>
          <div class="text-weight-medium">
            {{ server.status === 'running' ? `${server.stats.cpuPct}%` : '—' }}
          </div>
        </div>
        <div class="col-4">
          <q-item-label caption>Memory</q-item-label>
          <div class="text-weight-medium">
            <template v-if="server.status === 'running'">
              {{ server.stats.memUsedMb
              }}<span class="q-item__label q-item__label--caption text-caption">
                / {{ server.resources.containerMemoryMb }} MB</span
              >
            </template>
            <template v-else>—</template>
          </div>
        </div>
      </div>

      <div class="q-mt-sm">
        <q-item-label caption class="row justify-between q-mb-xs">
          <span>Disk</span>
          <span>{{ formatBytes(server.disk.used) }} of {{ formatBytes(server.disk.quota) }}</span>
        </q-item-label>
        <q-linear-progress
          :value="pctUsed(server.disk.used, server.disk.quota) / 100"
          :color="meterColor(server.disk.used, server.disk.quota)"
          track-color="grey-9"
          rounded
          size="6px"
        />
      </div>

      <div v-if="server.tags.length" class="q-mt-sm row q-gutter-xs">
        <q-chip v-for="tag in server.tags" :key="tag" dense size="sm" color="accent" text-color="dark">{{
          tag
        }}</q-chip>
      </div>
    </q-card-section>

    <q-separator />

    <q-card-actions align="right">
      <q-btn
        v-if="server.status === 'stopped' || server.status === 'crashed'"
        flat
        dense
        color="positive"
        icon="play_arrow"
        label="Start"
        :loading="busy"
        @click.stop="run('start')"
      />
      <template v-else>
        <q-btn
          flat
          dense
          color="warning"
          icon="stop"
          label="Stop"
          :loading="busy"
          @click.stop="run('stop')"
        />
        <q-btn flat dense round icon="refresh" :loading="busy" @click.stop="run('restart')">
          <q-tooltip>Restart</q-tooltip>
        </q-btn>
      </template>
      <q-btn flat dense round icon="open_in_new" :to="`/servers/${server.id}`" @click.stop>
        <q-tooltip>Open</q-tooltip>
      </q-btn>
    </q-card-actions>
  </q-card>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import type { ServerViewModel, LifecycleAction } from '@/api/servers';
import {
  statusMeta,
  iconSrc,
  formatBytes,
  pctUsed,
  meterColor,
} from '@/composables/useServerStatus';
import { useServersStore } from '@/stores/servers';

const props = defineProps<{ server: ServerViewModel }>();

const store = useServersStore();
const busy = ref(false);
const meta = computed(() => statusMeta(props.server.status));

function onIconError(e: Event) {
  (e.target as HTMLImageElement).src = '/icons/servers/grass.png';
}

async function run(action: LifecycleAction) {
  busy.value = true;
  try {
    await store.runAction(props.server.id, action);
  } finally {
    busy.value = false;
  }
}
</script>

<style scoped>
.min-width-0 {
  min-width: 0;
}
.pulse-dot {
  animation: pulse 1.6s ease-in-out infinite;
}
@keyframes pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.4;
  }
}
</style>
