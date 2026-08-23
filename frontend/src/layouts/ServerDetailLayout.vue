<template>
  <q-page class="q-pa-md">
    <div v-if="loading && !server" class="row justify-center q-pa-xl">
      <q-spinner color="primary" size="32px" />
    </div>

    <template v-else-if="server">
      <div class="row items-center q-gutter-x-sm q-mb-md">
        <q-avatar size="40px" square>
          <img :src="iconSrc(server.icon)" :alt="server.name" />
        </q-avatar>
        <div class="col min-width-0">
          <div class="text-h6 ellipsis">{{ server.name }}</div>
          <div class="text-caption" :class="`text-${meta.color}`">{{ meta.label }}</div>
        </div>
        <q-btn
          v-if="server.status === 'stopped' || server.status === 'crashed'"
          color="positive"
          icon="play_arrow"
          label="Start"
          :loading="actionBusy"
          @click="run('start')"
        />
        <template v-else>
          <q-btn
            color="warning"
            outline
            icon="stop"
            label="Stop"
            :loading="actionBusy"
            @click="run('stop')"
          />
          <q-btn flat round icon="refresh" :loading="actionBusy" @click="run('restart')">
            <q-tooltip>Restart</q-tooltip>
          </q-btn>
        </template>
        <q-btn flat round icon="more_vert">
          <q-menu>
            <q-list>
              <q-item clickable v-close-popup @click="run('kill')">
                <q-item-section>Force kill</q-item-section>
              </q-item>
              <q-item clickable v-close-popup @click="run('recreate')">
                <q-item-section>Recreate container</q-item-section>
              </q-item>
              <q-separator />
              <q-item clickable v-close-popup @click="removeServer">
                <q-item-section class="text-negative">Delete server</q-item-section>
              </q-item>
            </q-list>
          </q-menu>
        </q-btn>
      </div>

      <q-tabs
        v-model="activeGroup"
        dense
        no-caps
        align="left"
        class="text-ink-faint q-mb-xs"
        active-color="primary"
        indicator-color="primary"
        @update:model-value="onGroupChange"
      >
        <q-tab v-for="g in TAB_GROUPS" :key="g.key" :name="g.key" :label="g.label" :icon="g.icon" />
      </q-tabs>

      <q-tabs
        v-if="currentGroupTabs.length > 1"
        v-model="activeTab"
        dense
        no-caps
        align="left"
        class="text-ink-faint q-mb-md"
        active-color="primary"
        indicator-color="primary"
        @update:model-value="onTabChange"
      >
        <q-tab v-for="t in currentGroupTabs" :key="t" :name="t" :label="subLabel(t)" />
      </q-tabs>
      <q-separator v-else class="q-mb-md" />

      <router-view />
    </template>

    <div v-else class="text-center text-ink-faint q-pa-xl">Server not found.</div>
  </q-page>
</template>

<script setup lang="ts">
import { ref, computed, watch, provide, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useQuasar } from 'quasar';
import { serversApi, type LifecycleAction, type ServerDetail } from '@/api/servers';
import { statusMeta, iconSrc } from '@/composables/useServerStatus';
import { serverDetailKey } from '@/composables/useServerDetail';
import { useServersStore } from '@/stores/servers';

const route = useRoute();
const router = useRouter();
const $q = useQuasar();
const serversStore = useServersStore();

const server = ref<ServerDetail | null>(null);
const loading = ref(false);
const actionBusy = ref(false);

const TAB_GROUPS = [
  { key: 'overview', label: 'Overview', icon: 'dashboard', tabs: ['overview'] },
  { key: 'console', label: 'Console', icon: 'terminal', tabs: ['console', 'chat'] },
  {
    key: 'players',
    label: 'Players',
    icon: 'group',
    tabs: ['players', 'inventory', 'analytics', 'commands'],
  },
  { key: 'world', label: 'World', icon: 'public', tabs: ['worlds', 'mods', 'map', 'files'] },
  { key: 'backups', label: 'Backups', icon: 'archive', tabs: ['backups'] },
  { key: 'insights', label: 'Insights', icon: 'insights', tabs: ['metrics', 'history'] },
  { key: 'settings', label: 'Settings', icon: 'settings', tabs: ['settings', 'integrations'] },
];
const SUB_LABELS: Record<string, string> = {
  console: 'Console',
  chat: 'Chat',
  players: 'Roster',
  inventory: 'Inventory',
  analytics: 'Analytics',
  commands: 'Commands',
  worlds: 'Worlds',
  mods: 'Mods',
  map: 'Map',
  files: 'Files',
  metrics: 'Metrics',
  history: 'History',
  settings: 'General',
  integrations: 'Integrations',
};
function subLabel(t: string) {
  return SUB_LABELS[t] ?? t;
}

const serverId = computed(() => String(route.params.id));
const activeTab = ref(String(route.params.tab || 'overview'));
const activeGroup = ref(
  TAB_GROUPS.find((g) => g.tabs.includes(activeTab.value))?.key ?? 'overview',
);
const currentGroupTabs = computed(
  () => TAB_GROUPS.find((g) => g.key === activeGroup.value)?.tabs ?? [],
);

function onGroupChange(key: string | number) {
  const group = TAB_GROUPS.find((g) => g.key === key);
  const tab = group?.tabs[0] ?? 'overview';
  activeTab.value = tab;
  void router.push(`/servers/${serverId.value}/${tab}`);
}
function onTabChange(tab: string | number) {
  void router.push(`/servers/${serverId.value}/${String(tab)}`);
}

const meta = computed(() => statusMeta(server.value?.status ?? 'stopped'));

async function refresh() {
  loading.value = true;
  try {
    const res = await serversApi.get(serverId.value);
    server.value = res.server;
  } finally {
    loading.value = false;
  }
}

provide(serverDetailKey, { server, loading, refresh });

async function run(action: LifecycleAction) {
  actionBusy.value = true;
  try {
    await serversApi.action(serverId.value, action);
    await refresh();
  } catch (err) {
    $q.notify({ type: 'negative', message: err instanceof Error ? err.message : 'Action failed.' });
  } finally {
    actionBusy.value = false;
  }
}

function removeServer() {
  if (!server.value) return;
  $q.dialog({
    title: `Delete ${server.value.name}?`,
    message:
      'This permanently deletes the container, its world, mods, and config. Backups are kept.',
    prompt: { model: '', type: 'text', label: `Type "${server.value.name}" to confirm` },
    cancel: true,
    ok: { color: 'negative', label: 'Delete forever' },
  }).onOk((typed: string) => {
    if (typed !== server.value?.name) {
      $q.notify({ type: 'negative', message: 'Name did not match.' });
      return;
    }
    void (async () => {
      await serversApi.remove(serverId.value);
      await serversStore.fetchServers();
      await router.push('/');
    })();
  });
}

watch(
  () => route.params.tab,
  (tab) => {
    const t = String(tab || 'overview');
    activeTab.value = t;
    activeGroup.value = TAB_GROUPS.find((g) => g.tabs.includes(t))?.key ?? 'overview';
  },
);

watch(serverId, refresh);
onMounted(refresh);
</script>

<style scoped>
.min-width-0 {
  min-width: 0;
}
</style>
