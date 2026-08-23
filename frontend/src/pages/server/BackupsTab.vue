<template>
  <div>
    <div class="row items-center q-mb-md">
      <q-btn
        color="primary"
        icon="add"
        label="Create backup"
        :loading="creating"
        @click="createBackup"
      />
    </div>

    <div v-if="backups.length === 0" class="text-center text-ink-faint q-pa-xl">
      No backups yet.
    </div>

    <q-card v-else flat bordered>
      <q-list separator>
        <q-item v-for="b in backups" :key="b.id">
          <q-item-section class="font-mono">{{ b.file }}</q-item-section>
          <q-item-section side class="text-caption">{{ b.reason }}</q-item-section>
          <q-item-section side class="text-caption text-ink-faint">{{
            formatBytes(b.size)
          }}</q-item-section>
          <q-item-section side class="text-caption text-ink-faint">{{
            new Date(b.ts).toLocaleString()
          }}</q-item-section>
          <q-item-section side>
            <div class="row q-gutter-x-xs">
              <q-btn dense outline label="Restore" :loading="busyId === b.id" @click="restore(b)" />
              <q-btn flat dense round icon="download" :href="backupsApi.downloadUrl(b.id)" />
              <q-btn flat dense round icon="delete" color="negative" @click="removeBackup(b)" />
            </div>
          </q-item-section>
        </q-item>
      </q-list>
    </q-card>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, watch } from 'vue';
import { useQuasar } from 'quasar';
import { backupsApi, type ServerBackupRow } from '@/api/backups';
import { tasksApi } from '@/api/tasks';
import { useServerDetail } from '@/composables/useServerDetail';
import { formatBytes } from '@/composables/useServerStatus';

const $q = useQuasar();
const { server } = useServerDetail();

const backups = ref<ServerBackupRow[]>([]);
const creating = ref(false);
const busyId = ref<string | null>(null);

async function load() {
  if (!server.value) return;
  const res = await backupsApi.listForServer(server.value.id);
  backups.value = res.backups;
}

async function createBackup() {
  if (!server.value) return;
  creating.value = true;
  try {
    const { taskId } = await backupsApi.create(server.value.id);
    await tasksApi.waitFor(taskId);
    $q.notify({ type: 'positive', message: 'Backup created.' });
    await load();
  } catch (err) {
    $q.notify({ type: 'negative', message: err instanceof Error ? err.message : 'Backup failed.' });
  } finally {
    creating.value = false;
  }
}

function restore(b: ServerBackupRow) {
  if (!server.value) return;
  $q.dialog({
    title: `Restore "${b.file}"?`,
    message:
      'This stops the server, replaces its current world/config with this backup, and restarts it.',
    cancel: true,
    ok: { color: 'negative', label: 'Restore' },
  }).onOk(() => {
    void (async () => {
      busyId.value = b.id;
      try {
        const { taskId } = await backupsApi.restore(server.value!.id, b.id);
        await tasksApi.waitFor(taskId);
        $q.notify({ type: 'positive', message: 'Backup restored.' });
      } catch (err) {
        $q.notify({
          type: 'negative',
          message: err instanceof Error ? err.message : 'Restore failed.',
        });
      } finally {
        busyId.value = null;
      }
    })();
  });
}

function removeBackup(b: ServerBackupRow) {
  $q.dialog({
    title: `Delete "${b.file}"?`,
    cancel: true,
    ok: { color: 'negative', label: 'Delete' },
  }).onOk(() => {
    void backupsApi.remove(b.id).then(load);
  });
}

watch(() => server.value?.id, load);
onMounted(load);
</script>
