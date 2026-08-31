<template>
  <q-page class="q-pa-md">
    <PageHeader title="Activity" icon="history" />

    <div class="row q-col-gutter-sm items-center q-mb-md">
      <div class="col-12 col-sm-4">
        <q-input
          v-model="q"
          dense
          filled
          placeholder="Search events…"
          clearable
          @keyup.enter="applyFilters"
          @clear="applyFilters"
        />
      </div>
      <div class="col-6 col-sm-3">
        <q-select
          v-model="server"
          dense
          filled
          emit-value
          map-options
          clearable
          :options="serverOptions"
          label="Server"
          @update:model-value="applyFilters"
        />
      </div>
      <div class="col-6 col-sm-3">
        <q-select
          v-model="type"
          dense
          filled
          emit-value
          map-options
          clearable
          :options="typeOptions"
          label="Type"
          @update:model-value="applyFilters"
        />
      </div>
      <div class="col-12 col-sm-2 row justify-end q-gutter-x-xs">
        <q-btn
          flat
          dense
          icon="download"
          :href="eventsApi.exportUrl('csv', activeFilters)"
          label="CSV"
          no-caps
        />
        <q-btn
          flat
          dense
          icon="download"
          :href="eventsApi.exportUrl('json', activeFilters)"
          label="JSON"
          no-caps
        />
      </div>
    </div>

    <q-card flat bordered>
      <q-list separator>
        <q-item v-for="event in events" :key="event.id">
          <q-item-section avatar>
            <q-badge outline color="primary">{{ event.type }}</q-badge>
          </q-item-section>
          <q-item-section>
            {{ event.summary }}
          </q-item-section>
          <q-item-section side>
            <router-link
              v-if="event.serverId"
              :to="`/servers/${event.serverId}`"
              class="text-primary text-caption"
            >
              {{ event.server }}
            </router-link>
            <q-item-label v-else caption>{{ event.server }}</q-item-label>
          </q-item-section>
          <q-item-section side>
            <q-item-label caption>
              {{ event.actor }} · {{ new Date(event.ts).toLocaleString() }}
            </q-item-label>
          </q-item-section>
          <q-item-section v-if="event.hasLog" side>
            <q-btn flat dense round icon="description" @click="viewExcerpt(event.id)">
              <q-tooltip>View captured log excerpt</q-tooltip>
            </q-btn>
          </q-item-section>
        </q-item>
        <q-item v-if="!loading && events.length === 0">
          <q-item-section class="text-center">
            <q-item-label caption>No events match these filters.</q-item-label>
          </q-item-section>
        </q-item>
      </q-list>

      <div v-if="total > 0" class="row items-center justify-between q-pa-sm">
        <q-item-label caption>Showing {{ from }}–{{ to }} of {{ total }} events</q-item-label>
        <div class="row items-center q-gutter-x-sm">
          <q-btn
            flat
            dense
            round
            icon="chevron_left"
            :disable="page <= 1"
            @click="goToPage(page - 1)"
          />
          <q-item-label caption>Page {{ page }} of {{ pages }}</q-item-label>
          <q-btn
            flat
            dense
            round
            icon="chevron_right"
            :disable="page >= pages"
            @click="goToPage(page + 1)"
          />
        </div>
      </div>
    </q-card>

    <q-dialog v-model="excerptOpen">
      <q-card bordered class="shadow-12" style="min-width: 500px; max-width: 90vw">
        <q-card-section class="row items-center">
          <div class="text-subtitle1">Captured log excerpt</div>
          <q-space />
          <q-btn flat dense round icon="close" v-close-popup />
        </q-card-section>
        <q-card-section>
          <pre v-if="excerptText" class="excerpt-pre">{{ excerptText }}</pre>
          <div v-else class="row justify-center q-pa-md"><q-spinner color="primary" /></div>
        </q-card-section>
      </q-card>
    </q-dialog>
  </q-page>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { eventsApi, type EventViewModel, type EventsFilters } from '@/api/events';
import { useServersStore } from '@/stores/servers';
import PageHeader from '@/components/PageHeader.vue';

const servers = useServersStore();

const q = ref('');
const server = ref<string | null>(null);
const type = ref<string | null>(null);
const page = ref(1);

const events = ref<EventViewModel[]>([]);
const types = ref<string[]>([]);
const total = ref(0);
const pages = ref(1);
const perPage = ref(50);
const loading = ref(false);

const excerptOpen = ref(false);
const excerptText = ref('');

const activeFilters = computed<EventsFilters>(() => ({
  ...(q.value ? { q: q.value } : {}),
  ...(server.value ? { server: server.value } : {}),
  ...(type.value ? { type: type.value } : {}),
}));

const serverOptions = computed(() => servers.servers.map((s) => ({ label: s.name, value: s.id })));
const typeOptions = computed(() => types.value.map((t) => ({ label: t, value: t })));

const from = computed(() => (total.value ? (page.value - 1) * perPage.value + 1 : 0));
const to = computed(() => Math.min(page.value * perPage.value, total.value));

async function load() {
  loading.value = true;
  try {
    const res = await eventsApi.list({ ...activeFilters.value, page: page.value });
    events.value = res.events;
    types.value = res.types;
    total.value = res.total;
    pages.value = res.pages;
    perPage.value = res.perPage;
  } finally {
    loading.value = false;
  }
}

function applyFilters() {
  page.value = 1;
  void load();
}

function goToPage(p: number) {
  page.value = p;
  void load();
}

async function viewExcerpt(id: number) {
  excerptOpen.value = true;
  excerptText.value = '';
  const res = await fetch(eventsApi.excerptUrl(id), { credentials: 'include' });
  excerptText.value = res.ok ? await res.text() : 'No captured log for this event.';
}

onMounted(async () => {
  if (!servers.loaded) await servers.fetchServers();
  await load();
});
</script>

<style scoped>
.excerpt-pre {
  white-space: pre-wrap;
  word-break: break-word;
  font-family: var(--font-mono);
  font-size: 12px;
  max-height: 60vh;
  overflow-y: auto;
}
</style>
