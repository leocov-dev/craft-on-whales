<template>
  <div>
    <q-item-label caption class="q-mb-sm">
      A Modrinth pack (<code>.mrpack</code>) or any zip of mod or plugin jars. Every jar is
      identified and installed as tracked content, and the archive's <code>overrides/</code> config
      files are applied so they can be undone later from the server's Mods tab.
    </q-item-label>
    <q-card flat bordered class="q-pa-md" style="max-width: 640px">
      <div class="q-gutter-md">
        <q-file
          v-model="file"
          dense
          filled
          clearable
          accept=".zip,.mrpack"
          label="A .mrpack or a zip of jars…"
          :disable="creating"
          @rejected="onRejected"
          @update:model-value="onFilePicked"
        >
          <template #prepend><q-icon name="upload_file" /></template>
        </q-file>
        <q-input v-model="form.name" dense filled label="Server name" :disable="creating" />
        <div class="row q-col-gutter-sm">
          <div class="col-6">
            <q-select
              v-model="form.loader"
              :options="ZIP_LOADER_OPTIONS"
              emit-value
              map-options
              dense
              filled
              label="Loader"
              :disable="creating"
            />
          </div>
          <div class="col-6">
            <q-select
              v-model="form.mcVersion"
              :options="versionOptions"
              emit-value
              map-options
              use-input
              dense
              filled
              label="Minecraft version"
              :disable="creating"
              @filter="filterVersions"
            />
          </div>
        </div>
        <q-item-label caption>
          Auto-detect reads a .mrpack's own loader and version. For a zip of jars it goes by what
          most of the jars were built for, and asks you to pick when it can't tell.
        </q-item-label>
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
        <q-toggle v-model="form.applyOverrides" :disable="creating" label="Apply overrides">
          <q-tooltip>
            Copy the archive's overrides/ config files into the new server. They're tracked, so
            removing the import from the Mods tab takes them out again.
          </q-tooltip>
        </q-toggle>
        <div v-if="creating">
          <q-linear-progress
            :value="(progress ?? 0) / 100"
            :indeterminate="progress === null"
            color="primary"
          />
          <q-item-label caption class="q-mt-xs">{{ step }}</q-item-label>
        </div>
        <q-btn
          color="primary"
          label="Create & start"
          :loading="creating"
          :disable="!file || !form.name.trim() || Boolean(portError) || portChecking"
          @click="create"
        />
      </div>
    </q-card>

    <ModImportReportDialog
      :model-value="reportOpen"
      :report="result?.report ?? null"
      @update:model-value="onReportClosed"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue';
import { useQuasar } from 'quasar';
import { useRouter } from 'vue-router';
import { wizardApi, type ServerFromZipResult } from '@/api/wizard';
import { settingsApi } from '@/api/settings';
import { tasksApi } from '@/api/tasks';
import { useServersStore } from '@/stores/servers';
import type { ServerViewModel } from '@/api/servers';
import { HEAP_FIELD_HINT } from '@/composables/useServerStatus';
import ModImportReportDialog from '@/components/ModImportReportDialog.vue';
import {
  ZIP_LOADER_OPTIONS,
  describeZipTarget,
  serverNameFromArchive,
  type ZipLoaderChoice,
} from '@/utils/zip-server';

const $q = useQuasar();
const router = useRouter();
const servers = useServersStore();

const AUTO_VERSION = { label: 'Auto-detect', value: '' };

interface ZipServerForm {
  name: string;
  loader: ZipLoaderChoice;
  /** '' = auto-detect. */
  mcVersion: string;
  applyOverrides: boolean;
  portGame: number | undefined;
  diskQuotaGb: number;
  heapMb: number;
  containerMemoryMb: number;
}

const file = ref<File | null>(null);
const form = ref<ZipServerForm>({
  name: '',
  loader: 'auto',
  mcVersion: '',
  applyOverrides: true,
  portGame: undefined,
  diskQuotaGb: 10,
  heapMb: 2048,
  containerMemoryMb: 3072,
});
const creating = ref(false);
const step = ref('');
const progress = ref<number | null>(null);
const result = ref<ServerFromZipResult | null>(null);
const reportOpen = ref(false);

const allVersions = ref<string[]>([]);
const versionOptions = ref<{ label: string; value: string }[]>([AUTO_VERSION]);

function filterVersions(val: string, update: (fn: () => void) => void) {
  update(() => {
    const needle = val.toLowerCase();
    versionOptions.value = [
      AUTO_VERSION,
      ...allVersions.value
        .filter((id) => id.toLowerCase().includes(needle))
        .slice(0, needle ? undefined : 50)
        .map((id) => ({ label: id, value: id })),
    ];
  });
}

function onRejected() {
  $q.notify({ type: 'negative', message: 'Upload a .zip or .mrpack file.' });
}

function onFilePicked(f: File | null) {
  if (f && !form.value.name.trim()) form.value.name = serverNameFromArchive(f.name);
}

const portChecking = ref(false);
const remotePortInUse = ref(false);
let checkDebounce: ReturnType<typeof setTimeout> | null = null;

const portError = computed(() => {
  const p = form.value.portGame;
  if (!p) return null;
  if (!Number.isInteger(p) || p < 1024 || p > 65535) {
    return 'Port must be an integer between 1024 and 65535';
  }
  const conflict = servers.servers.find(
    (s: ServerViewModel) => s.ports?.game === p || s.ports?.rcon === p,
  );
  if (conflict) return `Port ${p} is already in use by server "${conflict.name}".`;
  if (remotePortInUse.value) return `Port ${p} is already in use or unavailable on host.`;
  return null;
});

watch(
  () => form.value.portGame,
  (port) => {
    remotePortInUse.value = false;
    if (checkDebounce) clearTimeout(checkDebounce);
    if (!port || !Number.isInteger(port) || port < 1024 || port > 65535) return;
    if (
      servers.servers.some((s: ServerViewModel) => s.ports?.game === port || s.ports?.rcon === port)
    )
      return;
    portChecking.value = true;
    checkDebounce = setTimeout(() => {
      void (async () => {
        try {
          const res = await wizardApi.checkPort(port);
          if (form.value.portGame === port) remotePortInUse.value = !res.free;
        } catch {
          // best-effort
        } finally {
          if (form.value.portGame === port) portChecking.value = false;
        }
      })();
    }, 300);
  },
);

async function create() {
  if (!file.value || !form.value.name.trim() || portError.value) return;
  creating.value = true;
  step.value = 'Uploading…';
  progress.value = null;
  try {
    const { taskId } = await wizardApi.fromZip(file.value, {
      ...form.value,
      name: form.value.name.trim(),
      mcVersion: form.value.mcVersion || undefined,
    });
    const task = await tasksApi.waitFor<ServerFromZipResult>(taskId, {
      onProgress: (t) => {
        step.value = t.step;
        progress.value = t.percent;
      },
    });
    const res = task.result;
    if (!res) throw new Error('The server was created, but the task returned no result.');
    result.value = res;
    await servers.fetchServers();
    $q.notify({
      type: 'positive',
      message: `${res.name} created (${describeZipTarget(res.target)}).`,
    });
    if (res.startError) {
      $q.notify({
        type: 'warning',
        message: `${res.name} didn't start: ${res.startError}`,
        timeout: 0,
        actions: [{ label: 'Dismiss', color: 'white' }],
      });
    }
    reportOpen.value = true;
  } catch (err) {
    $q.notify({
      type: 'negative',
      message: err instanceof Error ? err.message : 'Could not create a server from that archive.',
    });
  } finally {
    creating.value = false;
  }
}

/** The report is shown here first; closing it goes to the new server. */
async function onReportClosed(open: boolean) {
  reportOpen.value = open;
  if (!open && result.value) {
    const id = result.value.serverId;
    result.value = null;
    await router.push(`/servers/${id}`);
  }
}

onMounted(async () => {
  if (!servers.loaded) await servers.fetchServers();
  const [versionsRes, portsRes, defaultsRes] = await Promise.all([
    wizardApi.versions().catch(() => null),
    wizardApi.suggestPorts().catch(() => null),
    settingsApi.getDefaults().catch(() => null),
  ]);
  if (versionsRes) {
    allVersions.value = versionsRes.versions.map((v) => v.id);
    filterVersions('', (fn) => fn());
  }
  if (portsRes?.ports?.game) form.value.portGame = portsRes.ports.game;
  if (defaultsRes) {
    form.value.heapMb = defaultsRes.defaults.heapMb;
    form.value.containerMemoryMb = defaultsRes.defaults.containerMemoryMb;
    form.value.diskQuotaGb = defaultsRes.defaults.diskQuotaGb;
  }
});
</script>
