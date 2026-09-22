<template>
  <q-page class="q-pa-md">
    <PageHeader title="Permissions" icon="admin_panel_settings" />

    <q-card flat bordered class="q-pa-md q-mb-md">
      <div class="text-body2 text-grey-8">
        Per-server access for operators and viewers. Admins always have every permission on every
        server. A user with <strong>no</strong> permissions on a server can't see it anywhere in the
        panel — it's the same as it not existing for them.
      </div>
    </q-card>

    <div v-if="loading" class="row justify-center q-pa-xl">
      <q-spinner size="40px" />
    </div>

    <template v-else-if="matrix">
      <q-card flat bordered class="q-pa-md q-mb-md" v-if="matrix.users.length === 0">
        <div class="text-body2 text-grey-7">
          No operator or viewer accounts yet — create one under
          <router-link to="/users">Settings → Users</router-link> to grant it per-server access.
        </div>
      </q-card>

      <template v-else>
        <div class="row items-center q-gutter-sm q-mb-md">
          <q-select
            v-model="selectedServerId"
            :options="serverOptions"
            emit-value
            map-options
            filled
            dense
            label="Server"
            style="min-width: 260px"
          />
        </div>

        <q-card v-if="selectedServerId" flat bordered>
          <q-markup-table flat wrap-cells>
            <thead>
              <tr>
                <th class="text-left">User</th>
                <th class="text-left">Role default</th>
                <th v-for="cap in matrix.capabilities" :key="cap.key" class="text-center">
                  <span :title="cap.help">{{ cap.label }}</span>
                </th>
                <th class="text-left">Grant</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in matrix.rows" :key="row.user.id">
                <td>
                  {{ row.user.username }}
                  <q-badge outline color="primary" :label="row.user.role" class="q-ml-xs" />
                </td>
                <td class="text-caption text-grey-7">
                  {{ row.roleDefault.join(', ') || 'none' }}
                </td>
                <td v-for="cap in matrix.capabilities" :key="cap.key" class="text-center">
                  <q-checkbox
                    :model-value="effectiveFor(row).includes(cap.key)"
                    :disable="saving.has(row.user.id)"
                    @update:model-value="(v) => toggle(row, cap.key, Boolean(v))"
                  />
                </td>
                <td>
                  <template v-if="grantFor(row) === null">
                    <span class="text-caption text-grey-6">using role default</span>
                  </template>
                  <template v-else>
                    <q-btn
                      flat
                      dense
                      size="sm"
                      label="Reset to default"
                      :loading="saving.has(row.user.id)"
                      @click="resetToDefault(row)"
                    />
                  </template>
                </td>
              </tr>
            </tbody>
          </q-markup-table>
        </q-card>

        <q-card flat bordered class="q-pa-md q-mt-md">
          <div class="text-subtitle2 q-mb-sm">What each permission covers</div>
          <div class="row q-col-gutter-md">
            <div v-for="cap in matrix.capabilities" :key="cap.key" class="col-12 col-md-6">
              <div class="text-weight-medium">{{ cap.label }}</div>
              <div class="text-caption text-grey-7">{{ cap.help }}</div>
            </div>
          </div>
        </q-card>
      </template>
    </template>
  </q-page>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useQuasar } from 'quasar';
import {
  permissionsApi,
  type Capability,
  type PermissionsMatrix,
  type PermissionsMatrixRow,
} from '@/api/permissions';
import PageHeader from '@/components/PageHeader.vue';

const $q = useQuasar();

const loading = ref(true);
const matrix = ref<PermissionsMatrix | null>(null);
const selectedServerId = ref<string | null>(null);
const saving = ref<Set<string>>(new Set());

const serverOptions = computed(
  () => matrix.value?.servers.map((s) => ({ label: s.name, value: s.id })) ?? [],
);

function grantFor(row: PermissionsMatrixRow): Capability[] | null {
  const entry = row.servers.find((s) => s.serverId === selectedServerId.value);
  return entry ? entry.grant : null;
}

function effectiveFor(row: PermissionsMatrixRow): Capability[] {
  const entry = row.servers.find((s) => s.serverId === selectedServerId.value);
  return entry ? entry.effective : row.roleDefault;
}

async function load() {
  loading.value = true;
  try {
    matrix.value = await permissionsApi.matrix();
    if (!selectedServerId.value && matrix.value.servers.length > 0) {
      selectedServerId.value = matrix.value.servers[0]?.id ?? null;
    }
  } catch (err) {
    $q.notify({
      type: 'negative',
      message: err instanceof Error ? err.message : 'Failed to load permissions.',
    });
  } finally {
    loading.value = false;
  }
}

async function toggle(row: PermissionsMatrixRow, cap: Capability, value: boolean) {
  if (!selectedServerId.value) return;
  const current = new Set(effectiveFor(row));
  if (value) current.add(cap);
  else current.delete(cap);
  // `view` is implied by any other capability, and clearing every box means
  // "hide this server from this user" — both are handled server-side by
  // PermissionsService.normalize(), so the raw toggled set is sent as-is.
  await save(row, [...current] as Capability[]);
}

async function resetToDefault(row: PermissionsMatrixRow) {
  await save(row, null);
}

async function save(row: PermissionsMatrixRow, perms: Capability[] | null) {
  if (!selectedServerId.value) return;
  saving.value.add(row.user.id);
  try {
    await permissionsApi.setGrant(row.user.id, selectedServerId.value, perms);
    await load();
  } catch (err) {
    $q.notify({
      type: 'negative',
      message: err instanceof Error ? err.message : 'Failed to save permissions.',
    });
  } finally {
    saving.value.delete(row.user.id);
  }
}

onMounted(load);
</script>
