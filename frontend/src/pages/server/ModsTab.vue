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
        placeholder="Modrinth, CurseForge, Hangar, SpigotMC or GitHub link, owner/repo, or slug…"
        @keyup.enter="addMod"
      />
      <q-btn color="primary" label="Add" :loading="adding" @click="addMod" />
    </div>

    <div v-if="!isPackwiz" class="row items-center q-gutter-x-sm q-mb-md">
      <q-file
        v-model="importFile"
        dense
        filled
        clearable
        class="col"
        accept=".zip,.mrpack"
        label="Import a .mrpack or a zip of jars…"
        :disable="importing"
      >
        <template #prepend><q-icon name="upload_file" /></template>
      </q-file>
      <q-toggle v-model="applyOverrides" :disable="importing" label="Apply overrides">
        <q-tooltip>
          Copy the archive's overrides/ config files into the server. Replaced files are backed up
          so removing the import can restore them.
        </q-tooltip>
      </q-toggle>
      <q-btn
        color="primary"
        label="Import"
        :loading="importing"
        :disable="!importFile"
        @click="importPack"
      />
      <q-btn flat icon="history" label="Imports" @click="importsOpen = true">
        <q-badge v-if="imports.length" color="primary" floating>{{ imports.length }}</q-badge>
      </q-btn>
    </div>

    <div v-if="importing" class="q-mb-md">
      <q-linear-progress
        :value="(importProgress ?? 0) / 100"
        :indeterminate="importProgress === null"
        color="primary"
      />
      <q-item-label caption class="q-mt-xs">{{ importStep }}</q-item-label>
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
          <template v-for="g in modGroups" :key="g.importId ?? '_'">
            <q-item-label v-if="g.label" header class="row items-center q-gutter-x-sm">
              <q-icon name="inventory_2" />
              <span>{{ g.label }}</span>
            </q-item-label>
            <q-item v-for="m in g.mods" :key="m.file">
              <q-item-section avatar>
                <q-avatar v-if="m.iconUrl" square size="32px"
                  ><img :src="m.iconUrl" :alt="m.name"
                /></q-avatar>
                <q-icon v-else name="extension" />
              </q-item-section>
              <q-item-section>
                <q-item-label
                  >{{ m.name }}
                  <q-badge
                    v-if="m.importId"
                    outline
                    color="primary"
                    class="q-ml-xs"
                    :label="importNames.get(m.importId) ?? 'imported'"
                /></q-item-label>
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
          </template>
        </q-list>
      </q-card>
    </template>

    <ModImportReportDialog v-model="reportOpen" :report="importReport" />
    <ModImportsDialog
      v-if="server"
      v-model="importsOpen"
      :server-id="server.id"
      :imports="imports"
      @removed="load"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useQuasar } from 'quasar';
import {
  modsApi,
  type ContentItem,
  type PendingDownload,
  type ContentImportSummary,
  type ContentImportReport,
} from '@/api/mods';
import { packsApi, type PackModInfo } from '@/api/packs';
import { tasksApi } from '@/api/tasks';
import { ApiError } from '@/api/http';
import { formatBytes } from '@/composables/useServerStatus';
import { useServerDetail } from '@/composables/useServerDetail';
import ModImportReportDialog from '@/components/ModImportReportDialog.vue';
import ModImportsDialog from '@/components/ModImportsDialog.vue';

const $q = useQuasar();
const { server, refresh } = useServerDetail();

const isPackwiz = computed(() => server.value?.pack?.platform === 'packwiz');

const mods = ref<ContentItem[]>([]);
const pending = ref<PendingDownload[]>([]);
const packwizMods = ref<PackModInfo[]>([]);
const addUrl = ref('');
const adding = ref(false);
const syncing = ref(false);

const imports = ref<ContentImportSummary[]>([]);
const importFile = ref<File | null>(null);
const applyOverrides = ref(true);
const importing = ref(false);
const importStep = ref('');
const importProgress = ref<number | null>(null);
const importReport = ref<ContentImportReport | null>(null);
const reportOpen = ref(false);
const importsOpen = ref(false);

const importNames = computed(
  () =>
    new Map(
      imports.value.map((i) => [i.id, i.version ? `${i.name} ${i.version}` : i.name] as const),
    ),
);

/**
 * Individually-added content first (no header), then one group per import, newest import
 * first. With no imported rows this is a single headerless group, i.e. the plain list.
 */
const modGroups = computed(() => {
  const loose = mods.value.filter((m) => !m.importId);
  const byImport = new Map<string, ContentItem[]>();
  for (const m of mods.value) {
    if (!m.importId) continue;
    const list = byImport.get(m.importId) ?? [];
    list.push(m);
    byImport.set(m.importId, list);
  }
  const order = imports.value.map((i) => i.id);
  const ids = [...byImport.keys()].sort((a, b) => {
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    return (ia === -1 ? Infinity : ia) - (ib === -1 ? Infinity : ib);
  });
  return [
    ...(loose.length ? [{ importId: null, label: null, mods: loose }] : []),
    ...ids.map((id) => ({
      importId: id,
      label: `From ${importNames.value.get(id) ?? 'an imported pack'}`,
      mods: byImport.get(id)!,
    })),
  ];
});

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
  const [modsRes, pendingRes, importsRes] = await Promise.all([
    modsApi.list(server.value.id),
    modsApi.pendingDownloads(server.value.id),
    modsApi.listImports(server.value.id),
  ]);
  mods.value = modsRes.mods;
  pending.value = pendingRes.mods;
  imports.value = importsRes.imports;
}

async function importPack() {
  if (!server.value || !importFile.value) return;
  importing.value = true;
  importStep.value = 'Uploading…';
  importProgress.value = null;
  try {
    const { taskId } = await modsApi.importPack(
      server.value.id,
      importFile.value,
      applyOverrides.value,
    );
    const task = await tasksApi.waitFor<ContentImportReport>(taskId, {
      onProgress: (t) => {
        importStep.value = t.step;
        importProgress.value = t.percent;
      },
    });
    importFile.value = null;
    importReport.value = task.result;
    reportOpen.value = true;
    await load();
  } catch (err) {
    $q.notify({
      type: 'negative',
      message: err instanceof Error ? err.message : 'Import failed.',
    });
  } finally {
    importing.value = false;
  }
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
    // A 409 means "can't be fetched automatically" (premium/off-site/
    // download-disallowed) and names where to get the jar — keep that
    // message up until dismissed so the link can be copied.
    const manual = err instanceof ApiError && err.status === 409;
    $q.notify({
      type: 'negative',
      message: err instanceof Error ? err.message : 'Could not add.',
      ...(manual ? { timeout: 0, actions: [{ label: 'Dismiss', color: 'white' }] } : {}),
    });
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
