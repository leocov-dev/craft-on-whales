<template>
  <q-page class="q-pa-md">
    <div class="text-h6 q-mb-md">Modpacks</div>

    <div v-if="packServers.length === 0" class="text-center text-ink-faint q-pa-xl">
      No modpack servers yet. Create one from a blueprint, or (once the setup wizard lands) directly
      from a CurseForge/Modrinth pack.
    </div>

    <div v-else class="row q-col-gutter-md q-mb-lg">
      <div v-for="s in packServers" :key="s.id" class="col-12 col-md-6 col-xl-4">
        <q-card flat bordered class="q-pa-md">
          <div class="row items-center q-gutter-x-sm">
            <router-link :to="`/servers/${s.id}`" class="text-subtitle2 text-primary">{{
              s.name
            }}</router-link>
            <q-badge v-if="s.updateAvailable" color="warning" label="update available" />
          </div>
          <div class="text-caption text-ink-faint">{{ s.pack?.platform }} · {{ s.pack?.name }}</div>
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
          </div>
        </q-card>
      </div>
    </div>

    <q-separator class="q-mb-md" />

    <div class="text-subtitle1 q-mb-sm">Browse packs</div>
    <div class="row q-col-gutter-sm items-center q-mb-md">
      <div class="col-8 col-sm-5">
        <q-input
          v-model="query"
          dense
          outlined
          placeholder="Search Modrinth or CurseForge…"
          @keyup.enter="search"
        />
      </div>
      <div class="col-4 col-sm-3">
        <q-select
          v-model="platform"
          dense
          outlined
          emit-value
          map-options
          :options="platformOptions"
          @update:model-value="search"
        />
      </div>
      <q-btn dense outline label="Search" @click="search" />
    </div>

    <div class="row q-col-gutter-md">
      <div v-for="r in results" :key="r.ref" class="col-12 col-sm-6 col-md-4 col-lg-3">
        <q-card flat bordered class="q-pa-sm row no-wrap items-center q-gutter-x-sm">
          <q-avatar square size="40px">
            <img v-if="r.iconUrl" :src="r.iconUrl" :alt="r.name" />
            <q-icon v-else name="inventory_2" />
          </q-avatar>
          <div class="col min-width-0">
            <div class="text-body2 ellipsis">{{ r.name }}</div>
            <div class="text-caption text-ink-faint">
              {{ r.downloads.toLocaleString() }} downloads
            </div>
          </div>
        </q-card>
      </div>
    </div>
  </q-page>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useQuasar } from 'quasar';
import { packsApi, type PackSearchResult } from '@/api/packs';
import { tasksApi } from '@/api/tasks';
import { useServersStore } from '@/stores/servers';
import type { ServerViewModel } from '@/api/servers';

const $q = useQuasar();
const servers = useServersStore();

const query = ref('');
const platform = ref<'modrinth' | 'curseforge'>('modrinth');
const results = ref<PackSearchResult[]>([]);
const busyId = ref<string | null>(null);

const platformOptions = [
  { label: 'Modrinth', value: 'modrinth' },
  { label: 'CurseForge', value: 'curseforge' },
];

const packServers = computed(() => servers.servers.filter((s: ServerViewModel) => s.pack !== null));

async function search() {
  if (!query.value.trim()) return;
  const res = await packsApi.search(query.value.trim(), platform.value);
  results.value = res.results;
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

onMounted(async () => {
  if (!servers.loaded) await servers.fetchServers();
});
</script>

<style scoped>
.min-width-0 {
  min-width: 0;
}
</style>
