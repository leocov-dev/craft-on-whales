<template>
  <div>
    <div class="row items-center q-mb-md">
      <q-item-label caption>
        Prefix: <span class="font-mono">{{ prefix }}</span> · {{ stats.enabled }}/{{
          stats.total
        }}
        enabled · {{ stats.uses }} total uses
      </q-item-label>
      <q-space />
      <q-btn color="primary" icon="add" label="New command" @click="openCreate" />
    </div>

    <q-banner v-if="commands.length === 0" rounded class="q-mb-lg">
      <template #avatar>
        <q-icon name="info" color="primary" />
      </template>
      No custom commands yet.
    </q-banner>

    <q-card v-else flat bordered>
      <q-list separator>
        <q-item v-for="c in commands" :key="c.id">
          <q-item-section>
            <q-item-label class="font-mono">{{ prefix }}{{ c.trigger }}</q-item-label>
            <q-item-label caption
              >{{ c.actionSummary }} · {{ c.permission }} · {{ c.uses }} uses</q-item-label
            >
          </q-item-section>
          <q-item-section side>
            <q-toggle :model-value="c.enabled" @update:model-value="toggleEnabled(c)" />
          </q-item-section>
          <q-item-section side>
            <div class="row q-gutter-x-xs">
              <q-btn flat dense round icon="edit" @click="openEdit(c)" />
              <q-btn flat dense round icon="delete" color="negative" @click="removeCommand(c)" />
            </div>
          </q-item-section>
        </q-item>
      </q-list>
    </q-card>

    <q-dialog v-model="dialogOpen">
      <q-card style="min-width: 400px">
        <q-card-section class="text-subtitle1">{{
          editing ? 'Edit command' : 'New command'
        }}</q-card-section>
        <q-card-section class="q-gutter-md">
          <q-input v-model="form.trigger" label="Trigger (no prefix)" filled dense />
          <q-input v-model="form.description" label="Description" filled dense />
          <q-select
            v-model="form.action"
            :options="['rtp', 'structure', 'biome', 'console']"
            filled
            dense
            label="Action"
          />
          <q-select
            v-model="form.permission"
            :options="['everyone', 'whitelist', 'ops']"
            filled
            dense
            label="Permission"
          />
          <q-input
            v-model.number="form.cooldownSec"
            type="number"
            label="Cooldown (seconds)"
            filled
            dense
          />
        </q-card-section>
        <q-card-actions align="right">
          <q-btn flat label="Cancel" v-close-popup />
          <q-btn color="primary" label="Save" :loading="saving" @click="save" />
        </q-card-actions>
      </q-card>
    </q-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useQuasar } from 'quasar';
import {
  chatCommandsApi,
  type ChatCommand,
  type CommandAction,
  type CommandPermission,
} from '@/api/chatCommands';
import { useServerDetail } from '@/composables/useServerDetail';

const $q = useQuasar();
const { server } = useServerDetail();

const commands = ref<ChatCommand[]>([]);
const prefix = ref('!');
const stats = ref({ total: 0, enabled: 0, uses: 0 });

const dialogOpen = ref(false);
const editing = ref<ChatCommand | null>(null);
const saving = ref(false);
const form = ref<{
  trigger: string;
  description: string;
  action: CommandAction;
  permission: CommandPermission;
  cooldownSec: number;
}>({
  trigger: '',
  description: '',
  action: 'console',
  permission: 'everyone',
  cooldownSec: 30,
});

async function load() {
  if (!server.value) return;
  const res = await chatCommandsApi.list(server.value.id);
  commands.value = res.commands;
  prefix.value = res.prefix;
  stats.value = res.stats;
}

function openCreate() {
  editing.value = null;
  form.value = {
    trigger: '',
    description: '',
    action: 'console',
    permission: 'everyone',
    cooldownSec: 30,
  };
  dialogOpen.value = true;
}

function openEdit(c: ChatCommand) {
  editing.value = c;
  form.value = {
    trigger: c.trigger,
    description: c.description,
    action: c.action,
    permission: c.permission,
    cooldownSec: c.cooldown_sec,
  };
  dialogOpen.value = true;
}

async function save() {
  if (!server.value) return;
  saving.value = true;
  try {
    if (editing.value) {
      await chatCommandsApi.update(server.value.id, editing.value.id, form.value);
    } else {
      await chatCommandsApi.create(server.value.id, form.value);
    }
    dialogOpen.value = false;
    await load();
  } catch (err) {
    $q.notify({ type: 'negative', message: err instanceof Error ? err.message : 'Save failed.' });
  } finally {
    saving.value = false;
  }
}

async function toggleEnabled(c: ChatCommand) {
  if (!server.value) return;
  await chatCommandsApi.update(server.value.id, c.id, { enabled: !c.enabled });
  await load();
}

function removeCommand(c: ChatCommand) {
  if (!server.value) return;
  $q.dialog({
    title: `Delete "${c.trigger}"?`,
    cancel: true,
    ok: { color: 'negative', label: 'Delete' },
  }).onOk(() => {
    void chatCommandsApi.remove(server.value!.id, c.id).then(load);
  });
}

onMounted(load);
</script>
