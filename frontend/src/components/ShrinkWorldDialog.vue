<template>
  <q-dialog :model-value="true" persistent @hide="emit('close')">
    <q-card style="min-width: 360px; max-width: 520px; width: 100%">
      <q-card-section>
        <div class="text-h6">Shrink "{{ world }}"</div>
        <div class="text-caption">
          Removes chunks nobody has really visited, so the world takes less disk. Minecraft
          regenerates a removed chunk from the seed the next time someone goes there.
        </div>
      </q-card-section>

      <q-card-section class="q-pt-none">
        <q-banner v-if="!serverStopped" rounded dense class="q-mb-md">
          <template #avatar>
            <q-icon name="info" color="primary" />
          </template>
          The server is running. You can preview, but it must be stopped before shrinking.
        </q-banner>
        <q-banner v-else rounded dense class="q-mb-md">
          <template #avatar>
            <q-icon name="warning" color="warning" />
          </template>
          This can't be undone. Take a backup first.
        </q-banner>

        <div class="row q-col-gutter-sm q-mb-md">
          <div class="col-6">
            <q-input
              v-model.number="seconds"
              type="number"
              dense
              outlined
              min="1"
              max="3600"
              label="Visited less than (seconds)"
              :disable="busy"
            />
          </div>
          <div class="col-6">
            <q-input
              v-model.number="spawnChunks"
              type="number"
              dense
              outlined
              min="0"
              max="256"
              label="Keep chunks near spawn"
              :disable="busy"
            />
          </div>
        </div>

        <q-spinner v-if="busy" color="primary" size="24px" />
        <q-banner v-else-if="error" rounded dense class="text-negative">{{ error }}</q-banner>
        <q-list v-else-if="result" dense>
          <q-item>
            <q-item-section>
              {{ result.dryRun ? 'Would remove' : 'Removed' }}
            </q-item-section>
            <q-item-section side>
              {{ result.chunksRemoved }} of {{ result.chunksScanned }} chunks
            </q-item-section>
          </q-item>
          <q-item>
            <q-item-section>{{ result.dryRun ? 'Would free' : 'Freed' }}</q-item-section>
            <q-item-section side>{{ formatBytes(result.bytesFreed) }}</q-item-section>
          </q-item>
          <q-item>
            <q-item-section>Dimensions</q-item-section>
            <q-item-section side>{{ result.dimensions.join(', ') || 'none found' }}</q-item-section>
          </q-item>
          <q-item v-if="result.chunksUnreadable">
            <q-item-section>
              <q-item-label>Kept (couldn't be read)</q-item-label>
              <q-item-label caption>
                Unsupported compression or an external chunk file. These are never removed.
              </q-item-label>
            </q-item-section>
            <q-item-section side>{{ result.chunksUnreadable }}</q-item-section>
          </q-item>
          <q-item v-if="result.regionsSkipped">
            <q-item-section>
              <q-item-label>Region files skipped</q-item-label>
              <q-item-label caption>Damaged or truncated, so left untouched.</q-item-label>
            </q-item-section>
            <q-item-section side>{{ result.regionsSkipped }}</q-item-section>
          </q-item>
          <q-item v-if="result.spawn.source === 'origin'">
            <q-item-section class="text-caption">
              Spawn couldn't be read from level.dat, so the protected area is centred on 0, 0.
            </q-item-section>
          </q-item>
        </q-list>
      </q-card-section>

      <q-card-actions align="right">
        <q-btn flat label="Close" :disable="busy" @click="emit('close')" />
        <q-btn flat label="Preview again" :disable="busy" @click="run(true)" />
        <q-btn
          color="negative"
          label="Shrink"
          :disable="busy || !serverStopped || !canShrink"
          @click="run(false)"
        />
      </q-card-actions>
    </q-card>
  </q-dialog>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useQuasar } from 'quasar';
import { serverWorldsApi, type ShrinkWorldResult } from '@/api/serverWorlds';
import { formatBytes } from '@/composables/useServerStatus';

const props = defineProps<{ serverId: string; world: string; serverStopped: boolean }>();
const emit = defineEmits<{ close: []; shrunk: [] }>();

const $q = useQuasar();

const TICKS_PER_SECOND = 20;
const seconds = ref(30);
const spawnChunks = ref(8);
const busy = ref(false);
const error = ref<string | null>(null);
const result = ref<ShrinkWorldResult | null>(null);

// Only a preview that found something to remove unlocks the real thing.
const canShrink = computed(() => !!result.value?.dryRun && result.value.chunksRemoved > 0);

// Editing a setting invalidates the preview, so Shrink always matches what was previewed.
watch([seconds, spawnChunks], () => {
  result.value = null;
});

async function run(dryRun: boolean) {
  busy.value = true;
  error.value = null;
  try {
    const res = await serverWorldsApi.shrink(props.serverId, {
      world: props.world,
      dryRun,
      minInhabitedTicks: Math.max(1, Math.round(seconds.value * TICKS_PER_SECOND)),
      spawnKeepChunks: Math.max(0, Math.round(spawnChunks.value)),
    });
    result.value = res.result;
    if (!dryRun) {
      $q.notify({
        type: 'positive',
        message: `Freed ${formatBytes(res.result.bytesFreed)} from "${props.world}".`,
      });
      emit('shrunk');
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Shrink failed.';
  } finally {
    busy.value = false;
  }
}

onMounted(() => void run(true));
</script>
