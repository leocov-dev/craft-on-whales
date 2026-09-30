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

    <BlockedDownloadBanner
      v-if="blockedUpdate"
      :key="rowKey(blockedUpdate.row)"
      :server-id="blockedUpdate.row.serverId"
      :url="blockedUpdate.ref"
      :blocked="blockedUpdate.blocked"
      :replace-content-id="blockedUpdate.row.contentId ?? undefined"
      @installed="onManualUpdated"
      @dismiss="blockedUpdate = null"
    />

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
            <div class="row q-gutter-sm">
              <q-btn
                dense
                outline
                label="Update"
                :loading="busyKey === rowKey(u)"
                @click="apply(u)"
              />
              <q-btn
                dense
                flat
                label="Ignore"
                :loading="busyKey === rowKey(u)"
                @click="ignore(u)"
              />
            </div>
          </q-item-section>
        </q-item>
      </q-list>
    </q-card>

    <q-expansion-item
      v-if="ignored.length"
      class="q-mt-lg"
      icon="visibility_off"
      :label="`Ignored updates (${ignored.length})`"
    >
      <q-card flat bordered>
        <q-list separator>
          <q-item v-for="(u, i) in ignored" :key="i">
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
            <q-item-section side>
              <q-btn
                dense
                outline
                label="Un-ignore"
                :loading="busyKey === rowKey(u)"
                @click="unignore(u)"
              />
            </q-item-section>
          </q-item>
        </q-list>
      </q-card>
    </q-expansion-item>
  </q-page>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useQuasar } from 'quasar';
import { updatesApi, type OutdatedRow } from '@/api/updates';
import { blockedUpdateOf, type BlockedDownload } from '@/api/mods';
import { tasksApi } from '@/api/tasks';
import PageHeader from '@/components/PageHeader.vue';
import BlockedDownloadBanner from '@/components/BlockedDownloadBanner.vue';

const $q = useQuasar();

const updates = ref<OutdatedRow[]>([]);
const ignored = ref<OutdatedRow[]>([]);
const lastChecked = ref<string | null>(null);
const checking = ref(false);
const busyKey = ref<string | null>(null);
/**
 * A mod update the panel can't download itself (CurseForge distribution
 * disabled, Hangar/SpigotMC hosted elsewhere, SpigotMC premium): finished
 * by uploading the jar, which replaces the installed one.
 */
const blockedUpdate = ref<{ row: OutdatedRow; ref: string; blocked: BlockedDownload } | null>(null);

function rowKey(u: OutdatedRow) {
  return `${u.subjectType}:${u.subjectId}`;
}

async function load() {
  const res = await updatesApi.list();
  updates.value = res.updates;
  ignored.value = res.ignored;
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

async function apply(u: OutdatedRow) {
  busyKey.value = rowKey(u);
  blockedUpdate.value = null;
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
    const blocked = blockedUpdateOf(err);
    if (blocked) {
      blockedUpdate.value = { row: u, ...blocked };
      return;
    }
    $q.notify({ type: 'negative', message: err instanceof Error ? err.message : 'Update failed.' });
  } finally {
    busyKey.value = null;
  }
}

async function onManualUpdated() {
  blockedUpdate.value = null;
  await load();
}

async function ignore(u: OutdatedRow) {
  busyKey.value = rowKey(u);
  try {
    await updatesApi.ignore(u.subjectType, u.subjectId);
    $q.notify({ type: 'positive', message: `Ignoring ${u.subject} ${u.latest ?? ''}.` });
    await load();
  } catch (err) {
    $q.notify({ type: 'negative', message: err instanceof Error ? err.message : 'Ignore failed.' });
  } finally {
    busyKey.value = null;
  }
}

async function unignore(u: OutdatedRow) {
  busyKey.value = rowKey(u);
  try {
    await updatesApi.unignore(u.subjectType, u.subjectId);
    $q.notify({ type: 'positive', message: `${u.subject} will show updates again.` });
    await load();
  } catch (err) {
    $q.notify({
      type: 'negative',
      message: err instanceof Error ? err.message : 'Un-ignore failed.',
    });
  } finally {
    busyKey.value = null;
  }
}

onMounted(load);
</script>
