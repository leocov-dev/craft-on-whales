<template>
  <q-page class="q-pa-md">
    <PageHeader
      title="Modpacks"
      icon="inventory_2"
      subtitle="Browse, install, and manage modded servers."
    />

    <q-banner v-if="packServers.length === 0" rounded class="q-mb-lg">
      <template #avatar>
        <q-icon name="info" color="primary" />
      </template>
      No modpack servers yet. Create one from a blueprint, or browse packs below.
    </q-banner>

    <div v-else class="row q-col-gutter-md q-mb-lg">
      <div v-for="s in packServers" :key="s.id" class="col-12 col-md-6 col-xl-4">
        <q-card flat bordered class="q-pa-md">
          <div class="row items-center q-gutter-x-sm">
            <router-link :to="`/servers/${s.id}`" class="text-subtitle2 text-primary">{{
              s.name
            }}</router-link>
            <q-badge v-if="s.updateAvailable" color="warning" label="update available" />
          </div>
          <q-item-label caption>{{ s.pack?.platform }} · {{ s.pack?.name }}</q-item-label>
          <div class="text-caption q-mt-xs">
            {{ s.pack?.version }}
            <template v-if="s.updateAvailable"> → {{ s.pack?.latest }}</template>
          </div>
          <div class="row q-gutter-x-xs q-mt-sm">
            <q-btn
              v-if="s.updateAvailable"
              dense
              outline
              color="primary"
              label="Upgrade"
              :loading="busyId === s.id"
              @click="upgrade(s)"
            />
            <q-btn dense flat label="Rollback" :loading="busyId === s.id" @click="rollback(s)" />
            <q-btn dense flat label="View mods" @click="viewInstalledMods(s.id)" />
          </div>
        </q-card>
      </div>
    </div>

    <q-separator class="q-mb-md" />

    <q-tabs
      v-model="installTab"
      dense
      align="left"
      active-color="primary"
      indicator-color="primary"
    >
      <q-tab name="packwiz" label="Packwiz URL" />
      <q-tab name="browse" label="Browse packs" />
    </q-tabs>
    <q-separator class="q-mb-md" />

    <q-tab-panels v-model="installTab" animated class="bg-transparent">
      <q-tab-panel name="packwiz" class="q-px-none">
        <q-item-label caption class="q-mb-sm">
          packwiz packs aren't searchable — paste the <code>pack.toml</code> URL your pack author
          gave you.
        </q-item-label>
        <q-card flat bordered class="q-pa-md" style="max-width: 640px">
          <div class="q-gutter-md">
            <q-input
              v-model="packwiz.url"
              dense
              filled
              label="pack.toml URL"
              placeholder="https://example.com/modpack/pack.toml"
            />
            <q-input v-model="packwiz.name" dense filled label="Server name" />
            <div class="row q-col-gutter-sm">
              <div class="col-6">
                <q-input
                  v-model.number="packwiz.portGame"
                  type="number"
                  label="Game port"
                  filled
                  dense
                />
              </div>
              <div class="col-6">
                <q-input
                  v-model.number="packwiz.diskQuotaGb"
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
                  v-model.number="packwiz.heapMb"
                  type="number"
                  label="Java heap (MB)"
                  filled
                  dense
                />
              </div>
              <div class="col-6">
                <q-input
                  v-model.number="packwiz.containerMemoryMb"
                  type="number"
                  label="Container memory (MB)"
                  filled
                  dense
                />
              </div>
            </div>
            <q-btn
              color="primary"
              label="Preview"
              :loading="previewing"
              :disable="!packwiz.url.trim()"
              @click="previewPackwiz"
            />
          </div>
        </q-card>
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
              clickable
              class="q-pa-sm row no-wrap items-center q-gutter-x-sm"
              @click="viewSearchResult(r)"
            >
              <q-avatar square size="40px">
                <img v-if="r.iconUrl" :src="r.iconUrl" :alt="r.name" />
                <q-icon v-else name="inventory_2" />
              </q-avatar>
              <div class="col min-width-0">
                <div class="text-body2 ellipsis">{{ r.name }}</div>
                <q-item-label caption>{{ r.downloads.toLocaleString() }} downloads</q-item-label>
              </div>
            </q-card>
          </div>
        </div>
      </q-tab-panel>
    </q-tab-panels>

    <PackDetailsDialog
      v-model="detailsOpen"
      :platform="detailsPlatform"
      :pack-ref="detailsPackRef"
      :server-id="detailsSource === 'installed' ? (detailsServerId ?? undefined) : undefined"
      :show-create="detailsSource === 'preview'"
      :creating="creating"
      @create="createFromPackwiz"
    />
  </q-page>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useQuasar } from 'quasar';
import { useRouter } from 'vue-router';
import { packsApi, type PackSearchResult, type PackPlatform } from '@/api/packs';
import { settingsApi } from '@/api/settings';
import { tasksApi } from '@/api/tasks';
import { useServersStore } from '@/stores/servers';
import type { ServerViewModel } from '@/api/servers';
import PackDetailsDialog from '@/components/PackDetailsDialog.vue';
import PageHeader from '@/components/PageHeader.vue';

const $q = useQuasar();
const router = useRouter();
const servers = useServersStore();

const installTab = ref<'packwiz' | 'browse'>('packwiz');
const query = ref('');
const platform = ref<'modrinth' | 'curseforge'>('modrinth');
const results = ref<PackSearchResult[]>([]);
const busyId = ref<string | null>(null);

const packwiz = ref({
  url: '',
  name: '',
  portGame: undefined as number | undefined,
  diskQuotaGb: 10,
  heapMb: 2048,
  containerMemoryMb: 3072,
});
const previewing = ref(false);
const creating = ref(false);
const detailsOpen = ref(false);
const detailsSource = ref<'preview' | 'installed' | 'search' | null>(null);
const detailsServerId = ref<string | null>(null);
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

const packServers = computed(() => servers.servers.filter((s: ServerViewModel) => s.pack !== null));

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
    $q.notify({
      type: 'negative',
      message: err instanceof Error ? err.message : 'Search failed.',
    });
  }
}

async function upgrade(s: ServerViewModel) {
  busyId.value = s.id;
  try {
    const { taskId } = await packsApi.upgrade(s.id, s.pack?.latestVersionId ?? undefined);
    await tasksApi.waitFor(taskId);
    $q.notify({ type: 'positive', message: `${s.name} upgraded.` });
    await servers.fetchServers();
  } catch (err) {
    $q.notify({
      type: 'negative',
      message: err instanceof Error ? err.message : 'Upgrade failed.',
    });
  } finally {
    busyId.value = null;
  }
}

function rollback(s: ServerViewModel) {
  $q.dialog({
    title: `Rollback ${s.name}?`,
    message: 'Restores the most recent pre-update backup.',
    cancel: true,
    ok: { color: 'negative', label: 'Rollback' },
  }).onOk(() => {
    void (async () => {
      busyId.value = s.id;
      try {
        const { taskId } = await packsApi.rollback(s.id);
        await tasksApi.waitFor(taskId);
        $q.notify({ type: 'positive', message: `${s.name} rolled back.` });
        await servers.fetchServers();
      } catch (err) {
        $q.notify({
          type: 'negative',
          message: err instanceof Error ? err.message : 'Rollback failed.',
        });
      } finally {
        busyId.value = null;
      }
    })();
  });
}

async function previewPackwiz() {
  const url = packwiz.value.url.trim();
  if (!url) return;
  previewing.value = true;
  try {
    const { pack } = await packsApi.resolve('packwiz', url);
    if (!packwiz.value.name.trim()) packwiz.value.name = pack.projectName;
    detailsSource.value = 'preview';
    detailsServerId.value = null;
    detailsPlatform.value = 'packwiz';
    detailsPackRef.value = url;
    detailsOpen.value = true;
  } catch (err) {
    $q.notify({
      type: 'negative',
      message: err instanceof Error ? err.message : 'Could not resolve that pack.toml URL.',
    });
  } finally {
    previewing.value = false;
  }
}

function viewSearchResult(r: PackSearchResult) {
  detailsSource.value = 'search';
  detailsServerId.value = null;
  detailsPlatform.value = r.platform;
  detailsPackRef.value = r.ref;
  detailsOpen.value = true;
}

function viewInstalledMods(serverId: string) {
  detailsSource.value = 'installed';
  detailsServerId.value = serverId;
  detailsPlatform.value = undefined;
  detailsPackRef.value = undefined;
  detailsOpen.value = true;
}

async function createFromPackwiz() {
  if (!packwiz.value.name.trim()) {
    $q.notify({ type: 'negative', message: 'Enter a server name.' });
    return;
  }
  creating.value = true;
  try {
    const { taskId } = await packsApi.fromPack({
      name: packwiz.value.name.trim(),
      platform: 'packwiz',
      ref: packwiz.value.url.trim(),
      portGame: packwiz.value.portGame,
      diskQuotaGb: packwiz.value.diskQuotaGb,
      heapMb: packwiz.value.heapMb,
      containerMemoryMb: packwiz.value.containerMemoryMb,
    });
    const task = await tasksApi.waitFor<{ serverId: string }>(taskId);
    $q.notify({ type: 'positive', message: `${packwiz.value.name} created.` });
    detailsOpen.value = false;
    await servers.fetchServers();
    if (task.result?.serverId) await router.push(`/servers/${task.result.serverId}`);
  } catch (err) {
    $q.notify({
      type: 'negative',
      message: err instanceof Error ? err.message : 'Could not create server from that pack.',
    });
  } finally {
    creating.value = false;
  }
}

onMounted(async () => {
  if (!servers.loaded) await servers.fetchServers();
  try {
    const settings = await settingsApi.get();
    curseforgeConfigured.value = !!settings.curseforge.masked;
  } catch {
    // best-effort — leave CurseForge enabled if we can't tell either way
  }
});
</script>

<style scoped>
.min-width-0 {
  min-width: 0;
}
</style>
