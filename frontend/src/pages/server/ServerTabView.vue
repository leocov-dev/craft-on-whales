<template>
  <component :is="tabComponent" v-if="tabComponent" />
  <q-banner v-else rounded>
    <template #avatar>
      <q-icon name="info" color="primary" />
    </template>
    This tab hasn't been ported to the new interface yet.
  </q-banner>
</template>

<script setup lang="ts">
import { computed, defineAsyncComponent } from 'vue';
import { useRoute } from 'vue-router';

const route = useRoute();

const TAB_COMPONENTS: Record<string, ReturnType<typeof defineAsyncComponent>> = {
  overview: defineAsyncComponent(() => import('./OverviewTab.vue')),
  settings: defineAsyncComponent(() => import('./SettingsTab.vue')),
  integrations: defineAsyncComponent(() => import('./IntegrationsTab.vue')),
  backups: defineAsyncComponent(() => import('./BackupsTab.vue')),
  history: defineAsyncComponent(() => import('./HistoryTab.vue')),
  console: defineAsyncComponent(() => import('./ConsoleTab.vue')),
  metrics: defineAsyncComponent(() => import('./MetricsTab.vue')),
  mods: defineAsyncComponent(() => import('./ModsTab.vue')),
  map: defineAsyncComponent(() => import('./MapTab.vue')),
  files: defineAsyncComponent(() => import('./FilesTab.vue')),
  worlds: defineAsyncComponent(() => import('./WorldsTab.vue')),
  commands: defineAsyncComponent(() => import('./CommandsTab.vue')),
  chat: defineAsyncComponent(() => import('./ChatTab.vue')),
  players: defineAsyncComponent(() => import('./PlayersTab.vue')),
  analytics: defineAsyncComponent(() => import('./AnalyticsTab.vue')),
  inventory: defineAsyncComponent(() => import('./InventoryTab.vue')),
};

const tabComponent = computed(() => TAB_COMPONENTS[String(route.params.tab || 'overview')]);
</script>
