<template>
  <div>
    <div class="row items-center q-gutter-x-sm q-mb-md">
      <q-input
        v-model="addUrl"
        dense
        outlined
        class="col"
        placeholder="Modrinth/CurseForge URL or slug…"
        @keyup.enter="addMod"
      />
      <q-btn color="primary" label="Add" :loading="adding" @click="addMod" />
    </div>

    <div v-if="pending.length" class="q-mb-md">
      <q-banner class="bg-warning text-black">
        This modpack needs {{ pending.length }} file(s) downloaded manually — see the modpack
        platform for links.
      </q-banner>
    </div>

    <div v-if="mods.length === 0" class="text-center text-ink-faint q-pa-xl">
      No mods or plugins installed.
    </div>

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
            <q-toggle
              :model-value="m.enabled"
              :disable="server?.type === 'PACKWIZ' && m.source === 'pack'"
              @update:model-value="toggle(m)"
            />
          </q-item-section>
          <q-item-section side>
            <q-btn flat dense round icon="delete" color="negative" @click="removeMod(m)" />
          </q-item-section>
        </q-item>
      </q-list>
    </q-card>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useQuasar } from 'quasar';
import { modsApi, type ContentItem, type PendingDownload } from '@/api/mods';
import { formatBytes } from '@/composables/useServerStatus';
import { useServerDetail } from '@/composables/useServerDetail';

const $q = useQuasar();
const { server } = useServerDetail();

const mods = ref<ContentItem[]>([]);
const pending = ref<PendingDownload[]>([]);
const addUrl = ref('');
const adding = ref(false);

async function load() {
  if (!server.value) return;
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
