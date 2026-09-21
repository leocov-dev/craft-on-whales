<template>
  <q-page class="q-pa-md flex flex-center">
    <q-card flat bordered style="width: 100%; max-width: 560px">
      <q-card-section>
        <div class="text-h6">Create a server</div>
        <q-item-label caption class="q-mt-xs">
          For a modpack, use
          <router-link to="/modpacks" class="text-primary">Modpacks</router-link> or
          <router-link to="/blueprints" class="text-primary">Blueprints</router-link> instead — this
          form is for a plain vanilla/plugin/modloader server.
        </q-item-label>
      </q-card-section>

      <q-card-section class="q-gutter-md">
        <q-input
          v-model="form.name"
          label="Server name"
          filled
          dense
          :rules="[(v) => !!v.trim() || 'Required']"
        />

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

        <div class="row q-col-gutter-sm">
          <div class="col-6">
            <q-input
              v-model.number="form.portGame"
              type="number"
              label="Game port"
              filled
              dense
              :error="Boolean(portError)"
              :error-message="portError || ''"
              :loading="portChecking"
            />
          </div>
          <div class="col-6">
            <q-input
              v-model.number="form.diskQuotaGb"
              type="number"
              label="Disk quota (GB)"
              filled
              dense
            />
          </div>
        </div>

        <div class="row q-col-gutter-sm">
          <div class="col-6">
            <q-input
              v-model.number="form.heapMb"
              type="number"
              label="Java heap (MB)"
              :hint="HEAP_FIELD_HINT"
              filled
              dense
            />
          </div>
          <div class="col-6">
            <q-input
              v-model.number="form.containerMemoryMb"
              type="number"
              label="Container memory (MB)"
              filled
              dense
            />
          </div>
        </div>
      </q-card-section>

      <q-card-actions align="right">
        <q-btn flat label="Cancel" to="/" />
        <q-btn
          color="primary"
          label="Create & start"
          :loading="creating"
          :disable="
            creating || Boolean(portError) || !form.name.trim() || !form.portGame || portChecking
          "
          @click="create"
        />
      </q-card-actions>
    </q-card>
  </q-page>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useQuasar } from 'quasar';
import { wizardApi, type MojangVersionEntry } from '@/api/wizard';
import { useServersStore } from '@/stores/servers';
import { HEAP_FIELD_HINT } from '@/composables/useServerStatus';

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

const form = ref({
  name: '',
  type: 'PAPER',
  mcVersion: 'LATEST',
  portGame: 25565,
  heapMb: 2048,
  containerMemoryMb: 3072,
  diskQuotaGb: 10,
});
const creating = ref(false);
const portChecking = ref(false);
const remotePortInUse = ref(false);
let checkDebounce: ReturnType<typeof setTimeout> | null = null;

const portError = computed(() => {
  const p = form.value.portGame;
  if (!p) return 'Game port is required';
  if (!Number.isInteger(p) || p < 1024 || p > 65535) {
    return 'Port must be an integer between 1024 and 65535';
  }
  const conflictServer = servers.servers.find((s) => s.ports?.game === p || s.ports?.rcon === p);
  if (conflictServer) {
    return `Port ${p} is already in use by server "${conflictServer.name}".`;
  }
  if (remotePortInUse.value) {
    return `Port ${p} is already in use or unavailable on host.`;
  }
  return null;
});

watch(
  () => form.value.portGame,
  (port) => {
    remotePortInUse.value = false;
    if (checkDebounce) clearTimeout(checkDebounce);
    if (!port || !Number.isInteger(port) || port < 1024 || port > 65535) {
      return;
    }
    if (servers.servers.some((s) => s.ports?.game === port || s.ports?.rcon === port)) {
      return;
    }
    portChecking.value = true;
    checkDebounce = setTimeout(() => {
      void (async () => {
        try {
          const res = await wizardApi.checkPort(port);
          if (form.value.portGame === port) {
            remotePortInUse.value = !res.free;
          }
        } catch {
          // best-effort
        } finally {
          if (form.value.portGame === port) {
            portChecking.value = false;
          }
        }
      })();
    }, 300);
  },
);

function filterVersions(val: string, update: (fn: () => void) => void) {
  update(() => {
    const needle = val.toLowerCase();
    versionOptions.value = ['LATEST', ...allVersions.value.map((v) => v.id)].filter((id) =>
      id.toLowerCase().includes(needle),
    );
  });
}

async function load() {
  if (!servers.loaded) {
    await servers.fetchServers();
  }
  const [versionsRes, portsRes] = await Promise.all([
    wizardApi.versions(),
    wizardApi.suggestPorts(),
  ]);
  allVersions.value = versionsRes.versions;
  versionOptions.value = ['LATEST', ...allVersions.value.slice(0, 50).map((v) => v.id)];
  form.value.portGame = portsRes.ports.game;
}

async function create() {
  if (!form.value.name.trim()) {
    $q.notify({ type: 'negative', message: 'Enter a server name.' });
    return;
  }
  if (portError.value) {
    $q.notify({ type: 'negative', message: portError.value });
    return;
  }
  creating.value = true;
  try {
    const res = await wizardApi.create({ ...form.value, start: true });
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

onMounted(load);
</script>
