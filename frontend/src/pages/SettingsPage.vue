<template>
  <q-page class="q-pa-md">
    <PageHeader title="Settings" icon="settings" />

    <div class="row q-col-gutter-md q-mb-md">
      <div class="col-12 col-lg-6">
        <q-card flat bordered class="q-pa-md">
          <div class="text-subtitle1 q-mb-md">API keys</div>
          <div class="row q-gutter-sm items-start no-wrap">
            <q-input
              v-model="cfKey"
              class="col"
              type="password"
              filled
              dense
              label="CurseForge API key"
              :placeholder="
                cfMasked ? `${cfMasked} (stored)` : 'paste your key from console.curseforge.com'
              "
              autocomplete="off"
            />
            <q-btn label="Save key" :loading="savingKey" @click="saveKey" />
            <q-btn flat label="Test key" :loading="testingKey" @click="testKey" />
          </div>
          <q-item-label caption class="q-mt-sm">
            Required for Auto-CurseForge packs and CF mod downloads. Stored encrypted at rest; new
            keys are live-tested before saving.
          </q-item-label>
          <q-item-label caption class="q-mt-md">
            <strong>Modrinth</strong> — no key needed, its public API is used directly.
          </q-item-label>
        </q-card>
      </div>

      <div class="col-12 col-lg-6">
        <q-card flat bordered class="q-pa-md">
          <div class="text-subtitle1 q-mb-md">Panel</div>
          <div class="row q-gutter-sm items-start no-wrap">
            <q-input
              v-model="publicHost"
              class="col"
              filled
              dense
              label="Public domain"
              placeholder="mc.example.com"
              autocomplete="off"
            />
            <q-btn label="Save domain" :loading="savingHost" @click="saveHost" />
          </div>
          <q-item-label caption class="q-mt-sm">
            Shown to players instead of your IP in connect addresses. Leave blank to use the
            server's IP.
          </q-item-label>

          <div class="row q-col-gutter-sm q-mt-md">
            <div class="col-6">
              <q-input v-model="timezone" filled dense label="Time zone" />
            </div>
            <div class="col-6">
              <q-input v-model="country" filled dense label="Country" />
            </div>
          </div>
          <q-btn
            label="Save time zone"
            class="q-mt-sm"
            :loading="savingLoc"
            @click="saveLocalization"
          />
          <q-item-label caption class="q-mt-sm">
            Controls how dates and player-activity times display across the panel.
          </q-item-label>

          <div class="row q-col-gutter-md q-mt-lg text-body2">
            <div class="col-6">
              <q-item-label caption>Bind address</q-item-label>
              <div class="font-mono">{{ settings?.panel.host }}</div>
            </div>
            <div class="col-6">
              <q-item-label caption>Port</q-item-label>
              <div class="font-mono">{{ settings?.panel.port }}</div>
            </div>
          </div>
          <q-item-label caption class="q-mt-sm">
            Set via .env (PANEL_HOST / PANEL_PORT) — a restart applies changes.
          </q-item-label>

          <div class="text-subtitle1 q-mt-lg q-mb-sm">Defaults for new servers</div>
          <div v-if="settings" class="row q-col-gutter-md text-body2">
            <div class="col-6">
              <q-item-label caption>Java heap</q-item-label>
              <div>{{ settings.defaults.heapMb }} MB</div>
            </div>
            <div class="col-6">
              <q-item-label caption>Container limit</q-item-label>
              <div>{{ settings.defaults.containerMemoryMb }} MB</div>
            </div>
            <div class="col-6">
              <q-item-label caption>Disk quota</q-item-label>
              <div>{{ settings.defaults.diskQuotaGb }} GB</div>
            </div>
            <div class="col-6">
              <q-item-label caption>Quota warnings</q-item-label>
              <div>
                {{ settings.defaults.quotaWarnPct }}% / {{ settings.defaults.quotaCriticalPct }}%
              </div>
            </div>
          </div>
        </q-card>
      </div>
    </div>
  </q-page>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useQuasar } from 'quasar';
import { settingsApi, type SettingsResponseData } from '@/api/settings';
import PageHeader from '@/components/PageHeader.vue';

const $q = useQuasar();

const settings = ref<SettingsResponseData | null>(null);
const cfKey = ref('');
const cfMasked = ref<string | null>(null);
const publicHost = ref('');
const timezone = ref('');
const country = ref('');

const savingKey = ref(false);
const testingKey = ref(false);
const savingHost = ref(false);
const savingLoc = ref(false);

async function load() {
  const [settingsRes, locRes] = await Promise.all([settingsApi.get(), settingsApi.localization()]);
  settings.value = settingsRes;
  cfMasked.value = settingsRes.curseforge.masked;
  publicHost.value = settingsRes.publicHost;
  timezone.value = locRes.localization.timezone;
  country.value = locRes.localization.country;
}

async function saveKey() {
  if (!cfKey.value.trim()) return;
  savingKey.value = true;
  try {
    await settingsApi.saveCurseforgeKey(cfKey.value.trim());
    $q.notify({ type: 'positive', message: 'CurseForge key saved.' });
    cfKey.value = '';
    await load();
  } catch (err) {
    $q.notify({ type: 'negative', message: err instanceof Error ? err.message : 'Save failed.' });
  } finally {
    savingKey.value = false;
  }
}

async function testKey() {
  testingKey.value = true;
  try {
    const res = await settingsApi.testCurseforgeKey();
    $q.notify({
      type: res.ok ? 'positive' : 'negative',
      message: res.ok ? 'Key is valid.' : (res.error ?? 'Key test failed.'),
    });
  } finally {
    testingKey.value = false;
  }
}

async function saveHost() {
  savingHost.value = true;
  try {
    await settingsApi.savePublicHost(publicHost.value);
    $q.notify({ type: 'positive', message: 'Public domain saved.' });
  } finally {
    savingHost.value = false;
  }
}

async function saveLocalization() {
  savingLoc.value = true;
  try {
    await settingsApi.saveLocalization({ timezone: timezone.value, country: country.value });
    $q.notify({ type: 'positive', message: 'Time zone saved.' });
  } finally {
    savingLoc.value = false;
  }
}

onMounted(load);
</script>
