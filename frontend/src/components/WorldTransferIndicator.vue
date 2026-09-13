<template>
  <div v-if="uploadStore.phase !== 'idle'" class="q-px-md q-pt-md">
    <q-banner rounded bordered :class="bannerClass">
      <template #avatar>
        <q-spinner v-if="uploadStore.phase === 'processing'" color="primary" size="2em" />
        <q-icon v-else :name="statusIcon" :color="statusColor" size="2em" />
      </template>

      <div class="row items-center justify-between no-wrap">
        <div class="ellipsis q-mr-md">
          <div class="text-weight-bold row items-center q-gutter-x-sm">
            <span>{{ phaseTitle }}</span>
            <span v-if="uploadStore.filename" class="text-weight-regular text-caption text-grey-7">
              ({{ uploadStore.filename }})
            </span>
          </div>
          <div class="text-caption">
            {{ statusDetail }}
          </div>
        </div>

        <q-btn
          v-if="uploadStore.isSettled"
          flat
          dense
          round
          icon="close"
          aria-label="Dismiss"
          @click="uploadStore.dismiss()"
        />
      </div>

      <q-linear-progress
        :value="progressValue"
        :indeterminate="uploadStore.phase === 'processing'"
        :color="statusColor"
        class="q-mt-sm"
        rounded
        size="6px"
      />
    </q-banner>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useWorldUploadStore } from '@/stores/world-upload';
import { formatBytes } from '@/composables/useServerStatus';

const uploadStore = useWorldUploadStore();

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m === 0) return `${s}s`;
  return `${m}m ${s}s`;
}

const statusColor = computed(() => {
  switch (uploadStore.phase) {
    case 'uploading':
      return 'primary';
    case 'processing':
      return 'primary';
    case 'succeeded':
      return 'positive';
    case 'failed':
      return 'negative';
    default:
      return 'grey';
  }
});

const statusIcon = computed(() => {
  switch (uploadStore.phase) {
    case 'uploading':
      return 'cloud_upload';
    case 'succeeded':
      return 'check_circle';
    case 'failed':
      return 'error';
    default:
      return 'info';
  }
});

const bannerClass = computed(() => {
  switch (uploadStore.phase) {
    case 'succeeded':
      return 'bg-positive-1';
    case 'failed':
      return 'bg-negative-1';
    default:
      return '';
  }
});

const phaseTitle = computed(() => {
  switch (uploadStore.phase) {
    case 'uploading':
      return 'Uploading world';
    case 'processing':
      return 'Processing world';
    case 'succeeded':
      return 'World uploaded';
    case 'failed':
      return 'Upload failed';
    default:
      return '';
  }
});

const statusDetail = computed(() => {
  const elapsed = formatDuration(uploadStore.elapsedSeconds);
  switch (uploadStore.phase) {
    case 'uploading': {
      const uploaded = formatBytes(uploadStore.uploadedBytes);
      const total = formatBytes(uploadStore.totalBytes);
      const pct = uploadStore.progressPct;
      return `${uploaded} / ${total} (${pct}%) · Elapsed: ${elapsed}`;
    }
    case 'processing':
      return `Importing archive on server… · Elapsed: ${elapsed}`;
    case 'succeeded':
      return `Successfully imported in ${elapsed}.`;
    case 'failed':
      return uploadStore.error || 'An error occurred during upload.';
    default:
      return '';
  }
});

const progressValue = computed(() => {
  if (uploadStore.phase === 'uploading') {
    return uploadStore.progressRatio;
  }
  if (uploadStore.phase === 'succeeded' || uploadStore.phase === 'failed') {
    return 1;
  }
  return 0;
});
</script>
