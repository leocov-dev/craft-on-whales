<template>
  <q-page class="q-pa-md">
    <PageHeader title="Servers" icon="dns">
      <template #action>
        <q-btn color="primary" icon="add" label="New server" to="/servers/new" />
      </template>
    </PageHeader>

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

const store = useServersStore();

onMounted(async () => {
  if (!store.loaded) await store.fetchServers();
});
</script>
