<template>
  <q-page class="q-pa-md">
    <PageHeader
      title="Updates"
      icon="upgrade"
      :subtitle="
        lastChecked ? `Last checked ${new Date(lastChecked).toLocaleString()}` : 'Never checked'
      "
    >
      <template #action>
        <q-btn
          color="primary"
          icon="refresh"
          label="Check all"
          :loading="checking"
          @click="checkAll"
        />
      </template>
    </PageHeader>

    <q-banner v-if="updates.length === 0" rounded class="q-mb-lg">
      <template #avatar>
        <q-icon name="info" color="primary" />
      </template>
      Everything is up to date.
    </q-banner>

    <q-card v-else flat bordered>
      <q-list separator>
        <q-item v-for="(u, i) in updates" :key="i">
          <q-item-section>
            <q-item-label>
              <router-link :to="`/servers/${u.serverId}`" class="text-primary">{{
                u.server
              }}</router-link>
            </q-item-label>
            <q-item-label caption>{{ u.kind }} · {{ u.subject }}</q-item-label>
          </q-item-section>
          <q-item-section side>
            <q-item-label caption>{{ u.current ?? '—' }} → {{ u.latest ?? '—' }}</q-item-label>
          </q-item-section>
          <q-item-section v-if="u.changelog" side>
            <a :href="u.changelog" target="_blank" rel="noopener" class="text-caption text-primary"
              >Changelog</a
            >
          </q-item-section>
          <q-item-section side>
            <q-btn dense outline label="Update" :loading="busyIndex === i" @click="apply(u, i)" />
          </q-item-section>
        </q-item>
      </q-list>
    </q-card>
  </q-page>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useQuasar } from 'quasar';
import { updatesApi, type OutdatedRow } from '@/api/updates';
import { tasksApi } from '@/api/tasks';
import PageHeader from '@/components/PageHeader.vue';

const $q = useQuasar();

const updates = ref<OutdatedRow[]>([]);
const lastChecked = ref<string | null>(null);
const checking = ref(false);
const busyIndex = ref<number | null>(null);

async function load() {
  const res = await updatesApi.list();
  updates.value = res.updates;
  lastChecked.value = res.lastChecked;
}

async function checkAll() {
  checking.value = true;
  try {
    const { taskId } = await updatesApi.checkAll();
    await tasksApi.waitFor(taskId);
    await load();
    $q.notify({ type: 'positive', message: 'Update check complete.' });
  } catch (err) {
    $q.notify({ type: 'negative', message: err instanceof Error ? err.message : 'Check failed.' });
  } finally {
    checking.value = false;
  }
}

async function apply(u: OutdatedRow, index: number) {
  busyIndex.value = index;
  try {
    if (u.kind === 'Modpack') {
      const { taskId } = await updatesApi.upgradePack(u.serverId, u.versionId ?? undefined);
      await tasksApi.waitFor(taskId);
    } else if (u.contentId) {
      await updatesApi.updateMod(u.serverId, u.contentId);
    }
    $q.notify({ type: 'positive', message: `${u.subject} updated.` });
    await load();
  } catch (err) {
    $q.notify({ type: 'negative', message: err instanceof Error ? err.message : 'Update failed.' });
  } finally {
    busyIndex.value = null;
  }
}

onMounted(load);
</script>
