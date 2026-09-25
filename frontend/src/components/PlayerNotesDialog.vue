<template>
  <q-dialog :model-value="modelValue" @update:model-value="(v) => emit('update:modelValue', v)">
    <q-card bordered class="shadow-12" style="min-width: 360px; max-width: 480px; width: 100%">
      <q-card-section>
        <div class="text-subtitle1">Moderator Notes — {{ playerName }}</div>
      </q-card-section>
      <q-card-section class="q-pt-none">
        <q-spinner v-if="loading" color="primary" />
        <q-list v-else-if="notes.length" separator dense>
          <q-item v-for="n in notes" :key="n.id">
            <q-item-section>
              <q-item-label class="whitespace-pre-wrap">{{ n.note }}</q-item-label>
              <q-item-label caption>{{ n.author }} · {{ n.createdAt }}</q-item-label>
            </q-item-section>
            <q-item-section side>
              <q-btn dense flat round icon="close" @click="removeNote(n.id)" />
            </q-item-section>
          </q-item>
        </q-list>
        <q-item-label v-else caption>No notes yet — only visible to operators/admins.</q-item-label>
      </q-card-section>
      <q-card-section class="row q-gutter-sm q-pt-none">
        <q-input
          v-model="newNote"
          class="col"
          dense
          label="Add a note…"
          maxlength="1000"
          @keydown.enter="addNote"
        />
        <q-btn dense flat label="Add" :loading="adding" @click="addNote" />
      </q-card-section>
      <q-card-actions align="right">
        <q-btn flat label="Close" @click="emit('update:modelValue', false)" />
      </q-card-actions>
    </q-card>
  </q-dialog>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import { useQuasar } from 'quasar';
import { playersApi, type PlayerNote } from '@/api/players';

const props = defineProps<{
  modelValue: boolean;
  serverId: string;
  playerName: string;
}>();

const emit = defineEmits<{
  'update:modelValue': [boolean];
}>();

const $q = useQuasar();

const notes = ref<PlayerNote[]>([]);
const loading = ref(false);
const newNote = ref('');
const adding = ref(false);

async function load() {
  if (!props.serverId || !props.playerName) return;
  loading.value = true;
  try {
    const res = await playersApi.listNotes(props.serverId, props.playerName);
    notes.value = res.notes;
  } catch (err) {
    $q.notify({
      type: 'negative',
      message: err instanceof Error ? err.message : 'Could not load notes.',
    });
  } finally {
    loading.value = false;
  }
}

async function addNote() {
  const note = newNote.value.trim();
  if (!note) return;
  adding.value = true;
  try {
    await playersApi.addNote(props.serverId, props.playerName, note);
    newNote.value = '';
    await load();
  } catch (err) {
    $q.notify({
      type: 'negative',
      message: err instanceof Error ? err.message : 'Add note failed.',
    });
  } finally {
    adding.value = false;
  }
}

async function removeNote(id: string) {
  try {
    await playersApi.deleteNote(props.serverId, id);
    await load();
  } catch (err) {
    $q.notify({ type: 'negative', message: err instanceof Error ? err.message : 'Delete failed.' });
  }
}

watch(
  () => [props.modelValue, props.serverId, props.playerName],
  () => {
    if (props.modelValue) void load();
  },
  { immediate: true },
);
</script>
