<template>
  <div v-if="server" class="row q-col-gutter-md">
    <div class="col-12 col-md-6">
      <q-card flat bordered class="q-pa-md">
        <div class="text-subtitle1 q-mb-sm">Connect</div>
        <q-list dense>
          <q-item v-for="addr in server.addresses" :key="addr">
            <q-item-section class="font-mono">{{ addr }}</q-item-section>
            <q-item-section side>
              <q-btn flat dense round icon="content_copy" @click="copy(addr)" />
            </q-item-section>
          </q-item>
        </q-list>
      </q-card>
    </div>

    <div class="col-12 col-md-6">
      <q-card flat bordered class="q-pa-md">
        <div class="text-subtitle1 q-mb-sm">Live usage</div>
        <div class="row q-col-gutter-md text-body2">
          <div class="col-4">
            <q-item-label caption>Players</q-item-label>
            <div>{{ server.players.online }}/{{ server.players.max }}</div>
          </div>
          <div class="col-4">
            <q-item-label caption>CPU</q-item-label>
            <div>{{ server.status === 'running' ? `${server.stats.cpuPct}%` : '—' }}</div>
          </div>
          <div class="col-4">
            <q-item-label caption>Memory</q-item-label>
            <div>{{ server.status === 'running' ? `${server.stats.memUsedMb} MB` : '—' }}</div>
          </div>
        </div>
      </q-card>
    </div>

    <div class="col-12 col-md-6">
      <q-card flat bordered class="q-pa-md">
        <div class="text-subtitle1 q-mb-sm">Details</div>
        <div class="row q-col-gutter-md text-body2">
          <div class="col-6">
            <q-item-label caption>Type</q-item-label>
            <div>{{ server.flavor }}</div>
          </div>
          <div class="col-6">
            <q-item-label caption>Version</q-item-label>
            <div>{{ server.mcVersion }}</div>
          </div>
          <div class="col-6">
            <q-item-label caption>Java</q-item-label>
            <div>{{ server.javaTag }}</div>
          </div>
          <div class="col-6">
            <q-item-label caption>Created</q-item-label>
            <div>{{ new Date(server.created).toLocaleDateString() }}</div>
          </div>
        </div>
      </q-card>
    </div>

    <div class="col-12 col-md-6">
      <q-card flat bordered class="q-pa-md">
        <div class="text-subtitle1 q-mb-sm">Description</div>
        <q-item-label caption>{{ server.description || 'No description.' }}</q-item-label>
        <div v-if="server.tags.length" class="row q-gutter-xs q-mt-sm">
          <q-chip
            v-for="tag in server.tags"
            :key="tag"
            dense
            size="sm"
            color="accent"
            text-color="dark"
            >{{ tag }}</q-chip
          >
        </div>
      </q-card>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useQuasar } from 'quasar';
import { useServerDetail } from '@/composables/useServerDetail';

const $q = useQuasar();
const { server } = useServerDetail();

async function copy(text: string) {
  await navigator.clipboard.writeText(text);
  $q.notify({ type: 'positive', message: 'Copied.' });
}
</script>
