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

    <q-card flat bordered class="q-pa-md">
      <div class="text-subtitle1">New modpack server</div>
      <NewModpackServerPanel />
    </q-card>

    <PackDetailsDialog v-model="detailsOpen" :server-id="detailsServerId ?? undefined" />
  </q-page>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useQuasar } from 'quasar';
import { packsApi } from '@/api/packs';
import { tasksApi } from '@/api/tasks';
import { useServersStore } from '@/stores/servers';
import type { ServerViewModel } from '@/api/servers';
import PackDetailsDialog from '@/components/PackDetailsDialog.vue';
import PageHeader from '@/components/PageHeader.vue';
import NewModpackServerPanel from '@/components/NewModpackServerPanel.vue';

const $q = useQuasar();
const servers = useServersStore();

const busyId = ref<string | null>(null);

const detailsOpen = ref(false);
const detailsServerId = ref<string | null>(null);

const packServers = computed(() => servers.servers.filter((s: ServerViewModel) => s.pack !== null));

async function upgrade(s: ServerViewModel) {
  busyId.value = s.id;
  try {
    const { taskId } = await packsApi.upgrade(s.id, s.pack?.latestVersionId ?? undefined);
    await tasksApi.waitFor(taskId);
    $q.notify({
      type: 'positive',
      message: `${s.name} upgraded.`,
    });
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

function viewInstalledMods(serverId: string) {
  detailsServerId.value = serverId;
  detailsOpen.value = true;
}

onMounted(async () => {
  if (!servers.loaded) await servers.fetchServers();
});
</script>
