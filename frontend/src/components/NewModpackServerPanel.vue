<template>
  <div>
    <q-item-label caption class="q-mb-sm">
      Pick where the pack comes from, set the server up, then preview before anything is created.
    </q-item-label>
    <q-tabs
      v-model="installTab"
      dense
      align="left"
      active-color="primary"
      indicator-color="primary"
    >
      <q-tab name="packwiz" label="Packwiz URL" />
      <q-tab name="browse" label="Browse packs" />
      <q-tab name="zip" label="Upload zip" />
    </q-tabs>
    <q-separator class="q-mb-md" />

    <q-tab-panels v-model="installTab" animated class="bg-transparent">
      <q-tab-panel name="packwiz" class="q-px-none">
        <q-item-label caption class="q-mb-sm">
          packwiz packs aren't searchable — paste the <code>pack.toml</code> URL your pack author
          gave you.
        </q-item-label>
        <q-input
          v-model="packwizUrl"
          dense
          filled
          label="pack.toml URL"
          placeholder="https://example.com/modpack/pack.toml"
          style="max-width: 640px"
        />
      </q-tab-panel>

      <q-tab-panel name="browse" class="q-px-none">
        <div class="row q-col-gutter-sm items-center q-mb-md">
          <div class="col-8 col-sm-5">
            <q-input
              v-model="query"
              dense
              filled
              placeholder="Search Modrinth or CurseForge…"
              @keyup.enter="search"
            />
          </div>
          <div class="col-4 col-sm-3">
            <q-select
              v-model="platform"
              dense
              filled
              emit-value
              map-options
              :options="platformOptions"
              @update:model-value="search"
            />
          </div>
          <div class="col-12 col-sm-4">
            <q-btn
              dense
              outline
              color="primary"
              label="Search"
              class="full-width"
              @click="search"
            />
          </div>
        </div>

        <div class="row q-col-gutter-md">
          <div v-for="r in results" :key="r.ref" class="col-12 col-sm-6 col-md-4 col-lg-3">
            <q-card
              flat
              bordered
              class="q-pa-sm row no-wrap items-center q-gutter-x-sm cursor-pointer"
              :class="{ 'border-primary': selected?.ref === r.ref }"
              :style="selected?.ref === r.ref ? 'border-color: var(--q-primary)' : ''"
              @click="selectResult(r)"
            >
              <q-avatar square size="40px">
                <img v-if="r.iconUrl" :src="r.iconUrl" :alt="r.name" />
                <q-icon v-else name="inventory_2" />
              </q-avatar>
              <div class="col min-width-0">
                <div class="text-body2 ellipsis">{{ r.name }}</div>
                <q-item-label caption>{{ r.downloads.toLocaleString() }} downloads</q-item-label>
              </div>
              <q-btn flat round dense icon="info" @click.stop="viewSearchResult(r)" />
            </q-card>
          </div>
        </div>
        <q-item-label v-if="selected" caption class="q-mt-sm">
          Selected: {{ selected.name }} (latest version).
          <template v-if="selected.platform === 'curseforge'">
            CurseForge packs whose authors disabled third-party downloads may fail on first boot.
          </template>
        </q-item-label>
      </q-tab-panel>

      <q-tab-panel name="zip" class="q-px-none">
        <CreateFromZipPanel v-model="zipSource" :disable="busy" />
      </q-tab-panel>
    </q-tab-panels>

    <template v-if="sourceReady">
      <q-separator class="q-my-md" />
      <div class="text-subtitle2 q-mb-sm">Server settings</div>
      <div style="max-width: 640px">
        <NewServerSettings v-model="settings" :disable="busy" @valid="settingsValid = $event" />
        <q-btn
          color="primary"
          label="Preview"
          class="q-mt-md"
          :loading="previewing"
          :disable="!settingsValid"
          @click="preview"
        />
      </div>
    </template>

    <NewServerPreviewDialog
      v-if="previewModel"
      v-model="previewOpen"
      :preview="previewModel"
      :settings="settings"
      :creating="creating"
      :step="step"
      :progress="progress"
      :can-create="canCreate"
      @create="create"
    />

    <PackDetailsDialog
      v-model="detailsOpen"
      :platform="detailsPlatform"
      :pack-ref="detailsPackRef"
    />

    <ModImportReportDialog
      :model-value="reportOpen"
      :report="zipResult?.report ?? null"
      @update:model-value="onReportClosed"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue';
import { useQuasar } from 'quasar';
import { useRouter } from 'vue-router';
import { packsApi, type PackSearchResult, type PackPlatform } from '@/api/packs';
import { settingsApi } from '@/api/settings';
import { tasksApi } from '@/api/tasks';
import { wizardApi, type ServerFromZipResult } from '@/api/wizard';
import { useServersStore } from '@/stores/servers';
import PackDetailsDialog from '@/components/PackDetailsDialog.vue';
import CreateFromZipPanel from '@/components/CreateFromZipPanel.vue';
import NewServerSettings from '@/components/NewServerSettings.vue';
import NewServerPreviewDialog from '@/components/NewServerPreviewDialog.vue';
import ModImportReportDialog from '@/components/ModImportReportDialog.vue';
import type { NewServerPreview, NewServerSettingsModel } from '@/utils/new-server';
import {
  describeZipTarget,
  serverNameFromArchive,
  zipPreviewToModel,
  type ZipSourceModel,
} from '@/utils/zip-server';

const $q = useQuasar();
const router = useRouter();
const servers = useServersStore();

const installTab = ref<'packwiz' | 'browse' | 'zip'>('packwiz');
const query = ref('');
const platform = ref<'modrinth' | 'curseforge'>('modrinth');
const results = ref<PackSearchResult[]>([]);

// Source state, one per tab. Only the active tab's counts.
const packwizUrl = ref('');
const selected = ref<PackSearchResult | null>(null);
const zipSource = ref<ZipSourceModel>({
  file: null,
  loader: 'auto',
  mcVersion: '',
  applyOverrides: true,
});

// Shared by every source.
const settings = ref<NewServerSettingsModel>({
  name: '',
  portGame: undefined,
  diskQuotaGb: 10,
  heapMb: 2048,
  containerMemoryMb: 3072,
});
const settingsValid = ref(true);

const previewing = ref(false);
const previewOpen = ref(false);
const previewModel = ref<NewServerPreview | null>(null);
const zipTargetKnown = ref(true);
const creating = ref(false);
const step = ref('');
const progress = ref<number | null>(null);
const busy = computed(() => previewing.value || creating.value);

// A zip preview leaves the upload on the server under this token (see MODS_NOTES.md).
const zipToken = ref<string | null>(null);
const zipTokenFile = ref<File | null>(null);
const zipResult = ref<ServerFromZipResult | null>(null);
const reportOpen = ref(false);

const detailsOpen = ref(false);
const detailsPlatform = ref<PackPlatform | undefined>(undefined);
const detailsPackRef = ref<string | undefined>(undefined);

const curseforgeConfigured = ref(true);

const platformOptions = computed(() => [
  { label: 'Modrinth', value: 'modrinth' },
  {
    label: curseforgeConfigured.value ? 'CurseForge' : 'CurseForge (no API key)',
    value: 'curseforge',
    disable: !curseforgeConfigured.value,
  },
]);

const sourceReady = computed(() => {
  if (installTab.value === 'packwiz') return Boolean(packwizUrl.value.trim());
  if (installTab.value === 'browse') return selected.value !== null;
  return zipSource.value.file !== null;
});

const canCreate = computed(
  () => Boolean(settings.value.name.trim()) && settingsValid.value && zipTargetKnown.value,
);

function fail(err: unknown, fallback: string) {
  $q.notify({ type: 'negative', message: err instanceof Error ? err.message : fallback });
}

async function dropZipToken() {
  const token = zipToken.value;
  zipToken.value = null;
  zipTokenFile.value = null;
  if (token) await wizardApi.discardZipPreview(token).catch(() => {});
}

// A different file invalidates the previewed upload.
watch(
  () => zipSource.value.file,
  (f) => {
    if (f && !settings.value.name.trim()) settings.value.name = serverNameFromArchive(f.name);
    if (f !== zipTokenFile.value) void dropZipToken();
  },
);

onBeforeUnmount(() => {
  void dropZipToken();
});

async function search() {
  if (!query.value.trim()) return;
  if (platform.value === 'curseforge' && !curseforgeConfigured.value) {
    $q.notify({
      type: 'warning',
      message: 'CurseForge search needs an API key — add one in Settings.',
    });
    return;
  }
  try {
    const res = await packsApi.search(query.value.trim(), platform.value);
    results.value = res.results;
  } catch (err) {
    fail(err, 'Search failed.');
  }
}

function selectResult(r: PackSearchResult) {
  selected.value = r;
  if (!settings.value.name.trim()) settings.value.name = r.name;
}

function viewSearchResult(r: PackSearchResult) {
  detailsPlatform.value = r.platform;
  detailsPackRef.value = r.ref;
  detailsOpen.value = true;
}

/** The registry (or packwiz) source of the active pack tab. */
function packSource(): { platform: PackPlatform; ref: string } {
  if (installTab.value === 'packwiz') return { platform: 'packwiz', ref: packwizUrl.value.trim() };
  return { platform: selected.value!.platform, ref: selected.value!.ref };
}

async function previewZip(file: File): Promise<NewServerPreview> {
  const opts = {
    loader: zipSource.value.loader,
    mcVersion: zipSource.value.mcVersion || undefined,
  };
  let res;
  if (zipToken.value && zipTokenFile.value === file) {
    try {
      res = await wizardApi.previewZip({ uploadToken: zipToken.value }, opts);
    } catch {
      // Expired on the server: upload again below.
      await dropZipToken();
    }
  } else {
    await dropZipToken();
  }
  if (!res) res = await wizardApi.previewZip(file, opts);
  zipToken.value = res.uploadToken;
  zipTokenFile.value = file;
  zipTargetKnown.value = res.preview.target !== null;
  if (!settings.value.name.trim())
    settings.value.name = res.preview.packName ?? serverNameFromArchive(file.name);
  const model = zipPreviewToModel(res.preview);
  // A token-based preview doesn't know the upload's filename.
  return model.name ? model : { ...model, name: file.name };
}

async function preview() {
  previewing.value = true;
  try {
    if (installTab.value === 'zip') {
      previewModel.value = await previewZip(zipSource.value.file!);
    } else {
      const { pack } = await packsApi.details(packSource());
      zipTargetKnown.value = true;
      if (!settings.value.name.trim()) settings.value.name = pack.name;
      previewModel.value = {
        name: pack.name,
        iconUrl: pack.iconUrl,
        caption: [
          pack.mcVersion || '—',
          pack.loaders?.length ? pack.loaders.join(', ') : null,
          pack.downloads != null ? `${pack.downloads.toLocaleString()} downloads` : null,
        ]
          .filter(Boolean)
          .join(' · '),
        description: pack.description || undefined,
        items: (pack.mods ?? []).map((m) => ({
          name: m.name,
          caption: m.side
            ? m.side === 'both'
              ? 'client + server'
              : m.side
            : [m.kind, m.version].filter(Boolean).join(' · ') || '—',
        })),
        itemsLabel: 'Mods',
        warnings: [],
      };
    }
    previewOpen.value = true;
  } catch (err) {
    fail(err, 'Could not preview that pack.');
  } finally {
    previewing.value = false;
  }
}

async function create() {
  if (!canCreate.value) return;
  creating.value = true;
  step.value = 'Starting…';
  progress.value = null;
  const s = settings.value;
  const resources = {
    portGame: s.portGame,
    diskQuotaGb: s.diskQuotaGb,
    heapMb: s.heapMb,
    containerMemoryMb: s.containerMemoryMb,
  };
  const onProgress = (t: { step: string; percent: number | null }) => {
    step.value = t.step;
    progress.value = t.percent;
  };
  try {
    if (installTab.value === 'zip') await createFromZip(s.name.trim(), resources, onProgress);
    else {
      const { taskId } = await packsApi.fromPack({
        name: s.name.trim(),
        ...packSource(),
        ...resources,
      });
      const task = await tasksApi.waitFor<{ serverId: string }>(taskId, { onProgress });
      $q.notify({ type: 'positive', message: `${s.name.trim()} created.` });
      previewOpen.value = false;
      await servers.fetchServers();
      if (task.result?.serverId) await router.push(`/servers/${task.result.serverId}`);
    }
  } catch (err) {
    fail(err, 'Could not create the server.');
  } finally {
    creating.value = false;
  }
}

async function createFromZip(
  name: string,
  resources: Pick<
    NewServerSettingsModel,
    'portGame' | 'diskQuotaGb' | 'heapMb' | 'containerMemoryMb'
  >,
  onProgress: (t: { step: string; percent: number | null }) => void,
) {
  const src = zipSource.value;
  const file = src.file!;
  const token = zipToken.value;
  const { taskId } = await wizardApi.fromZip(
    {
      name,
      loader: src.loader,
      mcVersion: src.mcVersion || undefined,
      applyOverrides: src.applyOverrides,
      uploadToken: token ?? undefined,
      archiveName: file.name,
      ...resources,
    },
    token ? undefined : file,
  );
  // The task removes the staged upload when it ends.
  zipToken.value = null;
  zipTokenFile.value = null;
  const task = await tasksApi.waitFor<ServerFromZipResult>(taskId, { onProgress });
  const res = task.result;
  if (!res) throw new Error('The server was created, but the task returned no result.');
  zipResult.value = res;
  previewOpen.value = false;
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
}

/** The import report is shown first; closing it goes to the new server. */
async function onReportClosed(open: boolean) {
  reportOpen.value = open;
  if (!open && zipResult.value) {
    const id = zipResult.value.serverId;
    zipResult.value = null;
    await router.push(`/servers/${id}`);
  }
}

onMounted(async () => {
  if (!servers.loaded) await servers.fetchServers();
  const [cfg, portsRes, defaultsRes] = await Promise.all([
    settingsApi.get().catch(() => null),
    wizardApi.suggestPorts().catch(() => null),
    settingsApi.getDefaults().catch(() => null),
  ]);
  // Leave CurseForge enabled if we can't tell either way.
  if (cfg) curseforgeConfigured.value = !!cfg.curseforge.masked;
  if (portsRes?.ports?.game) settings.value.portGame = portsRes.ports.game;
  if (defaultsRes) {
    settings.value.heapMb = defaultsRes.defaults.heapMb;
    settings.value.containerMemoryMb = defaultsRes.defaults.containerMemoryMb;
    settings.value.diskQuotaGb = defaultsRes.defaults.diskQuotaGb;
  }
});
</script>

<style scoped>
.min-width-0 {
  min-width: 0;
}
</style>
