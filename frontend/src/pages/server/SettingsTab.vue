<template>
  <div v-if="server" class="row q-col-gutter-md">
    <div class="col-12 col-md-6">
      <q-card flat bordered class="q-pa-md q-gutter-md">
        <div class="text-subtitle1">Identity</div>
        <q-input v-model="form.name" label="Name" outlined dense />
        <q-input
          v-model="form.description"
          label="Description"
          outlined
          dense
          type="textarea"
          autogrow
        />
        <q-input v-model="tagsText" label="Tags (comma separated)" outlined dense />
        <q-input v-model="form.notes" label="Notes" outlined dense type="textarea" autogrow />
      </q-card>
    </div>

    <div class="col-12 col-md-6">
      <q-card flat bordered class="q-pa-md q-gutter-md">
        <div class="text-subtitle1">Resources</div>
        <q-input v-model.number="form.heapMb" type="number" label="Java heap (MB)" outlined dense />
        <q-input
          v-model.number="form.containerMemoryMb"
          type="number"
          label="Container memory limit (MB)"
          outlined
          dense
        />
        <q-input
          v-model.number="form.cpus"
          type="number"
          step="0.5"
          label="CPU limit (0 = unlimited)"
          outlined
          dense
        />
        <q-input
          v-model.number="form.diskQuotaGb"
          type="number"
          label="Disk quota (GB)"
          outlined
          dense
        />
      </q-card>

      <q-card flat bordered class="q-pa-md q-gutter-md q-mt-md">
        <div class="text-subtitle1">Lifecycle</div>
        <q-toggle v-model="form.autoStart" label="Auto-start with the panel" />
        <q-toggle v-model="form.autoRestart" label="Auto-restart on crash" />
        <q-select
          v-model="form.updatePolicy"
          :options="['manual', 'notify', 'auto']"
          outlined
          dense
          label="Modpack update policy"
        />
      </q-card>
    </div>

    <div class="col-12">
      <q-btn color="primary" label="Save changes" :loading="saving" @click="save" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import { useQuasar } from 'quasar';
import { serversApi, type ServerPatch } from '@/api/servers';
import { useServerDetail } from '@/composables/useServerDetail';

const $q = useQuasar();
const { server, refresh } = useServerDetail();

const form = ref<ServerPatch>({});
const tagsText = ref('');
const saving = ref(false);

function loadForm() {
  if (!server.value) return;
  form.value = {
    name: server.value.name,
    description: server.value.description,
    notes: server.value.notes,
    heapMb: server.value.resources.heapMb,
    containerMemoryMb: server.value.resources.containerMemoryMb,
    cpus: server.value.resources.cpus,
    diskQuotaGb: Math.round(server.value.disk.quota / 1024 ** 3),
    autoStart: server.value.autoStart,
    autoRestart: server.value.autoRestart,
    updatePolicy: server.value.updatePolicy,
  };
  tagsText.value = server.value.tags.join(', ');
}
watch(server, loadForm, { immediate: true });

async function save() {
  saving.value = true;
  try {
    const tags = tagsText.value
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    await serversApi.patch(server.value!.id, { ...form.value, tags });
    $q.notify({ type: 'positive', message: 'Settings saved.' });
    await refresh();
  } catch (err) {
    $q.notify({ type: 'negative', message: err instanceof Error ? err.message : 'Save failed.' });
  } finally {
    saving.value = false;
  }
}
</script>
