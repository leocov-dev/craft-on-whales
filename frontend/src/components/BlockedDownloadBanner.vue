<template>
  <q-banner rounded class="bg-warning text-black q-mb-md">
    <template #avatar>
      <q-icon name="file_download_off" />
    </template>
    <div class="text-weight-medium">{{ title }}</div>
    <div>{{ explanation }}</div>
    <div v-if="blocked.filename" class="text-caption">File: {{ blocked.filename }}</div>
    <div v-if="blocked.verifiable" class="text-caption">
      The upload is checked against {{ sourceLabel }}'s checksum for this file.
    </div>

    <div class="row items-center q-gutter-sm q-mt-sm">
      <q-btn
        outline
        no-caps
        icon-right="open_in_new"
        :label="`Open ${sourceLabel}`"
        :href="blocked.pageUrl"
        target="_blank"
        rel="noopener noreferrer"
      />
      <q-btn
        v-if="externalUrl"
        outline
        no-caps
        icon-right="open_in_new"
        label="Open download site"
        :href="externalUrl"
        target="_blank"
        rel="noopener noreferrer"
      />
    </div>
    <div class="row items-center q-gutter-x-sm q-mt-sm">
      <q-file
        v-model="file"
        dense
        outlined
        clearable
        class="col"
        accept=".jar,.zip"
        label="Then pick the downloaded jar…"
        :disable="uploading"
        @rejected="onRejected"
      >
        <template #prepend><q-icon name="upload_file" /></template>
      </q-file>
      <q-btn
        color="primary"
        label="Upload & install"
        :loading="uploading"
        :disable="!file"
        @click="upload"
      />
    </div>

    <template #action>
      <q-btn flat label="Dismiss" :disable="uploading" @click="emit('dismiss')" />
    </template>
  </q-banner>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { useQuasar } from 'quasar';
import { modsApi, type BlockedDownload, type ContentInstallResult } from '@/api/mods';

/**
 * Add-by-link's fallback when the file can't be downloaded automatically
 * (CurseForge distribution disabled, SpigotMC premium/external, Hangar
 * external): link to where the user can download it, then upload the jar to
 * finish the install. See backend/src/mods/MODS_NOTES.md.
 */
const props = defineProps<{
  serverId: string;
  /** The add-by-link input that was blocked; the backend resolves it again. */
  url: string;
  blocked: BlockedDownload;
}>();

const emit = defineEmits<{
  installed: [result: ContentInstallResult];
  dismiss: [];
}>();

const $q = useQuasar();
const file = ref<File | null>(null);
const uploading = ref(false);

const SOURCE_LABELS: Record<BlockedDownload['source'], string> = {
  curseforge: 'CurseForge',
  hangar: 'Hangar',
  spiget: 'SpigotMC',
};

const sourceLabel = computed(() => SOURCE_LABELS[props.blocked.source]);

const what = computed(() =>
  props.blocked.version ? `${props.blocked.name} ${props.blocked.version}` : props.blocked.name,
);

const title = computed(() => `${what.value} can't be downloaded automatically`);

const explanation = computed(() => {
  switch (props.blocked.reason) {
    case 'distribution-disabled':
      return `Its author doesn't allow other apps to download it. Download it from ${sourceLabel.value} in your browser, then upload the jar here.`;
    case 'premium':
      return `It's a paid ${sourceLabel.value} resource. Buy and download it on ${sourceLabel.value}, then upload the jar here.`;
    case 'external':
      return `It isn't hosted on ${sourceLabel.value}. Download it from the author's download site, then upload the jar here.`;
  }
});

// The backend already drops non-http(s) links; check again before binding an href.
const externalUrl = computed(() =>
  props.blocked.externalUrl && /^https?:\/\//i.test(props.blocked.externalUrl)
    ? props.blocked.externalUrl
    : null,
);

function onRejected() {
  $q.notify({ type: 'negative', message: 'Pick a .jar or .zip file.' });
}

async function upload() {
  if (!file.value) return;
  uploading.value = true;
  try {
    const res = await modsApi.completeManual(props.serverId, props.url, file.value);
    $q.notify({
      type: 'positive',
      message: `Installed ${res.installed.name}${res.verified ? ' (checksum verified)' : ''}.`,
    });
    file.value = null;
    emit('installed', res.installed);
  } catch (err) {
    $q.notify({ type: 'negative', message: err instanceof Error ? err.message : 'Upload failed.' });
  } finally {
    uploading.value = false;
  }
}
</script>
