<template>
  <div class="q-gutter-md" style="max-width: 640px">
    <q-select
      v-model="form.type"
      :options="typeOptions"
      option-label="label"
      option-value="value"
      emit-value
      map-options
      filled
      dense
      label="Server type"
    />

    <q-select
      v-model="form.mcVersion"
      :options="versionOptions"
      filled
      dense
      use-input
      label="Minecraft version"
      @filter="filterVersions"
    />

    <NewServerSettings v-model="settings" :disable="creating" @valid="settingsValid = $event" />

    <q-btn
      color="primary"
      label="Create & start"
      :loading="creating"
      :disable="!canCreate"
      @click="create"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useQuasar } from 'quasar';
import { wizardApi, type MojangVersionEntry } from '@/api/wizard';
import { settingsApi } from '@/api/settings';
import { useServersStore } from '@/stores/servers';
import NewServerSettings from '@/components/NewServerSettings.vue';
import type { NewServerSettingsModel } from '@/utils/new-server';

const $q = useQuasar();
const router = useRouter();
const servers = useServersStore();

const typeOptions = [
  { label: 'Vanilla', value: 'VANILLA' },
  { label: 'Paper', value: 'PAPER' },
  { label: 'Purpur', value: 'PURPUR' },
  { label: 'Fabric', value: 'FABRIC' },
  { label: 'Forge', value: 'FORGE' },
  { label: 'NeoForge', value: 'NEOFORGE' },
  { label: 'Quilt', value: 'QUILT' },
];

const allVersions = ref<MojangVersionEntry[]>([]);
const versionOptions = ref<string[]>([]);
const form = ref({ type: 'PAPER', mcVersion: 'LATEST' });

// Placeholder values until the admin-configured defaults load in onMounted.
const settings = ref<NewServerSettingsModel>({
  name: '',
  portGame: undefined,
  diskQuotaGb: 10,
  heapMb: 2048,
  containerMemoryMb: 3072,
});
const settingsValid = ref(true);
const creating = ref(false);

const canCreate = computed(
  () =>
    Boolean(settings.value.name.trim()) &&
    Boolean(settings.value.portGame) &&
    settingsValid.value &&
    !creating.value,
);

function filterVersions(val: string, update: (fn: () => void) => void) {
  update(() => {
    const needle = val.toLowerCase();
    versionOptions.value = ['LATEST', ...allVersions.value.map((v) => v.id)].filter((id) =>
      id.toLowerCase().includes(needle),
    );
  });
}

async function create() {
  const s = settings.value;
  if (!canCreate.value || !s.portGame) return;
  creating.value = true;
  try {
    const res = await wizardApi.create({
      name: s.name.trim(),
      type: form.value.type,
      mcVersion: form.value.mcVersion,
      portGame: s.portGame,
      heapMb: s.heapMb,
      containerMemoryMb: s.containerMemoryMb,
      diskQuotaGb: s.diskQuotaGb,
      start: true,
    });
    $q.notify({ type: 'positive', message: `Server "${res.server.display_name}" created.` });
    await servers.fetchServers();
    await router.push(`/servers/${res.server.id}`);
  } catch (err) {
    $q.notify({
      type: 'negative',
      message: err instanceof Error ? err.message : 'Could not create server.',
    });
  } finally {
    creating.value = false;
  }
}

onMounted(async () => {
  if (!servers.loaded) await servers.fetchServers();
  const [versionsRes, portsRes, defaultsRes] = await Promise.all([
    wizardApi.versions(),
    wizardApi.suggestPorts(),
    settingsApi.getDefaults(),
  ]);
  allVersions.value = versionsRes.versions;
  versionOptions.value = ['LATEST', ...allVersions.value.slice(0, 50).map((v) => v.id)];
  settings.value.portGame = portsRes.ports.game;
  settings.value.heapMb = defaultsRes.defaults.heapMb;
  settings.value.containerMemoryMb = defaultsRes.defaults.containerMemoryMb;
  settings.value.diskQuotaGb = defaultsRes.defaults.diskQuotaGb;
});
</script>
