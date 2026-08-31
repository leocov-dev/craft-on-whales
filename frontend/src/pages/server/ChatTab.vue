<template>
  <div class="row q-col-gutter-md">
    <div class="col-12 col-md-7">
      <q-card flat bordered class="q-pa-md">
        <div class="text-subtitle1 q-mb-sm">Send</div>
        <q-input v-model="text" label="Message" filled dense type="textarea" autogrow />
        <div class="row q-col-gutter-sm q-mt-sm">
          <div class="col-6">
            <q-select v-model="mode" :options="['tellraw', 'say']" filled dense label="Mode" />
          </div>
          <div class="col-6">
            <q-input v-model="target" label="Target" filled dense placeholder="@a" />
          </div>
        </div>
        <q-btn color="primary" label="Send" class="q-mt-sm" :loading="sending" @click="send" />
      </q-card>
    </div>

    <div class="col-12 col-md-5">
      <div class="text-subtitle1 q-mb-sm">History</div>
      <q-card flat bordered>
        <q-list separator>
          <q-item v-for="(h, i) in history" :key="i">
            <q-item-section>
              <q-item-label>{{ h.text }}</q-item-label>
              <q-item-label caption
                >{{ h.actor }} → {{ h.target }} ·
                {{ new Date(h.ts).toLocaleString() }}</q-item-label
              >
            </q-item-section>
          </q-item>
          <q-item v-if="history.length === 0">
            <q-item-section class="text-center"
              ><q-item-label caption>No messages sent yet.</q-item-label></q-item-section
            >
          </q-item>
        </q-list>
      </q-card>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useQuasar } from 'quasar';
import { chatApi, type ChatHistoryEntry } from '@/api/chat';
import { useServerDetail } from '@/composables/useServerDetail';

const $q = useQuasar();
const { server } = useServerDetail();

const text = ref('');
const mode = ref<'tellraw' | 'say'>('tellraw');
const target = ref('@a');
const sending = ref(false);
const history = ref<ChatHistoryEntry[]>([]);

async function load() {
  if (!server.value) return;
  const res = await chatApi.history(server.value.id);
  history.value = res.history;
}

async function send() {
  if (!server.value || !text.value.trim()) return;
  sending.value = true;
  try {
    await chatApi.send(server.value.id, {
      mode: mode.value,
      target: target.value || '@a',
      text: text.value.trim(),
    });
    text.value = '';
    await load();
  } catch (err) {
    $q.notify({ type: 'negative', message: err instanceof Error ? err.message : 'Send failed.' });
  } finally {
    sending.value = false;
  }
}

onMounted(load);
</script>
