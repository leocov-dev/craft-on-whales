<template>
  <q-page class="q-pa-md">
    <div class="row items-center q-mb-md">
      <div class="text-h6">Blueprints</div>
      <q-space />
      <q-btn color="primary" icon="upload" label="Import blueprint" @click="pickFile" />
      <input
        ref="fileInput"
        type="file"
        accept=".zip,application/zip"
        class="hidden-input"
        @change="onFileChosen"
      />
    </div>

    <div v-if="blueprints.length === 0" class="text-center text-ink-faint q-pa-xl">
      No blueprints yet. Export one from a server's Settings tab, or import a .mcserver.zip above.
    </div>

    <div v-else class="row q-col-gutter-md">
      <div v-for="bp in blueprints" :key="bp.id" class="col-12 col-md-6 col-xl-4">
        <q-card flat bordered class="q-pa-md full-height column">
          <div class="row no-wrap items-start q-gutter-x-sm">
            <q-icon name="architecture" size="32px" color="grey-6" />
            <div class="col min-width-0">
              <div class="row items-center q-gutter-x-xs">
                <div class="text-subtitle2 ellipsis">{{ bp.name }}</div>
                <q-badge v-if="bp.builtin" color="info" label="starter" />
              </div>
              <div class="text-caption text-ink-faint ellipsis-2-lines">{{ bp.notes }}</div>
            </div>
          </div>

          <div class="row q-col-gutter-sm text-caption q-mt-md border-top q-pt-sm">
            <div class="col-4">
              <div class="text-ink-faint">Pack</div>
              <div>{{ bp.pack ?? '—' }}</div>
            </div>
            <div class="col-4">
              <div class="text-ink-faint">Overlay mods</div>
              <div>{{ bp.overlayCount }}</div>
            </div>
            <div class="col-4">
              <div class="text-ink-faint">Size</div>
              <div>{{ formatBytes(bp.size_bytes) }}</div>
            </div>
          </div>

          <q-space />
          <div class="row q-gutter-x-xs q-mt-md">
            <q-btn
              color="primary"
              outline
              label="Create server"
              icon="terrain"
              class="col"
              :loading="creatingId === bp.id"
              @click="createServer(bp)"
            />
            <q-btn flat dense round icon="download" :href="blueprintsApi.downloadUrl(bp.id)" />
            <q-btn
              v-if="!bp.builtin"
              flat
              dense
              round
              icon="delete"
              color="negative"
              @click="removeBlueprint(bp)"
            />
          </div>
        </q-card>
      </div>
    </div>

    <q-dialog v-model="previewOpen" persistent>
      <q-card style="min-width: 420px">
        <q-card-section class="text-subtitle1">Import blueprint</q-card-section>
        <q-card-section v-if="preview">
          <div class="text-body2">{{ preview.manifest.identity?.name ?? 'Blueprint' }}</div>
          <div class="text-caption text-ink-faint q-mb-sm">
            {{ preview.manifest.config.type }} · {{ preview.manifest.config.mcVersion }} ·
            {{ preview.entries.count }} files
          </div>
          <q-banner
            v-for="(w, i) in preview.warnings"
            :key="i"
            dense
            class="bg-warning text-black q-mb-xs"
          >
            {{ w }}
          </q-banner>
        </q-card-section>
        <q-card-actions align="right">
          <q-btn flat label="Cancel" :disable="importing" @click="cancelPreview" />
          <q-btn
            color="primary"
            label="Import & create server"
            :loading="importing"
            @click="confirmImport"
          />
        </q-card-actions>
      </q-card>
    </q-dialog>
  </q-page>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useQuasar } from 'quasar';
import { useRouter } from 'vue-router';
import { blueprintsApi, type BlueprintViewModel, type ImportPreview } from '@/api/blueprints';
import { formatBytes } from '@/composables/useServerStatus';
import { useServersStore } from '@/stores/servers';

const $q = useQuasar();
const router = useRouter();
const servers = useServersStore();

const blueprints = ref<BlueprintViewModel[]>([]);
const creatingId = ref<string | null>(null);
const fileInput = ref<HTMLInputElement>();

const previewOpen = ref(false);
const preview = ref<ImportPreview | null>(null);
const uploadToken = ref<string | null>(null);
const importing = ref(false);

async function load() {
  const res = await blueprintsApi.list();
  blueprints.value = res.blueprints;
}

function pickFile() {
  fileInput.value?.click();
}

async function onFileChosen(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  (e.target as HTMLInputElement).value = '';
  try {
    const res = await blueprintsApi.previewUpload(file);
    preview.value = res.preview;
    uploadToken.value = res.uploadToken ?? null;
    previewOpen.value = true;
  } catch (err) {
    $q.notify({
      type: 'negative',
      message: err instanceof Error ? err.message : 'Preview failed.',
    });
  }
}

function cancelPreview() {
  previewOpen.value = false;
  preview.value = null;
  uploadToken.value = null;
}

async function confirmImport() {
  if (!uploadToken.value) return;
  importing.value = true;
  try {
    const res = await blueprintsApi.importWithToken(uploadToken.value);
    $q.notify({ type: 'positive', message: `Server "${res.server?.name}" created.` });
    previewOpen.value = false;
    await servers.fetchServers();
    await router.push('/');
  } catch (err) {
    $q.notify({ type: 'negative', message: err instanceof Error ? err.message : 'Import failed.' });
  } finally {
    importing.value = false;
  }
}

function createServer(bp: BlueprintViewModel) {
  $q.dialog({
    title: `Create server from "${bp.name}"?`,
    message: 'This pulls the image and installs the pack and mods — it can take a few minutes.',
    cancel: true,
    ok: { label: 'Create' },
  }).onOk(() => {
    void (async () => {
      creatingId.value = bp.id;
      try {
        const res = await blueprintsApi.create(bp.id);
        $q.notify({ type: 'positive', message: `Server "${res.server?.name}" created.` });
        await servers.fetchServers();
        await router.push('/');
      } catch (err) {
        $q.notify({
          type: 'negative',
          message: err instanceof Error ? err.message : 'Create failed.',
        });
      } finally {
        creatingId.value = null;
      }
    })();
  });
}

function removeBlueprint(bp: BlueprintViewModel) {
  $q.dialog({
    title: `Delete blueprint "${bp.name}"?`,
    message:
      'Removes the .mcserver.zip from the library. Servers already created from it are not affected.',
    cancel: true,
    ok: { color: 'negative', label: 'Delete' },
  }).onOk(() => {
    void blueprintsApi.remove(bp.id).then(load);
  });
}

onMounted(load);
</script>

<style scoped>
.hidden-input {
  display: none;
}
.min-width-0 {
  min-width: 0;
}
.ellipsis-2-lines {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.border-top {
  border-top: 1px solid var(--color-line);
}
</style>
