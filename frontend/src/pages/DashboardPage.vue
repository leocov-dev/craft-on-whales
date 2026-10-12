<template>
  <q-page class="q-pa-md">
    <PageHeader title="Dashboard" icon="home" />

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

    <ResourceOverview />

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
import { onMounted } from 'vue';
import { useServersStore } from '@/stores/servers';
import ServerCard from '@/components/ServerCard.vue';
import PageHeader from '@/components/PageHeader.vue';
import ResourceOverview from '@/components/ResourceOverview.vue';

const store = useServersStore();

// Live updates come from the store's /ws/servers socket (started in MainLayout).
onMounted(() => store.fetchServers());
</script>
