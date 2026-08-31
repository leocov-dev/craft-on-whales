<template>
  <q-page class="q-pa-md">
    <PageHeader title="Worlds" icon="public">
      <template #action>
        <q-btn color="primary" icon="upload" label="Upload world" @click="pickFile" />
      </template>
    </PageHeader>
    <input
      ref="fileInput"
      type="file"
      accept=".zip"
      class="hidden-input"
      @change="onFileChosen"
    />

    <q-banner v-if="worlds.length === 0" rounded class="q-mb-lg">
      <template #avatar>
        <q-icon name="info" color="primary" />
      </template>
      No worlds in the library yet. Upload a .zip, or extract one from a server's World tab.
    </q-banner>

    <q-card v-else flat bordered>
      <q-list separator>
        <q-item v-for="w in worlds" :key="w.id">
          <q-item-section avatar>
            <q-icon name="public" />
          </q-item-section>
          <q-item-section>
            <q-item-label>{{ w.name }}</q-item-label>
            <q-item-label caption
              >{{ w.source }} · {{ w.flavor ?? '—' }} · {{ w.mcVersion ?? '—' }}</q-item-label
            >
          </q-item-section>
          <q-item-section side>
            <q-item-label caption>{{ formatBytes(w.size) }}</q-item-label>
          </q-item-section>
          <q-item-section side>
            <q-item-label caption>{{ w.created }}</q-item-label>
          </q-item-section>
          <q-item-section side>
            <div class="row q-gutter-x-xs">
              <q-btn dense outline label="Install…" @click="openInstall(w)" />
              <q-btn flat dense round icon="download" :href="worldsApi.downloadUrl(w.id)" />
              <q-btn flat dense round icon="edit" @click="renamePrompt(w)" />
              <q-btn flat dense round icon="delete" color="negative" @click="removeWorld(w)" />
            </div>
          </q-item-section>
        </q-item>
      </q-list>
    </q-card>

    <q-dialog v-model="installOpen">
      <q-card style="min-width: 360px">
        <q-card-section class="text-subtitle1">Install "{{ installing?.name }}"</q-card-section>
        <q-card-section class="q-gutter-md">
          <q-select
            v-model="installServerId"
            :options="serverOptions"
            option-label="label"
            option-value="value"
            emit-value
            map-options
            filled
            dense
            label="Target server"
          />
          <q-option-group
            v-model="installMode"
            :options="[
              { label: 'Replace the current world', value: 'replace' },
              { label: 'Install alongside (new folder)', value: 'alongside' },
            ]"
          />
          <q-banner v-if="installWarnings.length" class="bg-warning text-black">
            <div v-for="(w, i) in installWarnings" :key="i">{{ w }}</div>
          </q-banner>
        </q-card-section>
        <q-card-actions align="right">
          <q-btn flat label="Cancel" v-close-popup />
          <q-btn
            color="primary"
            label="Install"
            :loading="installing !== null && installBusy"
            @click="doInstall"
          />
        </q-card-actions>
      </q-card>
    </q-dialog>
  </q-page>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useQuasar } from 'quasar';
import { worldsApi, type LibraryWorld } from '@/api/worlds';
import { formatBytes } from '@/composables/useServerStatus';
import { useServersStore } from '@/stores/servers';
import PageHeader from '@/components/PageHeader.vue';

const $q = useQuasar();
const servers = useServersStore();

const worlds = ref<LibraryWorld[]>([]);
const fileInput = ref<HTMLInputElement>();

const installOpen = ref(false);
const installing = ref<LibraryWorld | null>(null);
const installServerId = ref<string | null>(null);
const installMode = ref<'replace' | 'alongside'>('replace');
const installWarnings = ref<string[]>([]);
const installBusy = ref(false);

const serverOptions = computed(() => servers.servers.map((s) => ({ label: s.name, value: s.id })));

async function load() {
  const res = await worldsApi.list();
  worlds.value = res.worlds;
}

function pickFile() {
  fileInput.value?.click();
}

async function onFileChosen(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  (e.target as HTMLInputElement).value = '';
  try {
    await worldsApi.upload(file);
    $q.notify({ type: 'positive', message: 'World uploaded.' });
    await load();
  } catch (err) {
    $q.notify({ type: 'negative', message: err instanceof Error ? err.message : 'Upload failed.' });
  }
}

function openInstall(w: LibraryWorld) {
  installing.value = w;
  installServerId.value = serverOptions.value[0]?.value ?? null;
  installMode.value = 'replace';
  installWarnings.value = [];
  installOpen.value = true;
}

async function doInstall() {
  if (!installing.value || !installServerId.value) return;
  installBusy.value = true;
  try {
    const res = await worldsApi.install(
      installing.value.id,
      installServerId.value,
      installMode.value,
      installWarnings.value.length > 0,
    );
    if (res.requiresConfirm) {
      installWarnings.value = res.warnings ?? [];
      return;
    }
    $q.notify({ type: 'positive', message: 'World installed.' });
    installOpen.value = false;
  } catch (err) {
    $q.notify({
      type: 'negative',
      message: err instanceof Error ? err.message : 'Install failed.',
    });
  } finally {
    installBusy.value = false;
  }
}

function renamePrompt(w: LibraryWorld) {
  $q.dialog({
    title: 'Rename world',
    prompt: { model: w.name, type: 'text' },
    cancel: true,
  }).onOk((name: string) => {
    void worldsApi.rename(w.id, name).then(load);
  });
}

function removeWorld(w: LibraryWorld) {
  $q.dialog({
    title: `Delete "${w.name}"?`,
    message: 'This permanently removes the world from the library.',
    cancel: true,
    ok: { color: 'negative', label: 'Delete' },
  }).onOk(() => {
    void worldsApi.remove(w.id).then(load);
  });
}

onMounted(async () => {
  if (!servers.loaded) await servers.fetchServers();
  await load();
});
</script>

<style scoped>
.hidden-input {
  display: none;
}
</style>
