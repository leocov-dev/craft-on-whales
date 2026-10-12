<template>
  <q-dialog :model-value="true" persistent @hide="emit('close')">
    <q-card style="min-width: 360px; max-width: 520px; width: 100%">
      <q-card-section>
        <div class="text-h6">New seed for "{{ world }}"</div>
        <div class="text-caption">
          Deletes the world and generates a fresh one from the seed on next start. Everything built
          or explored in it is lost.
        </div>
      </q-card-section>

      <q-card-section class="q-pt-none">
        <q-banner v-if="!serverStopped" rounded dense class="q-mb-md">
          <template #avatar>
            <q-icon name="info" color="primary" />
          </template>
          Stop the server before changing the seed.
        </q-banner>

        <q-input
          v-model="seed"
          dense
          outlined
          maxlength="200"
          label="Seed"
          hint="Leave blank for a random seed"
          :disable="busy"
        />
        <q-checkbox
          v-model="backup"
          label="Back up the world first"
          :disable="busy"
          class="q-mt-sm"
        />
      </q-card-section>

      <q-card-actions align="right">
        <q-btn flat label="Cancel" :disable="busy" @click="emit('close')" />
        <q-btn
          color="negative"
          label="Regenerate"
          :loading="busy"
          :disable="!serverStopped"
          @click="run"
        />
      </q-card-actions>
    </q-card>
  </q-dialog>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { useQuasar } from 'quasar';
import { serverWorldsApi } from '@/api/serverWorlds';

const props = defineProps<{ serverId: string; world: string; serverStopped: boolean }>();
const emit = defineEmits<{ close: []; reset: [] }>();

const $q = useQuasar();
const seed = ref('');
const backup = ref(true);
const busy = ref(false);

async function run() {
  busy.value = true;
  try {
    const custom = seed.value.trim();
    await serverWorldsApi.reset(props.serverId, {
      seedMode: custom ? 'custom' : 'random',
      seed: custom,
      backup: backup.value,
    });
    $q.notify({ type: 'positive', message: 'World reset. It regenerates on next start.' });
    emit('reset');
    emit('close');
  } catch (err) {
    $q.notify({
      type: 'negative',
      message: err instanceof Error ? err.message : 'Reset failed.',
    });
  } finally {
    busy.value = false;
  }
}
</script>
