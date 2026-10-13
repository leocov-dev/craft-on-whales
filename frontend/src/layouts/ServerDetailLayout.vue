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
          :disable="!!operation"
          @click="run('start')"
        />
        <template v-else>
          <q-btn
            color="warning"
            outline
            icon="stop"
            label="Stop"
            :loading="actionBusy"
            :disable="!!operation"
            @click="run('stop')"
          />
          <q-btn
            flat
            round
            icon="refresh"
            :loading="actionBusy"
            :disable="!!operation"
            @click="run('restart')"
          >
            <q-tooltip>Restart</q-tooltip>
          </q-btn>
        </template>
        <q-btn flat round icon="more_vert" :disable="!!operation">
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

      <q-banner v-if="operation" dense rounded class="bg-info text-dark q-mb-md">
        <div class="text-weight-medium">
          {{ operationLabel(operation.kind) }} — {{ operation.step }}
        </div>
        <div class="text-caption">The server is locked until this finishes.</div>
        <q-linear-progress
          class="q-mt-xs"
          :indeterminate="operation.percent === null"
          :value="(operation.percent ?? 0) / 100"
          color="dark"
          rounded
          size="6px"
        />
      </q-banner>

      <q-banner v-if="server.pendingRecreate" dense rounded class="bg-warning text-dark q-mb-md">
        Configuration changes are waiting to be applied. They take effect when the server
        {{ stopped ? 'is started' : 'is restarted' }}.
        <template #action>
          <q-btn
            flat
            no-caps
            :label="stopped ? 'Start now' : 'Restart now'"
            :loading="actionBusy"
            :disable="!!operation"
            @click="run(stopped ? 'start' : 'restart')"
          />
        </template>
      </q-banner>

      <q-tabs
        v-model="activeGroup"
        dense
        no-caps
        align="left"
        class="q-mb-xs"
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
        class="q-mb-md"
        active-color="primary"
        indicator-color="primary"
        @update:model-value="onTabChange"
      >
        <q-tab v-for="t in currentGroupTabs" :key="t" :name="t" :label="subLabel(t)" />
      </q-tabs>
      <q-separator v-else class="q-mb-md" />

      <!-- inert: no clicks/focus into the tab while a restore/install holds the server -->
      <div :inert="!!operation" :style="operation ? 'opacity: 0.5' : undefined">
        <router-view />
      </div>
    </template>

    <q-banner v-else rounded>
      <template #avatar>
        <q-icon name="info" color="primary" />
      </template>
      Server not found.
    </q-banner>
  </q-page>
</template>

<script setup lang="ts">
import { ref, computed, watch, provide, onMounted, onUnmounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useQuasar } from 'quasar';
import { serversApi, type LifecycleAction, type ServerDetail } from '@/api/servers';
import { statusMeta, iconSrc, operationLabel } from '@/composables/useServerStatus';
import { serverDetailKey } from '@/composables/useServerDetail';
import { useStatusSocket } from '@/composables/useStatusSocket';
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
  {
    key: 'world',
    label: 'World',
    icon: 'public',
    tabs: ['worlds', 'world-controls', 'mods', 'map', 'files'],
  },
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
  'world-controls': 'World Controls',
  mods: 'Mods',
  map: 'Map',
  files: 'Files',
  metrics: 'Live',
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
const operation = computed(() => server.value?.operation ?? null);

// Never rejects: every caller (mount, a lifecycle action, a live status push)
// fires this without awaiting the failure path, and an expired session or a
// server deleted by another user would otherwise surface as an unhandled
// rejection instead of a message.
async function refresh() {
  loading.value = true;
  try {
    const res = await serversApi.get(serverId.value);
    server.value = res.server;
  } catch (err) {
    $q.notify({
      type: 'negative',
      message: err instanceof Error ? err.message : 'Could not load this server.',
    });
  } finally {
    loading.value = false;
  }
}

const statusVersion = ref(0);
const containerVersion = ref(0);
provide(serverDetailKey, {
  server,
  loading,
  operation,
  refresh,
  statusVersion,
  containerVersion,
});

// Kept open for the whole page (not per-tab) so a status change is caught no
// matter which tab is active — e.g. another user/tab restarting the server,
// a crash, or the startup watchdog's stalled/running promotion. Triggers an
// HTTP refetch (for the header/status chip and anything status-gated, like
// MetricsTab's v-if) and bumps statusVersion so tabs with their own
// long-lived socket (ConsoleTab) know to reconnect and re-tail.
let statusSocket: ReturnType<typeof useStatusSocket> | null = null;
let stopStatusWatch: (() => void) | null = null;
function openStatusSocket() {
  statusSocket?.close();
  stopStatusWatch?.();
  const sock = useStatusSocket(serverId.value);
  statusSocket = sock;
  // Watch the socket's own counters, not `status`: a repeated value (restart
  // while already `starting` pushes `starting` again) is a real change, and a
  // watcher on the value would drop it.
  const stopStatus = watch(sock.version, () => {
    statusVersion.value += 1;
    void refresh();
  });
  const stopContainer = watch(sock.containerVersion, () => {
    containerVersion.value += 1;
  });
  // Operation pushes carry the whole state, so apply them in place; the end
  // (null) also refetches since the restore/install changed what's on disk.
  const stopOperation = watch(sock.operation, (op) => {
    if (op === undefined) return;
    if (server.value) server.value.operation = op;
    if (op === null) {
      statusVersion.value += 1;
      void refresh();
    }
  });
  stopStatusWatch = () => {
    stopStatus();
    stopContainer();
    stopOperation();
  };
}
watch(serverId, openStatusSocket);
onMounted(openStatusSocket);
onUnmounted(() => {
  statusSocket?.close();
  stopStatusWatch?.();
});

const stopped = computed(
  () => server.value?.status === 'stopped' || server.value?.status === 'crashed',
);

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
