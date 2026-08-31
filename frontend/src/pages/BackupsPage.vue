<template>
  <q-page class="q-pa-md">
    <PageHeader
      title="Backups"
      icon="archive"
      :subtitle="`${totals.count} backups · ${formatBytes(totals.bytes)} total`"
    />

    <q-banner v-if="backups.length === 0" rounded class="q-mb-lg">
      <template #avatar>
        <q-icon name="info" color="primary" />
      </template>
      No backups yet. Create one from a server's Backups tab.
    </q-banner>

    <q-card v-else flat bordered>
      <q-list separator>
        <q-item v-for="b in backups" :key="b.id">
          <q-item-section>
            <q-item-label>
              <router-link :to="`/servers/${b.serverId}`" class="text-primary">{{
                b.server
              }}</router-link>
            </q-item-label>
            <q-item-label caption class="font-mono">{{ b.file }}</q-item-label>
          </q-item-section>
          <q-item-section side class="text-caption">{{ b.reason }}</q-item-section>
          <q-item-section side>
            <q-item-label caption>{{ formatBytes(b.size) }}</q-item-label>
          </q-item-section>
          <q-item-section side>
            <q-item-label caption>{{ new Date(b.ts).toLocaleString() }}</q-item-label>
          </q-item-section>
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
  </q-page>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useQuasar } from 'quasar';
import { backupsApi, type BackupRow } from '@/api/backups';
import { tasksApi } from '@/api/tasks';
import { formatBytes } from '@/composables/useServerStatus';
import PageHeader from '@/components/PageHeader.vue';

const $q = useQuasar();

const backups = ref<BackupRow[]>([]);
const totals = ref({ count: 0, bytes: 0 });
const busyId = ref<string | null>(null);

async function load() {
  const res = await backupsApi.list();
  backups.value = res.backups;
  totals.value = res.totals;
}

function restore(b: BackupRow) {
  $q.dialog({
    title: `Restore "${b.file}"?`,
    message: `This stops ${b.server}, replaces its current world/config with this backup, and restarts it.`,
    cancel: true,
    ok: { color: 'negative', label: 'Restore' },
  }).onOk(() => {
    void (async () => {
      busyId.value = b.id;
      try {
        const { taskId } = await backupsApi.restore(b.serverId, b.id);
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

function removeBackup(b: BackupRow) {
  $q.dialog({
    title: `Delete "${b.file}"?`,
    message: 'This permanently removes the backup archive.',
    cancel: true,
    ok: { color: 'negative', label: 'Delete' },
  }).onOk(() => {
    void backupsApi.remove(b.id).then(load);
  });
}

onMounted(load);
</script>
