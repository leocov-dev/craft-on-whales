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
            <div class="text-body2 text-ink-faint">{{ page.motd }}</div>
            <div class="row q-col-gutter-md q-mt-sm text-body2">
              <div class="col-6">
                <div class="text-caption text-ink-faint">Version</div>
                <div>{{ page.mcVersion }}</div>
              </div>
              <div class="col-6">
                <div class="text-caption text-ink-faint">Players</div>
                <div>{{ page.online }}/{{ page.max }}</div>
              </div>
            </div>
          </q-card-section>
        </q-card>
        <div v-else class="text-center text-ink-faint">
          <div class="text-h6">Not found</div>
          <div class="text-caption">This status page doesn't exist or was disabled.</div>
        </div>
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
