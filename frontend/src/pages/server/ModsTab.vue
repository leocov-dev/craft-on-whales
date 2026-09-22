<template>
  <div>
    <q-banner v-if="isPackwiz" rounded class="q-mb-md">
      <template #avatar>
        <q-icon name="info" color="primary" />
      </template>
      Mods are managed by packwiz and can't be added, removed, or toggled from the panel.
      <div v-if="server?.pack?.ref">
        Edit the pack at
        <a :href="server.pack.ref" target="_blank" rel="noopener" class="text-primary">{{
          server.pack.ref
        }}</a>
        and re-apply the URL to update.
      </div>
    </q-banner>

    <q-banner
      v-if="isPackwiz && server?.updateAvailable"
      rounded
      class="bg-warning text-black q-mb-md"
    >
      <template #avatar>
        <q-icon name="restart_alt" />
      </template>
      The pack changed since this server last started — restart to pick up the new mods.
      <template #action>
        <q-btn flat label="Restart now" :loading="syncing" @click="syncPackwiz" />
      </template>
    </q-banner>

    <q-toggle
      v-if="isPackwiz"
      :model-value="server?.pack?.autoRestartOnPackChange ?? false"
      label="Auto-restart when the pack changes (checked every 5 min)"
      class="q-mb-md"
      @update:model-value="toggleAutoRestart"
    />

    <div v-if="!isPackwiz" class="row items-center q-gutter-x-sm q-mb-md">
      <q-input
        v-model="addUrl"
        dense
        filled
        class="col"
        placeholder="Modrinth/CurseForge URL or slug…"
        @keyup.enter="addMod"
      />
      <q-btn color="primary" label="Add" :loading="adding" @click="addMod" />
    </div>

    <template v-if="isPackwiz">
      <q-item-label v-if="packwizMods.length === 0" caption>
        No mods found in this pack.
      </q-item-label>
      <q-card v-else flat bordered>
        <q-list separator>
          <q-item v-for="m in packwizMods" :key="m.filename ?? m.name">
            <q-item-section avatar>
              <q-icon name="extension" />
            </q-item-section>
            <q-item-section>
              <q-item-label>{{ m.name }}</q-item-label>
              <q-item-label caption>{{ packwizModCaption(m) }}</q-item-label>
            </q-item-section>
          </q-item>
        </q-list>
      </q-card>
    </template>

    <template v-else>
      <div v-if="pending.length" class="q-mb-md">
        <q-banner class="bg-warning text-black">
          This modpack needs {{ pending.length }} file(s) downloaded manually — see the modpack
          platform for links.
        </q-banner>
      </div>

      <q-banner v-if="mods.length === 0" rounded>
        <template #avatar>
          <q-icon name="info" color="primary" />
        </template>
        No mods or plugins installed.
      </q-banner>

      <q-card v-else flat bordered>
        <q-list separator>
          <q-item v-for="m in mods" :key="m.file">
            <q-item-section avatar>
              <q-avatar v-if="m.iconUrl" square size="32px"
                ><img :src="m.iconUrl" :alt="m.name"
              /></q-avatar>
              <q-icon v-else name="extension" />
            </q-item-section>
            <q-item-section>
              <q-item-label>{{ m.name }}</q-item-label>
              <q-item-label caption
                >{{ m.kind }} · {{ m.version ?? '—' }} · {{ formatBytes(m.size) }}</q-item-label
              >
            </q-item-section>
            <q-item-section v-if="m.updateAvailable" side>
              <q-badge color="warning" :label="`update: ${m.updateAvailable}`" />
            </q-item-section>
            <q-item-section side>
              <q-toggle :model-value="m.enabled" @update:model-value="toggle(m)" />
            </q-item-section>
            <q-item-section side>
              <q-btn flat dense round icon="delete" color="negative" @click="removeMod(m)" />
            </q-item-section>
          </q-item>
        </q-list>
      </q-card>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useQuasar } from 'quasar';
import { modsApi, type ContentItem, type PendingDownload } from '@/api/mods';
import { packsApi, type PackModInfo } from '@/api/packs';
import { tasksApi } from '@/api/tasks';
import { formatBytes } from '@/composables/useServerStatus';
import { useServerDetail } from '@/composables/useServerDetail';

const $q = useQuasar();
const { server, refresh } = useServerDetail();

const isPackwiz = computed(() => server.value?.pack?.platform === 'packwiz');

const mods = ref<ContentItem[]>([]);
const pending = ref<PendingDownload[]>([]);
const packwizMods = ref<PackModInfo[]>([]);
const addUrl = ref('');
const adding = ref(false);
const syncing = ref(false);

function packwizModCaption(m: PackModInfo): string {
  return m.side ? (m.side === 'both' ? 'client + server' : m.side) : '—';
}

async function load() {
  if (!server.value) return;
  if (isPackwiz.value) {
    const res = await packsApi.details({ serverId: server.value.id }).catch(() => null);
    packwizMods.value = res?.pack.mods ?? [];
    return;
  }
  const [modsRes, pendingRes] = await Promise.all([
    modsApi.list(server.value.id),
    modsApi.pendingDownloads(server.value.id),
  ]);
  mods.value = modsRes.mods;
  pending.value = pendingRes.mods;
}

async function addMod() {
  if (!server.value || !addUrl.value.trim()) return;
  adding.value = true;
  try {
    await modsApi.addByUrl(server.value.id, addUrl.value.trim());
    addUrl.value = '';
    $q.notify({ type: 'positive', message: 'Added.' });
    await load();
  } catch (err) {
    $q.notify({ type: 'negative', message: err instanceof Error ? err.message : 'Could not add.' });
  } finally {
    adding.value = false;
  }
}

async function toggle(m: ContentItem) {
  if (!server.value) return;
  try {
    const res = await modsApi.toggle(server.value.id, m.file, !m.enabled);
    if (res.applied === 'on-restart')
      $q.notify({ type: 'info', message: 'Takes effect on next restart.' });
    await load();
  } catch (err) {
    $q.notify({ type: 'negative', message: err instanceof Error ? err.message : 'Toggle failed.' });
  }
}

async function syncPackwiz() {
  if (!server.value) return;
  syncing.value = true;
  try {
    const { taskId } = await packsApi.packwizSync(server.value.id);
    const task = await tasksApi.waitFor<{ changed: boolean; hash: string }>(taskId);
    if (task.result?.changed === false) {
      $q.notify({ type: 'info', message: 'Already up to date.' });
    } else {
      $q.notify({ type: 'positive', message: 'Restarted with the updated pack.' });
    }
    await refresh();
  } catch (err) {
    $q.notify({
      type: 'negative',
      message: err instanceof Error ? err.message : 'Restart failed.',
    });
  } finally {
    syncing.value = false;
  }
}

async function toggleAutoRestart(enabled: boolean) {
  if (!server.value) return;
  try {
    await packsApi.setAutoRestart(server.value.id, enabled);
    await refresh();
  } catch (err) {
    $q.notify({
      type: 'negative',
      message: err instanceof Error ? err.message : 'Could not save.',
    });
  }
}

function removeMod(m: ContentItem) {
  if (!server.value) return;
  $q.dialog({
    title: `Remove "${m.name}"?`,
    cancel: true,
    ok: { color: 'negative', label: 'Remove' },
  }).onOk(() => {
    void modsApi
      .remove(server.value!.id, m.file)
      .then(load)
      .catch((err: unknown) => {
        $q.notify({
          type: 'negative',
          message: err instanceof Error ? err.message : 'Remove failed.',
        });
      });
  });
}

onMounted(load);
</script>
