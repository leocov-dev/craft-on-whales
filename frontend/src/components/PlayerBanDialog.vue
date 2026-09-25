<template>
  <q-dialog :model-value="modelValue" @update:model-value="(v) => emit('update:modelValue', v)">
    <q-card bordered class="shadow-12" style="min-width: 360px; max-width: 480px; width: 100%">
      <q-card-section>
        <div class="text-subtitle1">Ban {{ playerName }}</div>
      </q-card-section>
      <q-card-section class="q-gutter-md q-pt-none">
        <q-input v-model="reason" label="Reason (optional)" maxlength="256" />
        <q-select
          v-model="duration"
          :options="durationOptions"
          label="Duration"
          emit-value
          map-options
        />
        <q-checkbox
          v-if="lastKnownIp"
          v-model="alsoBanIp"
          :label="`Also ban this player's last known IP (${lastKnownIp})`"
        />
      </q-card-section>
      <q-card-actions align="right">
        <q-btn flat label="Cancel" @click="close" />
        <q-btn color="negative" label="Ban" :loading="banning" @click="submit" />
      </q-card-actions>
    </q-card>
  </q-dialog>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import { useQuasar } from 'quasar';
import { playersApi } from '@/api/players';

const props = defineProps<{
  modelValue: boolean;
  serverId: string;
  playerName: string;
}>();

const emit = defineEmits<{
  'update:modelValue': [boolean];
  banned: [];
}>();

const $q = useQuasar();

const reason = ref('');
const duration = ref<number | ''>('');
const alsoBanIp = ref(false);
const lastKnownIp = ref<string | null>(null);
const banning = ref(false);

const durationOptions = [
  { label: 'Permanent', value: '' },
  { label: '1 hour', value: 3600_000 },
  { label: '1 day', value: 86_400_000 },
  { label: '3 days', value: 259_200_000 },
  { label: '7 days', value: 604_800_000 },
  { label: '30 days', value: 2_592_000_000 },
];

function close() {
  emit('update:modelValue', false);
}

async function submit() {
  banning.value = true;
  try {
    const result = await playersApi.ban(
      props.serverId,
      props.playerName,
      reason.value || undefined,
      duration.value || undefined,
    );
    if (alsoBanIp.value && lastKnownIp.value) {
      await playersApi.banIp(props.serverId, lastKnownIp.value, reason.value || undefined, {
        durationMs: duration.value || undefined,
        player: props.playerName,
      });
    }
    $q.notify({
      type: 'positive',
      message: `${props.playerName} banned${result.result.banExpires ? ` until ${result.result.banExpires}` : ''}.`,
    });
    emit('banned');
    close();
  } catch (err) {
    $q.notify({ type: 'negative', message: err instanceof Error ? err.message : 'Ban failed.' });
  } finally {
    banning.value = false;
  }
}

watch(
  () => [props.modelValue, props.serverId, props.playerName],
  () => {
    if (!props.modelValue) return;
    reason.value = '';
    duration.value = '';
    alsoBanIp.value = false;
    lastKnownIp.value = null;
    if (props.serverId && props.playerName) {
      void playersApi
        .lastKnownIp(props.serverId, props.playerName)
        .then((res) => {
          lastKnownIp.value = res.ip;
        })
        .catch(() => {
          lastKnownIp.value = null;
        });
    }
  },
  { immediate: true },
);
</script>
