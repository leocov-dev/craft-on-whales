<template>
  <q-dialog
    :model-value="modelValue"
    :persistent="creating"
    @update:model-value="(v) => emit('update:modelValue', v)"
  >
    <q-card bordered class="shadow-12" style="min-width: 420px; max-width: 900px; width: 100%">
      <q-card-section class="row no-wrap items-start q-gutter-x-sm">
        <q-avatar v-if="preview.iconUrl" square size="40px"
          ><img :src="preview.iconUrl" :alt="preview.name"
        /></q-avatar>
        <q-icon v-else name="inventory_2" size="40px" />
        <div class="col min-width-0">
          <div class="text-subtitle1 ellipsis">{{ preview.name }}</div>
          <q-item-label caption>{{ preview.caption }}</q-item-label>
        </div>
      </q-card-section>

      <q-separator />

      <q-card-section class="q-py-sm">
        <div class="text-subtitle2">Server</div>
        <q-item-label caption>
          {{ settings.name }} · port {{ settings.portGame ?? 'auto' }} ·
          {{ settings.diskQuotaGb }} GB disk · {{ settings.heapMb }} MB heap /
          {{ settings.containerMemoryMb }} MB container
        </q-item-label>
      </q-card-section>

      <q-banner v-for="w in preview.warnings" :key="w" dense class="bg-warning text-dark">
        {{ w }}
      </q-banner>

      <q-separator />

      <q-card-section v-if="preview.description" class="text-body2 scroll" style="max-height: 25vh">
        <div v-html="preview.description" />
      </q-card-section>
      <q-separator v-if="preview.description" />

      <q-card-section class="q-pb-none">
        <div class="text-subtitle2">
          {{ preview.itemsLabel }}{{ preview.items.length ? ` (${preview.items.length})` : '' }}
        </div>
      </q-card-section>
      <q-card-section class="q-pt-sm">
        <q-item-label v-if="preview.items.length === 0" caption>
          Listed once the server downloads the pack on first boot.
        </q-item-label>
        <q-virtual-scroll
          v-else
          :items="preview.items"
          separator
          style="max-height: 35vh"
          v-slot="{ item, index }"
        >
          <q-item :key="index" dense>
            <q-item-section avatar><q-icon name="extension" /></q-item-section>
            <q-item-section>
              <q-item-label>{{ item.name }}</q-item-label>
              <q-item-label caption>{{ item.caption }}</q-item-label>
            </q-item-section>
          </q-item>
        </q-virtual-scroll>
      </q-card-section>

      <q-separator />

      <q-card-section v-if="creating">
        <q-linear-progress
          :value="(progress ?? 0) / 100"
          :indeterminate="progress === null"
          color="primary"
        />
        <q-item-label caption class="q-mt-xs">{{ step }}</q-item-label>
      </q-card-section>

      <q-card-actions align="right">
        <q-btn flat label="Back" :disable="creating" @click="emit('update:modelValue', false)" />
        <q-btn
          color="primary"
          label="Create & start"
          :loading="creating"
          :disable="!canCreate"
          @click="emit('create')"
        />
      </q-card-actions>
    </q-card>
  </q-dialog>
</template>

<script setup lang="ts">
import type { NewServerPreview, NewServerSettingsModel } from '@/utils/new-server';

defineProps<{
  modelValue: boolean;
  preview: NewServerPreview;
  settings: NewServerSettingsModel;
  creating: boolean;
  step: string;
  progress: number | null;
  canCreate: boolean;
}>();

const emit = defineEmits<{ 'update:modelValue': [boolean]; create: [] }>();
</script>

<style scoped>
.min-width-0 {
  min-width: 0;
}
</style>
