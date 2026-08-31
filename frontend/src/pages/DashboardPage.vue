<template>
  <q-page class="q-pa-md">
    <PageHeader title="Dashboard" icon="home">
      <template #action>
        <q-btn-toggle
          v-model="sort"
          dense
          no-caps
          unelevated
          toggle-color="primary"
          color="grey-9"
          padding="xs md"
          :options="sortOptions"
        />
        <q-btn class="q-ml-sm" color="primary" icon="add" label="New server" to="/servers/new" />
      </template>
    </PageHeader>

    <div class="row q-col-gutter-md q-mb-md">
      <div class="col-6 col-sm-3">
        <q-card flat bordered class="q-pa-md text-center">
          <div class="text-h5">{{ store.totals.running }}</div>
          <q-item-label caption>Running</q-item-label>
        </q-card>
      </div>
      <div class="col-6 col-sm-3">
        <q-card flat bordered class="q-pa-md text-center">
          <div class="text-h5">{{ store.totals.total }}</div>
          <q-item-label caption>Servers</q-item-label>
        </q-card>
      </div>
      <div class="col-6 col-sm-3">
        <q-card flat bordered class="q-pa-md text-center">
          <div class="text-h5">{{ store.totals.players }}</div>
          <q-item-label caption>Players online</q-item-label>
        </q-card>
      </div>
      <div class="col-6 col-sm-3">
        <q-card flat bordered class="q-pa-md text-center">
          <div class="text-h5">{{ store.totals.updates }}</div>
          <q-item-label caption>Updates available</q-item-label>
        </q-card>
      </div>
    </div>

    <div v-if="store.loading && !store.loaded" class="row justify-center q-pa-xl">
      <q-spinner color="primary" size="32px" />
    </div>

    <q-banner v-else-if="store.sorted.length === 0" rounded class="q-mb-lg">
      <template #avatar>
        <q-icon name="info" color="primary" />
      </template>
      No servers yet.
      <router-link to="/servers/new" class="text-primary">Create your first one.</router-link>
    </q-banner>

    <div v-else class="row q-col-gutter-md">
      <div v-for="server in store.sorted" :key="server.id" class="col-12 col-sm-6 col-md-4">
        <ServerCard :server="server" />
      </div>
    </div>
  </q-page>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue';
import { useServersStore, type SortKey } from '@/stores/servers';
import ServerCard from '@/components/ServerCard.vue';
import PageHeader from '@/components/PageHeader.vue';

const store = useServersStore();

const sortOptions: { value: SortKey; label: string }[] = [
  { value: 'status', label: 'Status' },
  { value: 'name', label: 'Name' },
  { value: 'size', label: 'Size' },
  { value: 'started', label: 'Started' },
  { value: 'created', label: 'Created' },
];

const sort = ref<SortKey>(store.sort);
watch(sort, (v) => {
  store.sort = v;
});

let pollHandle: ReturnType<typeof setInterval> | undefined;

onMounted(async () => {
  await store.fetchServers();
  pollHandle = setInterval(() => void store.refreshLive(), 5000);
});

onUnmounted(() => {
  if (pollHandle) clearInterval(pollHandle);
});
</script>
