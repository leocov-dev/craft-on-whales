<template>
  <div class="q-gutter-md">
    <q-input
      v-model="model.name"
      dense
      filled
      label="Server name"
      :disable="disable"
      :rules="[(v: string) => !!v?.trim() || 'Enter a server name']"
      lazy-rules
    />
    <div class="row q-col-gutter-sm">
      <div class="col-6">
        <q-input
          v-model.number="model.portGame"
          type="number"
          label="Game port"
          filled
          dense
          :disable="disable"
          :error="Boolean(portError)"
          :error-message="portError || ''"
          :loading="portChecking"
        />
      </div>
      <div class="col-6">
        <q-input
          v-model.number="model.diskQuotaGb"
          type="number"
          label="Disk quota (GB)"
          filled
          dense
          :disable="disable"
        />
      </div>
    </div>
    <div class="row q-col-gutter-sm">
      <div class="col-6">
        <q-input
          v-model.number="model.heapMb"
          type="number"
          label="Java heap (MB)"
          :hint="HEAP_FIELD_HINT"
          filled
          dense
          :disable="disable"
        />
      </div>
      <div class="col-6">
        <q-input
          v-model.number="model.containerMemoryMb"
          type="number"
          label="Container memory (MB)"
          filled
          dense
          :disable="disable"
          :error="Boolean(memoryError)"
          :error-message="memoryError || ''"
        />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, toRef, watchEffect } from 'vue';
import { HEAP_FIELD_HINT } from '@/composables/useServerStatus';
import { usePortCheck } from '@/composables/usePortCheck';
import type { NewServerSettingsModel } from '@/utils/new-server';

const model = defineModel<NewServerSettingsModel>({ required: true });
defineProps<{ disable?: boolean | undefined }>();
const emit = defineEmits<{ valid: [boolean] }>();

const { portError, portChecking } = usePortCheck(toRef(() => model.value.portGame));

const memoryError = computed(() => {
  const { heapMb, containerMemoryMb } = model.value;
  return heapMb && containerMemoryMb && containerMemoryMb <= heapMb
    ? 'Container memory must be higher than the Java heap.'
    : null;
});

watchEffect(() => {
  emit('valid', !portError.value && !portChecking.value && !memoryError.value);
});
</script>
