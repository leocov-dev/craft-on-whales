<template>
  <q-page class="q-pa-md">
    <PageHeader title="Storage" icon="storage" />

    <div class="row q-col-gutter-md q-mb-md">
      <div class="col-12 col-lg-8">
        <q-card flat bordered class="q-pa-md">
          <div class="row items-baseline justify-between">
            <div class="text-subtitle1">Disk usage</div>
            <q-item-label caption>
              Last scanned
              {{ storage?.lastScan ? new Date(storage.lastScan).toLocaleString() : 'not yet' }} ·
              <a href="#" class="text-primary" @click.prevent="rescan">re-scan now</a>
            </q-item-label>
          </div>

          <div v-if="storage" class="row items-end q-gutter-x-sm q-mt-sm">
            <div class="text-h4">{{ formatBytes(storage.totalUsed) }}</div>
            <q-item-label caption>
              panel data · {{ formatBytes(storage.diskFree) }} free of
              {{ formatBytes(storage.diskTotal) }} on drive
            </q-item-label>
          </div>
          <q-linear-progress
            v-if="storage"
            :value="pctUsed(storage.totalUsed, storage.diskTotal) / 100"
            :color="meterColor(storage.totalUsed, storage.diskTotal)"
            track-color="grey-9"
            rounded
            size="10px"
            class="q-mt-sm"
          />

          <div
            v-if="storage"
            class="row no-wrap q-mt-md rounded-borders overflow-hidden"
            style="height: 24px"
          >
            <div
              v-for="seg in storage.breakdown"
              :key="seg.label"
              :style="{ width: `${seg.width}%`, backgroundColor: segColor(seg.color) }"
              :title="`${seg.label} — ${formatBytes(seg.size)}`"
            />
          </div>
          <q-item-label v-if="storage" caption class="row q-gutter-x-md q-mt-xs">
            <span v-for="seg in storage.breakdown" :key="seg.label">
              <q-badge :style="{ backgroundColor: segColor(seg.color) }" rounded class="q-mr-xs" />
              {{ seg.label }} · {{ formatBytes(seg.size) }}
            </span>
          </q-item-label>
        </q-card>
      </div>

      <div class="col-12 col-lg-4">
        <q-card flat bordered class="q-pa-md">
          <div class="text-subtitle1 q-mb-sm">Growth trend</div>
          <div
            v-if="storage?.trend.length"
            class="row items-end q-gutter-x-xs"
            style="height: 96px"
          >
            <div
              v-for="(v, i) in storage.trend"
              :key="i"
              class="col bg-info"
              style="border-radius: 2px 2px 0 0"
              :style="{ height: `${v}%` }"
            />
          </div>
          <q-banner v-else rounded>
            <template #avatar>
              <q-icon name="info" color="primary" />
            </template>
            No scans recorded yet.
          </q-banner>
        </q-card>
      </div>
    </div>

    <div class="row q-col-gutter-md">
      <div class="col-12 col-md-6">
        <q-card flat bordered>
          <q-card-section class="text-subtitle1">By category</q-card-section>
          <q-list separator>
            <q-item v-for="cat in storage?.categories ?? []" :key="cat.path">
              <q-item-section>
                <q-item-label>{{ cat.name }}</q-item-label>
                <q-item-label caption class="font-mono">{{ cat.path }}</q-item-label>
              </q-item-section>
              <q-item-section side style="min-width: 100px">{{
                formatBytes(cat.size)
              }}</q-item-section>
              <q-item-section side>
                <q-btn flat dense round icon="folder_open" :to="cat.link" />
              </q-item-section>
            </q-item>
          </q-list>
        </q-card>
      </div>

      <div class="col-12 col-md-6">
        <q-card flat bordered class="q-mb-md">
          <q-card-section class="text-subtitle1">One-click cleanup</q-card-section>
          <q-list separator>
            <q-item v-for="c in storage?.cleanup ?? []" :key="c.key">
              <q-item-section>
                {{ c.action }}
                <span v-if="c.count" class="q-item__label q-item__label--caption text-caption"
                  >({{ c.count }} items)</span
                >
              </q-item-section>
              <q-item-section side class="text-positive text-caption"
                >frees {{ formatBytes(c.frees) }}</q-item-section
              >
              <q-item-section side>
                <q-btn
                  dense
                  outline
                  label="Preview…"
                  :loading="cleaningKey === c.key"
                  @click="previewCleanup(c)"
                />
              </q-item-section>
            </q-item>
          </q-list>
        </q-card>

        <q-card flat bordered>
          <q-card-section class="text-subtitle1">Quota status — all instances</q-card-section>
          <q-list separator>
            <q-item v-for="s in servers.servers" :key="s.id">
              <q-item-section>
                <router-link :to="`/servers/${s.id}`" class="text-primary">{{
                  s.name
                }}</router-link>
              </q-item-section>
              <q-item-section style="max-width: 160px">
                <q-linear-progress
                  :value="pctUsed(s.disk.used, s.disk.quota) / 100"
                  :color="meterColor(s.disk.used, s.disk.quota)"
                  track-color="grey-9"
                  rounded
                  size="6px"
                />
              </q-item-section>
              <q-item-section side>
                <q-item-label caption>
                  {{ formatBytes(s.disk.used) }} / {{ formatBytes(s.disk.quota) }}
                </q-item-label>
              </q-item-section>
            </q-item>
            <q-item v-if="servers.servers.length === 0">
              <q-item-section class="text-center">
                <q-item-label caption>No servers yet.</q-item-label>
              </q-item-section>
            </q-item>
          </q-list>
        </q-card>
      </div>
    </div>

    <q-card flat bordered class="q-mt-md">
      <q-card-section class="text-subtitle1">Largest files</q-card-section>
      <q-list v-if="storage?.largestFiles.length" separator>
        <q-item v-for="f in storage.largestFiles" :key="f.path">
          <q-item-section class="font-mono text-caption">{{ f.path }}</q-item-section>
          <q-item-section side>{{ formatBytes(f.size) }}</q-item-section>
          <q-item-section side>
            <q-btn flat dense round icon="folder_open" :to="f.link" />
          </q-item-section>
        </q-item>
      </q-list>
      <q-banner v-else rounded class="q-ma-md">
        <template #avatar>
          <q-icon name="info" color="primary" />
        </template>
        Run a re-scan above to index the largest files under ./data.
      </q-banner>
    </q-card>
  </q-page>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useQuasar } from 'quasar';
import {
  storageApi,
  type StorageData,
  type CleanupPreview,
  type CleanupAction,
} from '@/api/storage';
import { useServersStore } from '@/stores/servers';
import { formatBytes, pctUsed, meterColor } from '@/composables/useServerStatus';
import PageHeader from '@/components/PageHeader.vue';

const $q = useQuasar();
const servers = useServersStore();

const storage = ref<StorageData | null>(null);
const cleaningKey = ref<CleanupAction | null>(null);

// Quasar exposes brand colors as --q-<name> CSS custom properties, but 'grey'
// isn't a themeable brand color, so it has no CSS var — resolve it directly
// (stone-500 from the design tokens) rather than emitting an unset var().
function segColor(color: string): string {
  return color === 'grey' ? 'var(--color-stone-500)' : `var(--q-${color})`;
}

async function load() {
  const res = await storageApi.get();
  storage.value = res.storage;
}

async function rescan() {
  await storageApi.scan();
  $q.notify({ type: 'positive', message: 'Storage re-scanned.' });
  await load();
}

async function previewCleanup(c: CleanupPreview) {
  cleaningKey.value = c.key;
  try {
    const preview = await storageApi.cleanup(c.key, c.days ?? undefined, true);
    if (!preview.removed) {
      $q.notify({ type: 'info', message: 'Nothing to clean up for this action right now.' });
      return;
    }
    $q.dialog({
      title: c.action,
      message: `This permanently removes ${preview.removed} item${preview.removed === 1 ? '' : 's'} and frees ${formatBytes(preview.freedBytes)}.`,
      cancel: true,
      ok: { color: 'negative', label: `Free ${formatBytes(preview.freedBytes)}` },
    }).onOk(() => {
      void runCleanup(c);
    });
  } finally {
    cleaningKey.value = null;
  }
}

async function runCleanup(c: CleanupPreview) {
  cleaningKey.value = c.key;
  try {
    const result = await storageApi.cleanup(c.key, c.days ?? undefined, false);
    $q.notify({
      type: 'positive',
      message: `Cleanup done: ${result.removed} item${result.removed === 1 ? '' : 's'} removed, ${formatBytes(result.freedBytes)} freed.`,
    });
    await load();
  } finally {
    cleaningKey.value = null;
  }
}

onMounted(async () => {
  if (!servers.loaded) await servers.fetchServers();
  await load();
});
</script>
