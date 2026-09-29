<template>
  <q-dialog :model-value="modelValue" @update:model-value="(v) => emit('update:modelValue', v)">
    <q-card bordered class="shadow-12" style="width: 560px; max-width: 95vw">
      <q-card-section>
        <div class="text-subtitle1">Pack imports</div>
        <q-item-label caption>
          Zip and .mrpack imports on this server, newest first. Removing one removes what it
          installed and undoes its override files.
        </q-item-label>
      </q-card-section>
      <q-card-section class="q-pt-none">
        <q-item-label v-if="imports.length === 0" caption>No imports.</q-item-label>
        <q-list v-else bordered separator class="rounded-borders">
          <q-item v-for="imp in imports" :key="imp.id">
            <q-item-section avatar>
              <q-icon :name="imp.format === 'mrpack' ? 'inventory_2' : 'folder_zip'" />
            </q-item-section>
            <q-item-section>
              <q-item-label>{{ importLabel(imp) }}</q-item-label>
              <q-item-label caption>
                {{ imp.contentCount }} mod(s) · {{ imp.overrideCount }} override file(s)
              </q-item-label>
              <q-item-label caption>
                {{ imp.actor }} · {{ formatCreatedAt(imp.createdAt) }}
              </q-item-label>
            </q-item-section>
            <q-item-section side>
              <q-btn
                flat
                dense
                color="negative"
                icon="undo"
                label="Remove"
                :loading="removing === imp.id"
                :disable="removing !== null"
                @click="confirmRemove(imp)"
              />
            </q-item-section>
          </q-item>
        </q-list>
      </q-card-section>
      <q-card-actions align="right">
        <q-btn flat label="Close" @click="emit('update:modelValue', false)" />
      </q-card-actions>
    </q-card>
  </q-dialog>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { useQuasar } from 'quasar';
import { modsApi, type ContentImportSummary } from '@/api/mods';
import { parseDbTimestamp } from '@/utils/db-timestamp';

const props = defineProps<{
  modelValue: boolean;
  serverId: string;
  imports: ContentImportSummary[];
}>();

const emit = defineEmits<{
  'update:modelValue': [boolean];
  removed: [];
}>();

const $q = useQuasar();
const removing = ref<string | null>(null);

/**
 * `created_at` is SQLite's zoneless-UTC `datetime('now')` or Postgres's `timestamptz::text`
 * (whose offset can be just `+00`); `parseDbTimestamp` handles both.
 */
function formatCreatedAt(value: string): string {
  return parseDbTimestamp(value).toLocaleString();
}

function importLabel(imp: ContentImportSummary): string {
  return imp.version ? `${imp.name} ${imp.version}` : imp.name;
}

function confirmRemove(imp: ContentImportSummary) {
  const label = importLabel(imp);
  $q.dialog({
    title: `Remove import "${label}"?`,
    message:
      `This deletes the ${imp.contentCount} mod(s)/plugin(s) this import installed, ` +
      `including any you've updated since. ` +
      `Its ${imp.overrideCount} override file(s) are rolled back: a file the import replaced ` +
      `is restored to what was there before, and a file it created is deleted. ` +
      `Any override file that was edited, deleted, or overwritten by a later import is left ` +
      `as it is. This can't be undone.`,
    cancel: true,
    ok: { color: 'negative', label: 'Remove import' },
  }).onOk(() => void remove(imp));
}

async function remove(imp: ContentImportSummary) {
  removing.value = imp.id;
  try {
    const res = await modsApi.deleteImport(props.serverId, imp.id);
    const { restored, deleted, kept } = res.overrides;
    $q.notify({
      type: 'positive',
      message:
        `Removed ${res.removedContent.length} mod(s); ` +
        `${restored.length} file(s) restored, ${deleted.length} deleted.`,
    });
    if (kept.length) {
      $q.notify({
        type: 'warning',
        message: `${kept.length} override file(s) changed since the import were left as they are.`,
        caption: kept.slice(0, 5).join(', ') + (kept.length > 5 ? ', …' : ''),
        timeout: 0,
        actions: [{ label: 'Dismiss', color: 'black' }],
      });
    }
    emit('removed');
  } catch (err) {
    $q.notify({
      type: 'negative',
      message: err instanceof Error ? err.message : 'Remove failed.',
    });
  } finally {
    removing.value = null;
  }
}
</script>
