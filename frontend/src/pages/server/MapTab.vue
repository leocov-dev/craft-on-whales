<template>
  <div v-if="!config">
    <q-spinner color="primary" />
  </div>
  <div v-else-if="!config.supported" class="text-center text-ink-faint q-pa-xl">
    BlueMap isn't supported for this server type.
  </div>
  <div v-else-if="!config.enabled" class="text-center q-pa-xl">
    <p class="text-ink-faint">The live map isn't enabled for this server yet.</p>
    <q-btn color="primary" label="Enable map" :loading="busy" @click="enable" />
  </div>
  <div v-else>
    <div class="row items-center q-mb-sm">
      <q-btn flat dense label="Disable" color="negative" :loading="busy" @click="disable" />
    </div>
    <iframe :src="mapApi.viewUrl(server!.id)" class="map-frame" title="Live map" />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useQuasar } from 'quasar';
import { mapApi } from '@/api/map';
import { useServerDetail } from '@/composables/useServerDetail';

const $q = useQuasar();
const { server } = useServerDetail();

const config = ref<{ enabled: boolean; hostPort: number | null; supported: boolean } | null>(null);
const busy = ref(false);

async function load() {
  if (!server.value) return;
  const res = await mapApi.get(server.value.id);
  config.value = { enabled: res.enabled, hostPort: res.hostPort, supported: res.supported };
}

async function enable() {
  if (!server.value) return;
  busy.value = true;
  try {
    await mapApi.enable(server.value.id);
    $q.notify({ type: 'positive', message: 'Map enabled — applies on next restart.' });
    await load();
  } catch (err) {
    $q.notify({
      type: 'negative',
      message: err instanceof Error ? err.message : 'Could not enable map.',
    });
  } finally {
    busy.value = false;
  }
}

async function disable() {
  if (!server.value) return;
  busy.value = true;
  try {
    await mapApi.disable(server.value.id);
    $q.notify({ type: 'positive', message: 'Map disabled — applies on next restart.' });
    await load();
  } finally {
    busy.value = false;
  }
}

onMounted(load);
</script>

<style scoped>
.map-frame {
  width: 100%;
  height: 640px;
  border: 1px solid var(--color-line);
  border-radius: 4px;
}
</style>
