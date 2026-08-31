<template>
  <q-card flat bordered class="q-pa-md q-mb-md">
    <div class="row items-center q-gutter-x-sm">
      <q-icon v-if="icon" :name="icon" color="primary" size="28px" />
      <div class="text-h6">{{ title }}</div>
      <q-space />
      <slot name="action" />
    </div>
    <q-item-label v-if="subtitle" caption>{{ subtitle }}</q-item-label>
  </q-card>
</template>

<script setup lang="ts">
defineProps<{
  title: string;
  icon?: string;
  subtitle?: string;
}>();
</script>
