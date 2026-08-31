<template>
  <div class="row q-col-gutter-md">
    <div class="col-12 col-md-6">
      <q-card flat bordered class="q-pa-md q-gutter-md">
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
        <div class="row q-gutter-sm">
          <q-btn dense outline label="Save" :loading="savingDiscord" @click="saveDiscord" />
          <q-btn dense flat label="Test" :loading="testingDiscord" @click="testDiscord" />
        </div>
      </q-card>
    </div>

    <div class="col-12 col-md-6">
      <q-card flat bordered class="q-pa-md q-gutter-md">
        <div class="text-subtitle1">Public status page</div>
        <q-toggle v-model="statusPage.enabled" label="Enabled" />
        <q-input v-model="statusSlug" label="Slug" filled dense placeholder="my-server" />
        <q-btn dense outline label="Save" :loading="savingStatus" @click="saveStatusPage" />
      </q-card>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useQuasar } from 'quasar';
import { integrationsApi, type DiscordConfig, type StatusPageConfig } from '@/api/integrations';
import { useServerDetail } from '@/composables/useServerDetail';

const $q = useQuasar();
const { server } = useServerDetail();

const discord = ref<DiscordConfig>({
  enabled: false,
  hasWebhook: false,
  webhookMasked: null,
  events: { lifecycle: true, crashes: true, backups: true, updates: true, players: true },
});
// A new webhook URL the user is typing, NOT the current one — the API never
// sends the real webhook URL back once set (see DiscordConfig's doc comment),
// so this starts blank and an empty save means "keep the current one."
const discordWebhook = ref('');
const statusPage = ref<StatusPageConfig>({ enabled: false, slug: null, path: null });
const statusSlug = ref('');

const savingDiscord = ref(false);
const testingDiscord = ref(false);
const savingStatus = ref(false);

async function load() {
  if (!server.value) return;
  const res = await integrationsApi.get(server.value.id);
  discord.value = res.discord;
  statusPage.value = res.statusPage;
  statusSlug.value = res.statusPage.slug ?? '';
}

async function saveDiscord() {
  if (!server.value) return;
  savingDiscord.value = true;
  try {
    const res = await integrationsApi.saveDiscord(server.value.id, {
      enabled: discord.value.enabled,
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
      slug: statusSlug.value || undefined,
    });
    $q.notify({ type: 'positive', message: 'Status page settings saved.' });
  } catch (err) {
    $q.notify({ type: 'negative', message: err instanceof Error ? err.message : 'Save failed.' });
  } finally {
    savingStatus.value = false;
  }
}

onMounted(load);
</script>
