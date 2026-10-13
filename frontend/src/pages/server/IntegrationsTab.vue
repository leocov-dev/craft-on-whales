<template>
  <div class="row q-col-gutter-md">
    <div class="col-12 col-md-6">
      <q-card flat bordered class="q-pa-md">
        <div class="q-gutter-md">
          <div class="text-subtitle1">Discord webhook</div>
          <q-toggle v-model="discord.enabled" label="Enabled" />
          <q-input
            v-model="discordWebhook"
            label="Webhook URL"
            filled
            dense
            :placeholder="discord.webhookMasked ?? 'https://discord.com/api/webhooks/…'"
            hint="Leave blank to keep the current webhook"
          />
          <div>
            <div class="text-caption text-grey q-mb-xs">Notify on</div>
            <div class="row q-col-gutter-x-md">
              <q-checkbox
                v-for="cat in eventCategories"
                :key="cat.key"
                v-model="discord.events[cat.key]"
                :label="cat.label"
                dense
              />
            </div>
          </div>
          <div class="row justify-end q-gutter-sm">
            <q-btn dense flat label="Test" :loading="testingDiscord" @click="testDiscord" />
            <q-btn
              dense
              color="primary"
              label="Save"
              :loading="savingDiscord"
              @click="saveDiscord"
            />
          </div>
        </div>
      </q-card>
    </div>

    <div class="col-12 col-md-6">
      <q-card flat bordered class="q-pa-md">
        <div class="q-gutter-md">
          <div class="text-subtitle1">Public status page</div>
          <q-toggle v-model="statusPage.enabled" label="Enabled" />
          <q-input v-model="statusSlug" label="Slug" filled dense :placeholder="defaultSlug" />
          <div class="row justify-end">
            <q-btn
              dense
              color="primary"
              label="Save"
              :loading="savingStatus"
              @click="saveStatusPage"
            />
          </div>
        </div>
      </q-card>
    </div>

    <div class="col-12 col-md-6">
      <q-card flat bordered class="q-pa-md">
        <div class="q-gutter-md">
          <div class="text-subtitle1">Restart webhook</div>
          <div class="text-caption text-grey">
            Lets another service restart this server by sending a <code>POST</code> to the URL below
            with <code>Authorization: Bearer &lt;key&gt;</code>. The key works for this endpoint
            only.
          </div>
          <q-input :model-value="restartUrl" label="Restart URL" filled dense readonly>
            <template #append>
              <q-btn flat dense round icon="content_copy" @click="copyRestartUrl" />
            </template>
          </q-input>
          <q-toggle
            :model-value="restartHook.enabled"
            :disable="!restartHook.hasKey"
            label="Enabled"
            @update:model-value="toggleRestartHook"
          />
          <q-input
            v-if="newKey"
            :model-value="newKey"
            label="New key — copy it now, it won't be shown again"
            filled
            dense
            readonly
          >
            <template #append>
              <q-btn flat dense round icon="content_copy" @click="copyKey" />
            </template>
          </q-input>
          <div v-else-if="restartHook.hasKey" class="text-caption">
            Current key: <code>{{ restartHook.keyPrefix }}…</code>
          </div>
          <div class="row justify-end q-gutter-sm">
            <q-btn
              v-if="restartHook.hasKey"
              dense
              flat
              color="negative"
              label="Revoke"
              :loading="savingHook"
              @click="revokeRestartHook"
            />
            <q-btn
              dense
              color="primary"
              :label="restartHook.hasKey ? 'Regenerate key' : 'Generate key'"
              :loading="savingHook"
              @click="generateKey"
            />
          </div>
        </div>
      </q-card>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onMounted } from 'vue';
import { useQuasar } from 'quasar';
import {
  integrationsApi,
  type DiscordConfig,
  type StatusPageConfig,
  type EventToggles,
  type RestartHookConfig,
} from '@/api/integrations';
import { useServerDetail } from '@/composables/useServerDetail';
import { slugify } from '@/utils/slug';

const $q = useQuasar();
const { server } = useServerDetail();

const defaultSlug = computed(() => (server.value ? slugify(server.value.name) : ''));

const eventCategories: { key: keyof EventToggles; label: string }[] = [
  { key: 'lifecycle', label: 'Start/stop' },
  { key: 'crashes', label: 'Crashes' },
  { key: 'backups', label: 'Backups' },
  { key: 'updates', label: 'Updates' },
  { key: 'players', label: 'Players' },
  { key: 'alerts', label: 'Alerts' },
];

const discord = ref<DiscordConfig>({
  enabled: false,
  hasWebhook: false,
  webhookMasked: null,
  events: {
    lifecycle: true,
    crashes: true,
    backups: true,
    updates: true,
    players: true,
    alerts: true,
  },
});
// A new webhook URL the user is typing, NOT the current one — the API never
// sends the real webhook URL back once set (see DiscordConfig's doc comment),
// so this starts blank and an empty save means "keep the current one."
const discordWebhook = ref('');
const statusPage = ref<StatusPageConfig>({ enabled: false, slug: null, path: null });
const statusSlug = ref('');

const restartHook = ref<RestartHookConfig>({
  enabled: false,
  hasKey: false,
  keyPrefix: null,
  path: '',
});
// The raw key, held only until the user leaves — the API never returns it again.
const newKey = ref('');
const savingHook = ref(false);
const restartUrl = computed(() => `${window.location.origin}${restartHook.value.path}`);

const savingDiscord = ref(false);
const testingDiscord = ref(false);
const savingStatus = ref(false);

async function load() {
  if (!server.value) return;
  const res = await integrationsApi.get(server.value.id);
  discord.value = res.discord;
  statusPage.value = res.statusPage;
  statusSlug.value = res.statusPage.slug ?? '';
  restartHook.value = res.restartHook;
}

async function saveDiscord() {
  if (!server.value) return;
  savingDiscord.value = true;
  try {
    const res = await integrationsApi.saveDiscord(server.value.id, {
      enabled: discord.value.enabled,
      events: discord.value.events,
      ...(discordWebhook.value ? { webhookUrl: discordWebhook.value } : {}),
    });
    discord.value = res.discord;
    discordWebhook.value = '';
    $q.notify({ type: 'positive', message: 'Discord settings saved.' });
  } catch (err) {
    $q.notify({ type: 'negative', message: err instanceof Error ? err.message : 'Save failed.' });
  } finally {
    savingDiscord.value = false;
  }
}

async function testDiscord() {
  if (!server.value) return;
  testingDiscord.value = true;
  try {
    const res = await integrationsApi.testDiscord(server.value.id);
    $q.notify({
      type: res.ok ? 'positive' : 'negative',
      message: res.ok ? 'Test message sent.' : (res.error ?? 'Test failed.'),
    });
  } finally {
    testingDiscord.value = false;
  }
}

async function saveStatusPage() {
  if (!server.value) return;
  savingStatus.value = true;
  try {
    await integrationsApi.saveStatusPage(server.value.id, {
      enabled: statusPage.value.enabled,
      slug: statusSlug.value || defaultSlug.value || undefined,
    });
    $q.notify({ type: 'positive', message: 'Status page settings saved.' });
  } catch (err) {
    $q.notify({ type: 'negative', message: err instanceof Error ? err.message : 'Save failed.' });
  } finally {
    savingStatus.value = false;
  }
}

async function runHookAction(action: () => Promise<void>, failure: string): Promise<void> {
  savingHook.value = true;
  try {
    await action();
  } catch (err) {
    $q.notify({ type: 'negative', message: err instanceof Error ? err.message : failure });
  } finally {
    savingHook.value = false;
  }
}

function toggleRestartHook(enabled: boolean) {
  const id = server.value?.id;
  if (!id) return;
  return runHookAction(async () => {
    restartHook.value = (await integrationsApi.setRestartHook(id, enabled)).restartHook;
  }, 'Save failed.');
}

function generateKey() {
  const id = server.value?.id;
  if (!id) return;
  return runHookAction(async () => {
    const res = await integrationsApi.regenerateRestartHookKey(id);
    newKey.value = res.key;
    restartHook.value = res.restartHook;
  }, 'Could not generate key.');
}

function revokeRestartHook() {
  const id = server.value?.id;
  if (!id) return;
  return runHookAction(async () => {
    restartHook.value = (await integrationsApi.clearRestartHook(id)).restartHook;
    newKey.value = '';
  }, 'Could not revoke key.');
}

async function copyKey() {
  try {
    await navigator.clipboard.writeText(newKey.value);
    $q.notify({ type: 'positive', message: 'Key copied.' });
  } catch {
    $q.notify({ type: 'negative', message: 'Copy failed — select the key and copy manually.' });
  }
}

async function copyRestartUrl() {
  try {
    await navigator.clipboard.writeText(restartUrl.value);
    $q.notify({ type: 'positive', message: 'URL copied.' });
  } catch {
    $q.notify({ type: 'negative', message: 'Copy failed — select the URL and copy manually.' });
  }
}

onMounted(load);
</script>
