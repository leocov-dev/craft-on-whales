<template>
  <q-layout view="lHh Lpr lFf">
    <q-page-container>
      <q-page class="flex flex-center q-pa-md">
        <q-card
          v-if="page"
          flat
          bordered
          style="width: 100%; max-width: 420px"
          :style="{ borderTop: `3px solid ${page.accent}` }"
        >
          <q-card-section class="row items-center q-gutter-x-sm">
            <img :src="iconSrc(page.icon)" :alt="page.name" width="40" height="40" />
            <div>
              <div class="text-h6">{{ page.name }}</div>
              <div class="text-caption" :class="`text-${meta.color}`">{{ meta.label }}</div>
            </div>
          </q-card-section>
          <q-card-section>
            <q-item-label caption>{{ page.motd }}</q-item-label>
            <div class="row q-col-gutter-md q-mt-sm text-body2">
              <div class="col-6">
                <q-item-label caption>Version</q-item-label>
                <div>{{ page.mcVersion }}</div>
              </div>
              <div class="col-6">
                <q-item-label caption>Players</q-item-label>
                <div>{{ page.online }}/{{ page.max }}</div>
              </div>
            </div>
          </q-card-section>
        </q-card>
        <q-banner v-else rounded>
          <template #avatar>
            <q-icon name="info" color="primary" />
          </template>
          <div class="text-h6">Not found</div>
          <div class="text-caption">This status page doesn't exist or was disabled.</div>
        </q-banner>
      </q-page>
    </q-page-container>
  </q-layout>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import { statusApi, type StatusPageData } from '@/api/status';
import { statusMeta, iconSrc } from '@/composables/useServerStatus';

const route = useRoute();
const page = ref<StatusPageData | null>(null);
const meta = ref(statusMeta('stopped'));

onMounted(async () => {
  try {
    const res = await statusApi.get(String(route.params.slug));
    page.value = res.page;
    meta.value = statusMeta(res.page.status);
  } catch {
    page.value = null;
  }
});
</script>
