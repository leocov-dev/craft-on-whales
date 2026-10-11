<template>
  <q-page class="q-pa-md">
    <PageHeader
      title="Create a server"
      icon="add_circle"
      subtitle="Start from scratch, a modpack, or a saved blueprint."
    />

    <q-card flat bordered>
      <q-tabs
        v-model="tab"
        dense
        align="left"
        active-color="primary"
        indicator-color="primary"
        class="q-px-md"
      >
        <q-tab name="standard" icon="terrain" label="Standard" />
        <q-tab name="modpack" icon="inventory_2" label="Modpack" />
        <q-tab name="blueprint" icon="architecture" label="Blueprint" />
      </q-tabs>
      <q-separator />

      <!-- Panels mount lazily and stay alive so a half-filled form survives a tab switch. -->
      <q-tab-panels v-model="tab" keep-alive class="bg-transparent">
        <q-tab-panel name="standard">
          <NewStandardServerPanel />
        </q-tab-panel>
        <q-tab-panel name="modpack">
          <NewModpackServerPanel />
        </q-tab-panel>
        <q-tab-panel name="blueprint">
          <NewBlueprintServerPanel />
        </q-tab-panel>
      </q-tab-panels>
    </q-card>
  </q-page>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import PageHeader from '@/components/PageHeader.vue';
import NewStandardServerPanel from '@/components/NewStandardServerPanel.vue';
import NewModpackServerPanel from '@/components/NewModpackServerPanel.vue';
import NewBlueprintServerPanel from '@/components/NewBlueprintServerPanel.vue';

const TABS = ['standard', 'modpack', 'blueprint'] as const;
type Tab = (typeof TABS)[number];

const route = useRoute();
const router = useRouter();

// The tab lives in `?tab=` so it is linkable and survives a reload.
const tab = computed<Tab>({
  get: () => TABS.find((t) => t === route.query.tab) ?? 'standard',
  set: (t) => void router.replace({ query: { ...route.query, tab: t } }),
});
</script>
