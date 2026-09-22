<template>
  <q-page class="q-pa-md">
    <PageHeader title="Public API" icon="vpn_key" />

    <q-card flat bordered class="q-pa-md q-mb-md">
      <div class="row items-center q-gutter-md">
        <q-toggle
          v-model="enabled"
          :disable="togglingEnabled"
          @update:model-value="toggleEnabled"
        />
        <div>
          <div class="text-body1">Public API {{ enabled ? 'enabled' : 'disabled' }}</div>
          <div class="text-caption text-grey-7">
            Read-only <code>/api/v1/servers</code> access for tokens below. Off by default; turning
            it off stops every token from authenticating without deleting them.
          </div>
        </div>
      </div>
    </q-card>

    <div v-if="loading" class="row justify-center q-pa-xl">
      <q-spinner size="40px" />
    </div>

    <template v-else>
      <div class="row items-center q-mb-md">
        <div class="text-subtitle1">Tokens</div>
        <q-space />
        <q-btn color="primary" icon="add" label="New token" @click="showCreate = true" />
      </div>

      <q-card flat bordered v-if="tokens.length === 0" class="q-pa-md">
        <div class="text-body2 text-grey-7">No tokens minted yet.</div>
      </q-card>

      <q-markup-table v-else flat bordered wrap-cells>
        <thead>
          <tr>
            <th class="text-left">Label</th>
            <th class="text-left">Scope</th>
            <th class="text-left">Created by</th>
            <th class="text-left">Expires</th>
            <th class="text-left">Last used</th>
            <th class="text-left">Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="t in tokens" :key="t.id">
            <td>{{ t.label }}</td>
            <td>{{ scopeLabel(t) }}</td>
            <td>{{ t.createdBy }}</td>
            <td>{{ t.expiresAt ? new Date(t.expiresAt).toLocaleString() : 'never' }}</td>
            <td>{{ t.lastUsedAt ? new Date(t.lastUsedAt).toLocaleString() : 'never' }}</td>
            <td>
              <q-badge v-if="t.revoked" color="negative" label="Revoked" />
              <q-badge v-else color="positive" label="Active" />
            </td>
            <td>
              <q-btn
                v-if="!t.revoked"
                flat
                dense
                size="sm"
                color="negative"
                label="Revoke"
                :loading="revoking.has(t.id)"
                @click="revoke(t)"
              />
            </td>
          </tr>
        </tbody>
      </q-markup-table>
    </template>

    <q-dialog v-model="showCreate">
      <q-card style="min-width: 420px">
        <q-card-section class="text-h6">New public API token</q-card-section>
        <q-card-section class="q-gutter-md">
          <q-input v-model="form.label" filled dense label="Label" autofocus />
          <q-select
            v-model="form.serverIds"
            :options="serverOptions"
            emit-value
            map-options
            multiple
            filled
            dense
            label="Servers (leave blank for all)"
            clearable
          />
          <q-input v-model="form.expiresAt" filled dense type="date" label="Expires (optional)" />
        </q-card-section>
        <q-card-actions align="right">
          <q-btn flat label="Cancel" v-close-popup />
          <q-btn
            color="primary"
            label="Create"
            :loading="creating"
            :disable="!form.label.trim()"
            @click="create"
          />
        </q-card-actions>
      </q-card>
    </q-dialog>

    <q-dialog v-model="showRaw" persistent>
      <q-card style="min-width: 480px">
        <q-card-section class="text-h6">Token created</q-card-section>
        <q-card-section>
          <div class="text-body2 text-grey-7 q-mb-sm">
            Copy this now — it's shown only once and can't be retrieved again.
          </div>
          <q-input :model-value="rawToken" filled dense readonly>
            <template #append>
              <q-btn flat dense round icon="content_copy" @click="copyToken" />
            </template>
          </q-input>
        </q-card-section>
        <q-card-actions align="right">
          <q-btn color="primary" label="Done" v-close-popup />
        </q-card-actions>
      </q-card>
    </q-dialog>
  </q-page>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { useQuasar } from 'quasar';
import { apiTokensApi, type ApiTokenSummary } from '@/api/apiTokens';
import { serversApi } from '@/api/servers';
import PageHeader from '@/components/PageHeader.vue';

const $q = useQuasar();

const loading = ref(true);
const enabled = ref(false);
const togglingEnabled = ref(false);
const tokens = ref<ApiTokenSummary[]>([]);
const serverOptions = ref<{ label: string; value: string }[]>([]);
const revoking = ref<Set<string>>(new Set());

const showCreate = ref(false);
const creating = ref(false);
const form = reactive<{ label: string; serverIds: string[]; expiresAt: string }>({
  label: '',
  serverIds: [],
  expiresAt: '',
});

const showRaw = ref(false);
const rawToken = ref('');

function scopeLabel(t: ApiTokenSummary): string {
  if (t.serverIds === null) return 'All servers';
  const names = t.serverIds.map(
    (id) => serverOptions.value.find((o) => o.value === id)?.label ?? id,
  );
  return names.join(', ') || 'None';
}

async function load() {
  loading.value = true;
  try {
    const [list, servers] = await Promise.all([apiTokensApi.list(), serversApi.list()]);
    enabled.value = list.enabled;
    tokens.value = list.tokens;
    serverOptions.value = servers.servers.map((s) => ({ label: s.name, value: s.id }));
  } catch (err) {
    $q.notify({
      type: 'negative',
      message: err instanceof Error ? err.message : 'Failed to load tokens.',
    });
  } finally {
    loading.value = false;
  }
}

async function toggleEnabled(value: boolean | null) {
  togglingEnabled.value = true;
  try {
    const res = await apiTokensApi.setEnabled(Boolean(value));
    enabled.value = res.enabled;
  } catch (err) {
    enabled.value = !value;
    $q.notify({
      type: 'negative',
      message: err instanceof Error ? err.message : 'Failed to update.',
    });
  } finally {
    togglingEnabled.value = false;
  }
}

async function create() {
  creating.value = true;
  try {
    const res = await apiTokensApi.create({
      label: form.label.trim(),
      serverIds: form.serverIds.length > 0 ? form.serverIds : null,
      expiresAt: form.expiresAt ? new Date(form.expiresAt).toISOString() : null,
    });
    showCreate.value = false;
    form.label = '';
    form.serverIds = [];
    form.expiresAt = '';
    rawToken.value = res.token;
    showRaw.value = true;
    await load();
  } catch (err) {
    $q.notify({
      type: 'negative',
      message: err instanceof Error ? err.message : 'Failed to create token.',
    });
  } finally {
    creating.value = false;
  }
}

async function revoke(t: ApiTokenSummary) {
  revoking.value.add(t.id);
  try {
    await apiTokensApi.revoke(t.id);
    await load();
  } catch (err) {
    $q.notify({
      type: 'negative',
      message: err instanceof Error ? err.message : 'Failed to revoke token.',
    });
  } finally {
    revoking.value.delete(t.id);
  }
}

async function copyToken() {
  try {
    await navigator.clipboard.writeText(rawToken.value);
    $q.notify({ type: 'positive', message: 'Copied.' });
  } catch {
    // clipboard API unavailable — the field is still selectable/readable
  }
}

onMounted(load);
</script>
