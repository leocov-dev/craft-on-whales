<template>
  <q-page class="q-pa-md">
    <PageHeader title="Schedules" icon="schedule">
      <template #action>
        <q-btn color="primary" icon="add" label="New task" @click="openCreate" />
      </template>
    </PageHeader>

    <q-card v-if="schedules.length" flat bordered>
      <q-table
        :rows="schedules"
        :columns="columns"
        row-key="id"
        flat
        :pagination="{ rowsPerPage: 0 }"
        hide-pagination
      >
        <template #body-cell-enabled="props">
          <q-td :props="props">
            <q-toggle :model-value="props.row.enabled" @update:model-value="toggle(props.row)" />
          </q-td>
        </template>
        <template #body-cell-actions="props">
          <q-td :props="props" class="text-right">
            <q-btn flat dense round icon="edit" @click="openEdit(props.row)" />
            <q-btn flat dense round icon="delete" color="negative" @click="remove(props.row)" />
          </q-td>
        </template>
      </q-table>
    </q-card>

    <q-banner v-else rounded class="q-mb-lg">
      <template #avatar>
        <q-icon name="info" color="primary" />
      </template>
      No scheduled tasks yet. Automate restarts, backups, and console commands on a cron schedule.
    </q-banner>

    <q-dialog v-model="dialogOpen">
      <q-card style="min-width: 420px">
        <q-card-section>
          <div class="text-subtitle1">
            {{ editing ? `Edit schedule — ${editing.task}` : 'New scheduled task' }}
          </div>
        </q-card-section>
        <q-card-section class="q-gutter-md">
          <q-select
            v-model="form.taskType"
            :options="taskTypes"
            option-label="label"
            option-value="value"
            emit-value
            map-options
            label="Task"
            filled
            dense
          />
          <q-select
            v-if="selectedMeta?.serverScoped"
            v-model="form.serverId"
            :options="serverOptions"
            option-label="label"
            option-value="value"
            emit-value
            map-options
            label="Server"
            filled
            dense
          />
          <q-input
            v-if="form.taskType === 'rcon'"
            v-model="form.command"
            label="RCON command"
            filled
            dense
          />
          <q-input
            v-model="form.cron"
            label="Cron expression"
            filled
            dense
            hint="e.g. 0 4 * * * (daily at 4am)"
          />
          <q-item-label caption>
            <span v-if="previewLoading">Checking…</span>
            <template v-else-if="previewRuns.length">
              Next runs:
              <span v-for="r in previewRuns" :key="r" class="q-mr-sm font-mono">{{
                new Date(r).toLocaleString()
              }}</span>
            </template>
            <span v-else-if="previewError" class="text-negative">{{ previewError }}</span>
          </q-item-label>
        </q-card-section>
        <q-card-actions align="right">
          <q-btn flat label="Cancel" v-close-popup />
          <q-btn
            color="primary"
            :label="editing ? 'Save changes' : 'Create schedule'"
            :loading="saving"
            @click="save"
          />
        </q-card-actions>
      </q-card>
    </q-dialog>
  </q-page>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue';
import { useQuasar, type QTableColumn } from 'quasar';
import { schedulesApi, type ScheduleViewModel, type TaskTypeOption } from '@/api/schedules';
import { useServersStore } from '@/stores/servers';
import PageHeader from '@/components/PageHeader.vue';

const $q = useQuasar();
const serversStore = useServersStore();

const schedules = ref<ScheduleViewModel[]>([]);
const taskTypes = ref<TaskTypeOption[]>([]);
const dialogOpen = ref(false);
const editing = ref<ScheduleViewModel | null>(null);
const saving = ref(false);

const form = ref({ taskType: '', serverId: null as string | null, cron: '', command: '' });
const previewRuns = ref<string[]>([]);
const previewLoading = ref(false);
const previewError = ref('');

const columns: QTableColumn[] = [
  { name: 'server', label: 'Server', field: 'server', align: 'left' },
  { name: 'task', label: 'Task', field: 'task', align: 'left' },
  { name: 'cron', label: 'Cron', field: 'cron', align: 'left' },
  {
    name: 'next',
    label: 'Next run',
    field: (r: ScheduleViewModel) => r.next ?? '—',
    align: 'right',
  },
  { name: 'enabled', label: 'Enabled', field: 'enabled', align: 'left' },
  { name: 'actions', label: '', field: () => '', align: 'right' },
];

const serverOptions = computed(() =>
  serversStore.servers.map((s) => ({ label: s.name, value: s.id })),
);
const selectedMeta = computed(
  () => taskTypes.value.find((t) => t.value === form.value.taskType) ?? null,
);

async function load() {
  const res = await schedulesApi.list();
  schedules.value = res.schedules;
  taskTypes.value = res.taskTypes;
}

function openCreate() {
  editing.value = null;
  form.value = { taskType: taskTypes.value[0]?.value ?? '', serverId: null, cron: '', command: '' };
  previewRuns.value = [];
  previewError.value = '';
  dialogOpen.value = true;
}

function openEdit(row: ScheduleViewModel) {
  editing.value = row;
  form.value = {
    taskType: row.taskType,
    serverId: row.serverId,
    cron: row.cron,
    command: typeof row.payload.command === 'string' ? row.payload.command : '',
  };
  dialogOpen.value = true;
}

async function loadPreview(cron: string) {
  previewLoading.value = true;
  try {
    const res = await schedulesApi.preview(cron);
    previewRuns.value = res.runs;
  } catch {
    previewError.value = 'Invalid cron expression.';
  } finally {
    previewLoading.value = false;
  }
}

let previewTimer: ReturnType<typeof setTimeout> | undefined;
watch(
  () => form.value.cron,
  (cron) => {
    clearTimeout(previewTimer);
    previewRuns.value = [];
    previewError.value = '';
    if (!cron.trim()) return;
    previewTimer = setTimeout(() => {
      void loadPreview(cron);
    }, 300);
  },
);

async function save() {
  const cron = form.value.cron.trim();
  if (!cron) {
    $q.notify({ type: 'negative', message: 'Enter a cron expression.' });
    return;
  }
  const meta = selectedMeta.value;
  if (meta?.serverScoped && !form.value.serverId) {
    $q.notify({ type: 'negative', message: `"${meta.label}" runs on a server — pick one.` });
    return;
  }
  if (form.value.taskType === 'rcon' && !form.value.command.trim()) {
    $q.notify({ type: 'negative', message: 'Enter the RCON command to run.' });
    return;
  }
  const payload = form.value.taskType === 'rcon' ? { command: form.value.command.trim() } : {};
  saving.value = true;
  try {
    // Create-then-delete on edit (no PATCH endpoint exists): matches the
    // original app's ordering, so a failed re-create never destroys data.
    await schedulesApi.create({
      serverId: meta?.serverScoped ? form.value.serverId : null,
      taskType: form.value.taskType,
      cron,
      payload,
    });
    if (editing.value) {
      try {
        await schedulesApi.remove(editing.value.id);
      } catch {
        $q.notify({
          type: 'warning',
          message: 'Saved as a new schedule, but the old one could not be removed.',
        });
      }
    }
    dialogOpen.value = false;
    await load();
  } catch (err) {
    $q.notify({ type: 'negative', message: err instanceof Error ? err.message : 'Save failed.' });
  } finally {
    saving.value = false;
  }
}

async function toggle(row: ScheduleViewModel) {
  await schedulesApi.toggle(row.id, !row.enabled);
  await load();
}

function remove(row: ScheduleViewModel) {
  $q.dialog({
    title: 'Delete schedule?',
    message: `Delete the "${row.task}" schedule for ${row.server}?`,
    cancel: true,
    ok: { color: 'negative', label: 'Delete' },
  }).onOk(() => {
    void (async () => {
      await schedulesApi.remove(row.id);
      await load();
    })();
  });
}

onMounted(async () => {
  if (!serversStore.loaded) await serversStore.fetchServers();
  await load();
});
</script>
