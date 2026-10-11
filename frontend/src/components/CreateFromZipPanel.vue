<template>
  <div>
    <q-item-label caption class="q-mb-sm">
      A Modrinth pack (<code>.mrpack</code>) or any zip of mod or plugin jars. Every jar is
      identified and installed as tracked content, and the archive's <code>overrides/</code> config
      files are applied so they can be undone later from the server's Mods tab.
    </q-item-label>
    <div class="q-gutter-md" style="max-width: 640px">
      <q-file
        v-model="model.file"
        dense
        filled
        clearable
        accept=".zip,.mrpack"
        label="A .mrpack or a zip of jars…"
        :disable="disable"
        @rejected="onRejected"
      >
        <template #prepend><q-icon name="upload_file" /></template>
      </q-file>
      <div class="row q-col-gutter-sm">
        <div class="col-6">
          <q-select
            v-model="model.loader"
            :options="ZIP_LOADER_OPTIONS"
            emit-value
            map-options
            dense
            filled
            label="Loader"
            :disable="disable"
          />
        </div>
        <div class="col-6">
          <q-select
            v-model="model.mcVersion"
            :options="versionOptions"
            emit-value
            map-options
            use-input
            dense
            filled
            label="Minecraft version"
            :disable="disable"
            @filter="filterVersions"
          />
        </div>
      </div>
      <q-item-label caption>
        Auto-detect reads a .mrpack's own loader and version. For a zip of jars it goes by what most
        of the jars were built for, and asks you to pick when it can't tell.
      </q-item-label>
      <q-toggle v-model="model.applyOverrides" :disable="disable" label="Apply overrides">
        <q-tooltip>
          Copy the archive's overrides/ config files into the new server. They're tracked, so
          removing the import from the Mods tab takes them out again.
        </q-tooltip>
      </q-toggle>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useQuasar } from 'quasar';
import { wizardApi } from '@/api/wizard';
import { ZIP_LOADER_OPTIONS, type ZipSourceModel } from '@/utils/zip-server';

const $q = useQuasar();

/** The upload source only: name, port and resources are the page's shared settings. */
const model = defineModel<ZipSourceModel>({ required: true });
defineProps<{ disable?: boolean | undefined }>();

const AUTO_VERSION = { label: 'Auto-detect', value: '' };
const allVersions = ref<string[]>([]);
const versionOptions = ref<{ label: string; value: string }[]>([AUTO_VERSION]);

function filterVersions(val: string, update: (fn: () => void) => void) {
  update(() => {
    const needle = val.toLowerCase();
    versionOptions.value = [
      AUTO_VERSION,
      ...allVersions.value
        .filter((id) => id.toLowerCase().includes(needle))
        .slice(0, needle ? undefined : 50)
        .map((id) => ({ label: id, value: id })),
    ];
  });
}

function onRejected() {
  $q.notify({ type: 'negative', message: 'Upload a .zip or .mrpack file.' });
}

onMounted(async () => {
  const res = await wizardApi.versions().catch(() => null);
  if (res) {
    allVersions.value = res.versions.map((v) => v.id);
    filterVersions('', (fn) => fn());
  }
});
</script>
