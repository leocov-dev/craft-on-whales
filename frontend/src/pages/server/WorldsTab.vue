<template>
  <div>
    <q-banner v-if="worlds.length === 0" rounded>
      <template #avatar>
        <q-icon name="info" color="primary" />
      </template>
      No worlds found.
    </q-banner>

    <q-card v-else flat bordered>
      <q-list separator>
        <q-item v-for="w in worlds" :key="w.name">
          <q-item-section avatar>
            <q-icon name="public" :color="w.active ? 'positive' : undefined" />
          </q-item-section>
          <q-item-section>
            <q-item-label
              >{{ w.name }}
              <q-badge v-if="w.active" color="positive" label="active" class="q-ml-xs"
            /></q-item-label>
            <q-item-label caption
              >{{ w.dims.join(', ') || '—' }} · seed {{ w.seed ?? '—' }}</q-item-label
            >
          </q-item-section>
          <q-item-section side>
            <q-item-label caption>{{ formatBytes(w.sizeBytes) }}</q-item-label>
          </q-item-section>
          <q-item-section side>
            <div class="row q-gutter-x-xs">
              <q-btn v-if="!w.active" dense outline label="Activate" @click="activate(w)" />
              <q-btn flat dense round icon="content_copy" @click="duplicate(w)">
                <q-tooltip>Duplicate</q-tooltip>
              </q-btn>
              <q-btn flat dense round icon="edit" @click="renamePrompt(w)" />
              <q-btn
                flat
                dense
                round
                icon="download"
                :href="serverWorldsApi.downloadUrl(server!.id, w.name)"
              />
              <q-btn
                v-if="!w.active"
                flat
                dense
                round
                icon="delete"
                color="negative"
                @click="removeWorld(w)"
              />
            </div>
          </q-item-section>
        </q-item>
      </q-list>
    </q-card>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useQuasar } from 'quasar';
import { serverWorldsApi, type ServerWorldSummary } from '@/api/serverWorlds';
import { formatBytes } from '@/composables/useServerStatus';
import { useServerDetail } from '@/composables/useServerDetail';

const $q = useQuasar();
const { server } = useServerDetail();

const worlds = ref<ServerWorldSummary[]>([]);

async function load() {
  if (!server.value) return;
  const res = await serverWorldsApi.list(server.value.id);
  worlds.value = res.worlds;
}

async function activate(w: ServerWorldSummary) {
  if (!server.value) return;
  try {
    await serverWorldsApi.activate(server.value.id, w.name);
    $q.notify({ type: 'positive', message: `Activated "${w.name}".` });
    await load();
  } catch (err) {
    $q.notify({
      type: 'negative',
      message: err instanceof Error ? err.message : 'Could not activate (server must be stopped).',
    });
  }
}

async function duplicate(w: ServerWorldSummary) {
  if (!server.value) return;
  try {
    await serverWorldsApi.duplicate(server.value.id, w.name);
    $q.notify({ type: 'positive', message: 'Duplicated.' });
    await load();
  } catch (err) {
    $q.notify({
      type: 'negative',
      message: err instanceof Error ? err.message : 'Duplicate failed.',
    });
  }
}

function renamePrompt(w: ServerWorldSummary) {
  if (!server.value) return;
  $q.dialog({
    title: `Rename "${w.name}"`,
    prompt: { model: w.name, type: 'text' },
    cancel: true,
  }).onOk((newName: string) => {
    void serverWorldsApi
      .rename(server.value!.id, w.name, newName)
      .then(load)
      .catch((err: unknown) => {
        $q.notify({
          type: 'negative',
          message: err instanceof Error ? err.message : 'Rename failed (server must be stopped).',
        });
      });
  });
}

function removeWorld(w: ServerWorldSummary) {
  if (!server.value) return;
  $q.dialog({
    title: `Delete "${w.name}"?`,
    message: 'This permanently removes the world.',
    cancel: true,
    ok: { color: 'negative', label: 'Delete' },
  }).onOk(() => {
    void serverWorldsApi.remove(server.value!.id, w.name).then(load);
  });
}

onMounted(load);
</script>
