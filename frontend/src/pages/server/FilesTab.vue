<template>
  <div>
    <div class="row items-center q-mb-md">
      <q-btn flat dense icon="create_new_folder" label="New folder" @click="createFolder" />
      <q-btn color="primary" icon="upload" label="Upload" @click="pickFiles" class="q-ml-sm" />
      <input ref="fileInput" type="file" multiple class="hidden-input" @change="onFilesChosen" />
    </div>

    <div class="row items-center q-gutter-x-xs q-mb-sm text-caption">
      <a href="#" class="text-primary" @click.prevent="navigate('')">server</a>
      <template v-for="(seg, i) in breadcrumbs" :key="i">
        <q-item-label caption>/</q-item-label>
        <a href="#" class="text-primary" @click.prevent="navigate(breadcrumbPath(i))">{{ seg }}</a>
      </template>
    </div>

    <q-card flat bordered>
      <q-list separator>
        <q-item v-if="currentPath" clickable @click="navigateUp">
          <q-item-section avatar><q-icon name="drive_file_move" /></q-item-section>
          <q-item-section>..</q-item-section>
        </q-item>
        <q-item v-for="entry in entries" :key="entry.path" clickable @click="onEntryClick(entry)">
          <q-item-section avatar>
            <q-icon
              :name="entry.dir ? 'folder' : 'description'"
              :color="entry.dir ? 'primary' : undefined"
            />
          </q-item-section>
          <q-item-section>{{ entry.name }}</q-item-section>
          <q-item-section side>
            <q-item-label caption>{{ entry.dir ? '' : formatBytes(entry.size) }}</q-item-label>
          </q-item-section>
          <q-item-section side>
            <q-item-label caption>{{ entry.mtime }}</q-item-label>
          </q-item-section>
          <q-item-section side>
            <div class="row q-gutter-x-xs">
              <q-btn
                v-if="!entry.dir"
                flat
                dense
                round
                icon="download"
                :href="filesApi.downloadUrl(entry.path)"
                @click.stop
              />
              <q-btn flat dense round icon="edit" @click.stop="renamePrompt(entry)" />
              <q-btn
                flat
                dense
                round
                icon="delete"
                color="negative"
                @click.stop="removeEntry(entry)"
              />
            </div>
          </q-item-section>
        </q-item>
        <q-item v-if="entries.length === 0">
          <q-item-section class="text-center">
            <q-item-label caption>Empty directory.</q-item-label>
          </q-item-section>
        </q-item>
      </q-list>
    </q-card>

    <q-dialog v-model="editorOpen">
      <q-card bordered class="shadow-12" style="min-width: 600px; max-width: 90vw">
        <q-card-section class="row items-center">
          <div class="text-subtitle1 font-mono">{{ editorPath }}</div>
          <q-space />
          <q-btn flat dense round icon="close" v-close-popup />
        </q-card-section>
        <q-separator />
        <q-scroll-area style="height: 60vh">
          <q-card-section>
            <q-input
              v-model="editorContent"
              type="textarea"
              filled
              autogrow
              input-class="font-mono"
              :rows="20"
            />
          </q-card-section>
        </q-scroll-area>
        <q-separator />
        <q-card-actions align="right">
          <q-btn flat label="Cancel" v-close-popup />
          <q-btn color="primary" label="Save" :loading="saving" @click="saveFile" />
        </q-card-actions>
      </q-card>
    </q-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useQuasar } from 'quasar';
import { serverFilesApi, type FileEntry } from '@/api/files';
import { formatBytes } from '@/composables/useServerStatus';
import { useServerDetail } from '@/composables/useServerDetail';

const $q = useQuasar();
const { server } = useServerDetail();
const filesApi = serverFilesApi(server.value!.id);

const currentPath = ref('');
const entries = ref<FileEntry[]>([]);
const fileInput = ref<HTMLElement>();

const editorOpen = ref(false);
const editorPath = ref('');
const editorContent = ref('');
const saving = ref(false);

const breadcrumbs = computed(() => (currentPath.value ? currentPath.value.split('/') : []));
function breadcrumbPath(i: number) {
  return breadcrumbs.value.slice(0, i + 1).join('/');
}

async function load() {
  try {
    const res = await filesApi.list(currentPath.value);
    entries.value = res.entries;
  } catch (err) {
    entries.value = [];
    $q.notify({
      type: 'negative',
      message: err instanceof Error ? err.message : 'Could not list this folder.',
    });
  }
}

function navigate(path: string) {
  currentPath.value = path;
  void load();
}

function navigateUp() {
  const parts = currentPath.value.split('/');
  parts.pop();
  navigate(parts.join('/'));
}

async function onEntryClick(entry: FileEntry) {
  if (entry.dir) {
    navigate(entry.path);
    return;
  }
  if (entry.size > 2 * 1024 * 1024) {
    $q.notify({ type: 'info', message: 'File is too large to preview — use download instead.' });
    return;
  }
  try {
    const res = await filesApi.read(entry.path);
    editorPath.value = entry.path;
    editorContent.value = res.content;
    editorOpen.value = true;
  } catch (err) {
    $q.notify({
      type: 'negative',
      message: err instanceof Error ? err.message : 'Could not open file.',
    });
  }
}

async function saveFile() {
  saving.value = true;
  try {
    await filesApi.write(editorPath.value, editorContent.value);
    $q.notify({ type: 'positive', message: 'Saved.' });
    editorOpen.value = false;
    await load();
  } catch (err) {
    $q.notify({ type: 'negative', message: err instanceof Error ? err.message : 'Save failed.' });
  } finally {
    saving.value = false;
  }
}

function createFolder() {
  $q.dialog({
    title: 'New folder',
    prompt: { model: '', type: 'text' },
    cancel: true,
  }).onOk((name: string) => {
    if (!name.trim()) return;
    const path = currentPath.value ? `${currentPath.value}/${name.trim()}` : name.trim();
    void filesApi
      .mkdir(path)
      .then(load)
      .catch((err: unknown) => {
        $q.notify({
          type: 'negative',
          message: err instanceof Error ? err.message : 'Could not create folder.',
        });
      });
  });
}

function renamePrompt(entry: FileEntry) {
  $q.dialog({
    title: `Rename "${entry.name}"`,
    prompt: { model: entry.name, type: 'text' },
    cancel: true,
  }).onOk((newName: string) => {
    void filesApi
      .rename(entry.path, newName)
      .then(load)
      .catch((err: unknown) => {
        $q.notify({
          type: 'negative',
          message: err instanceof Error ? err.message : 'Rename failed.',
        });
      });
  });
}

function removeEntry(entry: FileEntry) {
  $q.dialog({
    title: `Delete "${entry.name}"?`,
    message: entry.dir
      ? 'This permanently removes the folder and everything inside it.'
      : 'This permanently removes the file.',
    cancel: true,
    ok: { color: 'negative', label: 'Delete' },
  }).onOk(() => {
    void filesApi.remove(entry.path).then(load);
  });
}

function pickFiles() {
  fileInput.value?.click();
}

async function onFilesChosen(e: Event) {
  const files = Array.from((e.target as HTMLInputElement).files ?? []);
  (e.target as HTMLInputElement).value = '';
  if (!files.length) return;
  try {
    await filesApi.upload(currentPath.value, files);
    $q.notify({ type: 'positive', message: `${files.length} file(s) uploaded.` });
    await load();
  } catch (err) {
    $q.notify({ type: 'negative', message: err instanceof Error ? err.message : 'Upload failed.' });
  }
}

onMounted(load);
</script>

<style scoped>
.hidden-input {
  display: none;
}
</style>
