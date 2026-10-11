<template>
  <div>
    <q-item-label caption class="q-mb-sm">
      Pick a saved blueprint and give the new server a name and port. Manage or import blueprints on
      the <router-link to="/blueprints" class="text-primary">Blueprints</router-link> page.
    </q-item-label>

    <q-banner v-if="loaded && blueprints.length === 0" rounded>
      <template #avatar>
        <q-icon name="info" color="primary" />
      </template>
      No blueprints yet. Export one from a server's Settings tab, or import a .mcserver.zip on the
      Blueprints page.
    </q-banner>

    <div class="row q-col-gutter-sm">
      <div v-for="bp in blueprints" :key="bp.id" class="col-12 col-sm-6 col-md-4">
        <q-card
          flat
          bordered
          class="q-pa-sm cursor-pointer"
          :style="selected?.id === bp.id ? 'border-color: var(--q-primary)' : ''"
          @click="select(bp)"
        >
          <div class="row items-center q-gutter-x-xs">
            <q-icon name="architecture" color="grey-6" />
            <div class="text-body2 ellipsis">{{ bp.name }}</div>
            <q-badge v-if="bp.builtin" color="info" label="starter" />
          </div>
          <q-item-label caption class="ellipsis">
            {{ bp.pack ?? 'No pack' }} · {{ bp.overlayCount }} overlay mods
          </q-item-label>
        </q-card>
      </div>
    </div>

    <template v-if="selected">
      <q-separator class="q-my-md" />
      <div class="q-gutter-md" style="max-width: 640px">
        <q-input v-model="form.name" dense filled label="Server name" :disable="creating" />
        <q-input
          v-model.number="form.portGame"
          type="number"
          dense
          filled
          label="Game port"
          :disable="creating"
          :error="Boolean(portError)"
          :error-message="portError || ''"
          :loading="portChecking"
        />
        <q-btn
          color="primary"
          label="Create server"
          :loading="creating"
          :disable="!canCreate"
          @click="create"
        />
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, toRef, onMounted } from 'vue';
import { useQuasar } from 'quasar';
import { useRouter } from 'vue-router';
import { blueprintsApi, type BlueprintViewModel } from '@/api/blueprints';
import { wizardApi } from '@/api/wizard';
import { usePortCheck } from '@/composables/usePortCheck';
import { useServersStore } from '@/stores/servers';

const $q = useQuasar();
const router = useRouter();
const servers = useServersStore();

const blueprints = ref<BlueprintViewModel[]>([]);
const loaded = ref(false);
const selected = ref<BlueprintViewModel | null>(null);
const creating = ref(false);
const form = ref<{ name: string; portGame: number | undefined }>({
  name: '',
  portGame: undefined,
});

const { portError, portChecking } = usePortCheck(toRef(() => form.value.portGame));

const canCreate = computed(
  () =>
    Boolean(form.value.name.trim()) &&
    Boolean(form.value.portGame) &&
    !portError.value &&
    !portChecking.value &&
    !creating.value,
);

function select(bp: BlueprintViewModel) {
  selected.value = bp;
  form.value.name = bp.name;
}

async function create() {
  if (!selected.value || !canCreate.value) return;
  creating.value = true;
  try {
    const res = await blueprintsApi.create(selected.value.id, {
      name: form.value.name.trim(),
      portGame: form.value.portGame,
    });
    $q.notify({ type: 'positive', message: `Server "${res.server?.name}" created.` });
    await servers.fetchServers();
    await router.push(res.server ? `/servers/${res.server.id}` : '/');
  } catch (err) {
    $q.notify({
      type: 'negative',
      message: err instanceof Error ? err.message : 'Could not create server.',
    });
  } finally {
    creating.value = false;
  }
}

onMounted(async () => {
  if (!servers.loaded) await servers.fetchServers();
  const [list, portsRes] = await Promise.all([
    blueprintsApi.list().catch(() => null),
    wizardApi.suggestPorts().catch(() => null),
  ]);
  if (list) blueprints.value = list.blueprints;
  if (portsRes?.ports?.game) form.value.portGame = portsRes.ports.game;
  loaded.value = true;
});
</script>
