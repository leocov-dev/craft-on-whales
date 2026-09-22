<template>
  <q-page class="q-pa-md">
    <PageHeader title="Blueprints" icon="architecture">
      <template #action>
        <q-btn color="primary" icon="upload" label="Import blueprint" @click="pickFile" />
      </template>
    </PageHeader>
    <input
      ref="fileInput"
      type="file"
      accept=".zip,application/zip"
      class="hidden-input"
      @change="onFileChosen"
    />

    <q-banner v-if="blueprints.length === 0" rounded class="q-mb-lg">
      <template #avatar>
        <q-icon name="info" color="primary" />
      </template>
      No blueprints yet. Export one from a server's Settings tab, or import a .mcserver.zip above.
    </q-banner>

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
              <q-item-label caption class="ellipsis-2-lines">{{ bp.notes }}</q-item-label>
            </div>
          </div>

          <div class="row q-col-gutter-sm text-caption q-mt-md border-top q-pt-sm">
            <div class="col-4">
              <q-item-label caption>Pack</q-item-label>
              <div>{{ bp.pack ?? '—' }}</div>
            </div>
            <div class="col-4">
              <q-item-label caption>Overlay mods</q-item-label>
              <div>{{ bp.overlayCount }}</div>
            </div>
            <div class="col-4">
              <q-item-label caption>Size</q-item-label>
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
            <q-btn
              v-if="auth.canWrite"
              flat
              dense
              round
              icon="download"
              :href="blueprintsApi.downloadUrl(bp.id)"
            />
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
      <q-card bordered class="shadow-12" style="min-width: 420px; max-width: 640px; width: 100%">
        <q-card-section class="text-subtitle1">Import blueprint</q-card-section>
        <q-separator />
        <q-scroll-area v-if="preview" style="height: 40vh">
          <q-card-section>
            <div class="text-body2">{{ preview.manifest.identity?.name ?? 'Blueprint' }}</div>
            <q-item-label caption class="q-mb-sm">
              {{ preview.manifest.config.type }} · {{ preview.manifest.config.mcVersion }} ·
              {{ preview.entries.count }} files
            </q-item-label>
            <q-banner
              v-for="(w, i) in preview.warnings"
              :key="i"
              dense
              class="bg-warning text-black q-mb-xs"
            >
              {{ w }}
            </q-banner>
          </q-card-section>
        </q-scroll-area>
        <q-separator />
        <q-card-section>
          <div class="row q-col-gutter-sm q-mt-xs">
            <div class="col-12 col-sm-6">
              <q-input v-model="importForm.name" label="Server name" filled dense />
            </div>
            <div class="col-12 col-sm-6">
              <q-input
                v-model.number="importForm.portGame"
                type="number"
                label="Game port"
                filled
                dense
                :error="Boolean(importPortError)"
                :error-message="importPortError || ''"
                :loading="importPortChecking"
              />
            </div>
          </div>
        </q-card-section>
        <q-separator />
        <q-card-actions align="right">
          <q-btn flat label="Cancel" :disable="importing" @click="cancelPreview" />
          <q-btn
            color="primary"
            label="Import & create server"
            :loading="importing"
            :disable="
              importing ||
              Boolean(importPortError) ||
              !importForm.name.trim() ||
              !importForm.portGame ||
              importPortChecking
            "
            @click="confirmImport"
          />
        </q-card-actions>
      </q-card>
    </q-dialog>

    <q-dialog v-model="createDialogOpen" persistent>
      <q-card bordered class="shadow-12" style="min-width: 360px; max-width: 500px; width: 100%">
        <q-card-section class="text-subtitle1">
          Create server from "{{ selectedBlueprint?.name }}"
        </q-card-section>
        <q-separator />
        <q-card-section class="q-gutter-sm">
          <q-input v-model="createForm.name" label="Server name" filled dense />
          <q-input
            v-model.number="createForm.portGame"
            type="number"
            label="Game port"
            filled
            dense
            :error="Boolean(createPortError)"
            :error-message="createPortError || ''"
            :loading="createPortChecking"
          />
        </q-card-section>
        <q-separator />
        <q-card-actions align="right">
          <q-btn flat label="Cancel" :disable="creating" @click="createDialogOpen = false" />
          <q-btn
            color="primary"
            label="Create server"
            :loading="creating"
            :disable="
              creating ||
              Boolean(createPortError) ||
              !createForm.name.trim() ||
              !createForm.portGame ||
              createPortChecking
            "
            @click="confirmCreateServer"
          />
        </q-card-actions>
      </q-card>
    </q-dialog>
  </q-page>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue';
import { useQuasar } from 'quasar';
import { useRouter } from 'vue-router';
import { blueprintsApi, type BlueprintViewModel, type ImportPreview } from '@/api/blueprints';
import { wizardApi } from '@/api/wizard';
import { formatBytes } from '@/composables/useServerStatus';
import { useServersStore } from '@/stores/servers';
import { useAuthStore } from '@/stores/auth';
import type { ServerViewModel } from '@/api/servers';
import PageHeader from '@/components/PageHeader.vue';

const $q = useQuasar();
const router = useRouter();
const servers = useServersStore();
const auth = useAuthStore();

const blueprints = ref<BlueprintViewModel[]>([]);
const creatingId = ref<string | null>(null);
const fileInput = ref<HTMLInputElement>();

const previewOpen = ref(false);
const preview = ref<ImportPreview | null>(null);
const uploadToken = ref<string | null>(null);
const importing = ref(false);

const importForm = ref({ name: '', portGame: 25565 });
const importPortChecking = ref(false);
const importRemotePortInUse = ref(false);
let importCheckDebounce: ReturnType<typeof setTimeout> | null = null;

const createDialogOpen = ref(false);
const selectedBlueprint = ref<BlueprintViewModel | null>(null);
const creating = ref(false);
const createForm = ref({ name: '', portGame: 25565 });
const createPortChecking = ref(false);
const createRemotePortInUse = ref(false);
let createCheckDebounce: ReturnType<typeof setTimeout> | null = null;

function checkConflict(p: number | null | undefined): string | null {
  if (!p) return 'Game port is required';
  if (!Number.isInteger(p) || p < 1024 || p > 65535) {
    return 'Port must be an integer between 1024 and 65535';
  }
  const conflict = servers.servers.find(
    (s: ServerViewModel) => s.ports?.game === p || s.ports?.rcon === p,
  );
  if (conflict) {
    return `Port ${p} is already in use by server "${conflict.name}".`;
  }
  return null;
}

const importPortError = computed(() => {
  const err = checkConflict(importForm.value.portGame);
  if (err) return err;
  if (importRemotePortInUse.value) {
    return `Port ${importForm.value.portGame} is already in use or unavailable on host.`;
  }
  return null;
});

const createPortError = computed(() => {
  const err = checkConflict(createForm.value.portGame);
  if (err) return err;
  if (createRemotePortInUse.value) {
    return `Port ${createForm.value.portGame} is already in use or unavailable on host.`;
  }
  return null;
});

watch(
  () => importForm.value.portGame,
  (port) => {
    importRemotePortInUse.value = false;
    if (importCheckDebounce) clearTimeout(importCheckDebounce);
    if (!port || !Number.isInteger(port) || port < 1024 || port > 65535) return;
    if (
      servers.servers.some((s: ServerViewModel) => s.ports?.game === port || s.ports?.rcon === port)
    )
      return;
    importPortChecking.value = true;
    importCheckDebounce = setTimeout(() => {
      void (async () => {
        try {
          const res = await wizardApi.checkPort(port);
          if (importForm.value.portGame === port) {
            importRemotePortInUse.value = !res.free;
          }
        } catch {
          // best-effort
        } finally {
          if (importForm.value.portGame === port) {
            importPortChecking.value = false;
          }
        }
      })();
    }, 300);
  },
);

watch(
  () => createForm.value.portGame,
  (port) => {
    createRemotePortInUse.value = false;
    if (createCheckDebounce) clearTimeout(createCheckDebounce);
    if (!port || !Number.isInteger(port) || port < 1024 || port > 65535) return;
    if (
      servers.servers.some((s: ServerViewModel) => s.ports?.game === port || s.ports?.rcon === port)
    )
      return;
    createPortChecking.value = true;
    createCheckDebounce = setTimeout(() => {
      void (async () => {
        try {
          const res = await wizardApi.checkPort(port);
          if (createForm.value.portGame === port) {
            createRemotePortInUse.value = !res.free;
          }
        } catch {
          // best-effort
        } finally {
          if (createForm.value.portGame === port) {
            createPortChecking.value = false;
          }
        }
      })();
    }, 300);
  },
);

async function load() {
  if (!servers.loaded) {
    await servers.fetchServers();
  }
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
    const [res, portsRes] = await Promise.all([
      blueprintsApi.previewUpload(file),
      wizardApi.suggestPorts().catch(() => null),
    ]);
    preview.value = res.preview;
    uploadToken.value = res.uploadToken ?? null;
    importForm.value.name = res.preview.manifest.identity?.name || 'Blueprint';
    if (portsRes?.ports?.game) {
      importForm.value.portGame = portsRes.ports.game;
    }
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
  if (importPortError.value) {
    $q.notify({ type: 'negative', message: importPortError.value });
    return;
  }
  importing.value = true;
  try {
    const res = await blueprintsApi.importWithToken(uploadToken.value, {
      name: importForm.value.name.trim() || undefined,
      portGame: importForm.value.portGame,
    });
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

async function createServer(bp: BlueprintViewModel) {
  selectedBlueprint.value = bp;
  createForm.value.name = bp.name;
  const portsRes = await wizardApi.suggestPorts().catch(() => null);
  if (portsRes?.ports?.game) {
    createForm.value.portGame = portsRes.ports.game;
  }
  createDialogOpen.value = true;
}

async function confirmCreateServer() {
  if (!selectedBlueprint.value) return;
  if (createPortError.value) {
    $q.notify({ type: 'negative', message: createPortError.value });
    return;
  }
  creating.value = true;
  try {
    const res = await blueprintsApi.create(selectedBlueprint.value.id, {
      name: createForm.value.name.trim() || undefined,
      portGame: createForm.value.portGame,
    });
    $q.notify({ type: 'positive', message: `Server "${res.server?.name}" created.` });
    createDialogOpen.value = false;
    await servers.fetchServers();
    await router.push('/');
  } catch (err) {
    $q.notify({
      type: 'negative',
      message: err instanceof Error ? err.message : 'Create failed.',
    });
  } finally {
    creating.value = false;
  }
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
