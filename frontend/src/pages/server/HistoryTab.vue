<template>
  <div class="row q-col-gutter-md">
    <div class="col-12 col-lg-6">
      <div class="text-subtitle1 q-mb-sm">Crash reports</div>
      <div v-if="crashes.length === 0" class="text-ink-faint text-caption q-pa-md">
        No crash reports.
      </div>
      <q-card v-else flat bordered>
        <q-list separator>
          <q-item v-for="c in crashes" :key="c.id" clickable @click="viewCrash(c)">
            <q-item-section avatar>
              <q-icon name="warning" :color="c.viewed ? 'grey' : 'negative'" />
            </q-item-section>
            <q-item-section>
              <q-item-label>{{ c.summary || c.exception }}</q-item-label>
              <q-item-label caption
                >{{ new Date(c.file_mtime).toLocaleString() }} ·
                {{ formatBytes(c.size_bytes) }}</q-item-label
              >
            </q-item-section>
            <q-item-section side>
              <q-btn flat dense round icon="delete" color="negative" @click.stop="removeCrash(c)" />
            </q-item-section>
          </q-item>
        </q-list>
      </q-card>
    </div>

    <div class="col-12 col-lg-6">
      <div class="text-subtitle1 q-mb-sm">Event history</div>
      <div v-if="events.length === 0" class="text-ink-faint text-caption q-pa-md">
        No events yet.
      </div>
      <q-card v-else flat bordered>
        <q-list separator>
          <q-item v-for="e in events" :key="e.id">
            <q-item-section avatar>
              <q-badge outline color="primary">{{ e.type }}</q-badge>
            </q-item-section>
            <q-item-section>{{ e.summary }}</q-item-section>
            <q-item-section side class="text-caption text-ink-faint">{{
              new Date(e.ts).toLocaleString()
            }}</q-item-section>
          </q-item>
        </q-list>
      </q-card>
    </div>

    <q-dialog v-model="crashDialogOpen">
      <q-card style="min-width: 600px; max-width: 90vw">
        <q-card-section class="row items-center">
          <div class="text-subtitle1">{{ activeCrash?.filename }}</div>
          <q-space />
          <q-btn flat dense round icon="close" v-close-popup />
        </q-card-section>
        <q-card-section>
          <pre class="crash-pre">{{ crashText }}</pre>
        </q-card-section>
      </q-card>
    </q-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, watch } from 'vue';
import { useQuasar } from 'quasar';
import { crashesApi, type CrashReport } from '@/api/crashes';
import { eventsApi, type EventViewModel } from '@/api/events';
import { formatBytes } from '@/composables/useServerStatus';
import { useServerDetail } from '@/composables/useServerDetail';

const $q = useQuasar();
const { server } = useServerDetail();

const crashes = ref<CrashReport[]>([]);
const events = ref<EventViewModel[]>([]);
const crashDialogOpen = ref(false);
const activeCrash = ref<CrashReport | null>(null);
const crashText = ref('');

async function load() {
  if (!server.value) return;
  const [crashesRes, eventsRes] = await Promise.all([
    crashesApi.list(server.value.id),
    eventsApi.list({ server: server.value.id }),
  ]);
  crashes.value = crashesRes.crashes;
  events.value = eventsRes.events;
}

async function viewCrash(c: CrashReport) {
  if (!server.value) return;
  activeCrash.value = c;
  crashDialogOpen.value = true;
  const res = await fetch(crashesApi.textUrl(server.value.id, c.id), { credentials: 'include' });
  crashText.value = res.ok ? await res.text() : 'Could not load crash text.';
  if (!c.viewed) {
    await crashesApi.markViewed(server.value.id, c.id);
    c.viewed = 1;
  }
}

function removeCrash(c: CrashReport) {
  if (!server.value) return;
  $q.dialog({
    title: 'Delete crash report?',
    cancel: true,
    ok: { color: 'negative', label: 'Delete' },
  }).onOk(() => {
    void crashesApi.remove(server.value!.id, c.id).then(load);
  });
}

watch(() => server.value?.id, load);
onMounted(load);
</script>

<style scoped>
.crash-pre {
  white-space: pre-wrap;
  word-break: break-word;
  font-family: var(--font-mono);
  font-size: 12px;
  max-height: 60vh;
  overflow-y: auto;
}
</style>
