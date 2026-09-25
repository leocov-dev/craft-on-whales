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
          <div v-if="defaultsForm" class="row q-col-gutter-sm text-body2">
            <div class="col-6">
              <q-input
                v-model.number="defaultsForm.heapMb"
                type="number"
                filled
                dense
                label="Java heap (MB)"
                :disable="!auth.isAdmin"
              />
            </div>
            <div class="col-6">
              <q-input
                v-model.number="defaultsForm.containerMemoryMb"
                type="number"
                filled
                dense
                label="Container limit (MB)"
                :disable="!auth.isAdmin"
              />
            </div>
            <div class="col-6">
              <q-input
                v-model.number="defaultsForm.diskQuotaGb"
                type="number"
                filled
                dense
                label="Disk quota (GB)"
                :disable="!auth.isAdmin"
              />
            </div>
            <div class="col-6">
              <q-input
                v-model.number="defaultsForm.cpus"
                type="number"
                filled
                dense
                label="CPU limit (0 = unlimited)"
                :disable="!auth.isAdmin"
              />
            </div>
            <div class="col-6">
              <q-input
                v-model.number="defaultsForm.quotaWarnPct"
                type="number"
                filled
                dense
                label="Quota warn %"
                :disable="!auth.isAdmin"
              />
            </div>
            <div class="col-6">
              <q-input
                v-model.number="defaultsForm.quotaCriticalPct"
                type="number"
                filled
                dense
                label="Quota critical %"
                :disable="!auth.isAdmin"
              />
            </div>
          </div>
          <q-item-label v-if="defaultsCustomized" caption class="q-mt-xs">
            Custom defaults are set — the create-server wizard and API-create fallback use these.
          </q-item-label>
          <q-item-label v-else caption class="q-mt-xs">
            Using the built-in defaults derived from .env and this machine.
          </q-item-label>
          <div v-if="auth.isAdmin" class="row q-gutter-sm q-mt-sm">
            <q-btn label="Save defaults" :loading="savingDefaults" @click="saveDefaults" />
            <q-btn
              flat
              label="Restore built-ins"
              :loading="restoringDefaults"
              @click="restoreDefaults"
            />
          </div>

          <div class="row q-gutter-sm items-start no-wrap q-mt-md">
            <q-input
              v-model.number="startingPort"
              class="col"
              type="number"
              filled
              dense
              label="Starting game port"
              :disable="settings?.startingPortOverriddenByEnv"
              :hint="
                settings?.startingPortOverriddenByEnv
                  ? 'Overridden by STARTING_PORT environment variable'
                  : 'Default game port for the first server created'
              "
            />
            <q-btn
              label="Save port"
              :disable="settings?.startingPortOverriddenByEnv"
              :loading="savingPort"
              @click="saveStartingPort"
            />
          </div>
        </q-card>
      </div>

      <div class="col-12 col-lg-6">
        <q-card flat bordered class="q-pa-md">
          <div class="text-subtitle1 q-mb-md">Backup retention ceilings</div>
          <div v-if="retentionForm" class="row q-col-gutter-sm text-body2">
            <div class="col-6">
              <q-input
                v-model.number="retentionForm.maxAgeDays"
                type="number"
                filled
                dense
                label="Max age (days)"
                hint="0 = no limit"
                :disable="!auth.isAdmin"
              />
            </div>
            <div class="col-6">
              <q-input
                v-model.number="retentionForm.maxTotalGb"
                type="number"
                filled
                dense
                label="Max total size (GB)"
                hint="0 = no limit"
                :disable="!auth.isAdmin"
              />
            </div>
          </div>
          <q-item-label caption class="q-mt-sm">
            Applied per server, on top of the fixed per-reason backup counts (scheduled/pre-update/
            manual/pre-restore). A server's newest backup is never deleted by either ceiling.
          </q-item-label>
          <div v-if="auth.isAdmin" class="row q-gutter-sm q-mt-sm">
            <q-btn label="Save ceilings" :loading="savingRetention" @click="saveBackupRetention" />
          </div>
        </q-card>
      </div>

      <div v-if="auth.isAdmin" class="col-12 col-lg-6">
        <q-card flat bordered class="q-pa-md">
          <div class="text-subtitle1 q-mb-md">Panel updates</div>
          <div class="row q-col-gutter-md text-body2">
            <div class="col-6">
              <q-item-label caption>Current version</q-item-label>
              <div class="font-mono">{{ panelUpdate?.currentVersion ?? '…' }}</div>
            </div>
            <div class="col-6">
              <q-item-label caption>Latest stable release</q-item-label>
              <div class="font-mono">
                <a
                  v-if="panelUpdate?.releaseUrl"
                  :href="panelUpdate.releaseUrl"
                  target="_blank"
                  rel="noopener"
                  >{{ panelUpdate.latestVersion }}</a
                >
                <span v-else>{{ panelUpdate?.latestVersion ?? '—' }}</span>
              </div>
            </div>
          </div>

          <q-banner
            v-if="panelUpdate?.updateAvailable"
            dense
            rounded
            class="bg-positive text-white q-mt-md"
          >
            <template #avatar>
              <q-icon name="system_update" />
            </template>
            An update is available.
            <a
              v-if="panelUpdate.releaseUrl"
              :href="panelUpdate.releaseUrl"
              target="_blank"
              rel="noopener"
              class="text-white"
            >
              View the release
            </a>
          </q-banner>
          <q-item-label v-else-if="panelUpdate && !panelUpdate.error" caption class="q-mt-md">
            You're running the latest stable release.
          </q-item-label>

          <q-banner v-if="panelUpdate?.error" dense rounded class="bg-warning text-dark q-mt-md">
            Couldn't check GitHub for the latest release: {{ panelUpdate.error }}
          </q-banner>

          <q-item-label v-if="panelUpdate?.checkedAt" caption class="q-mt-sm">
            Last checked {{ formatCheckedAt(panelUpdate.checkedAt) }}.
          </q-item-label>

          <div class="row q-gutter-sm q-mt-sm">
            <q-btn label="Check now" :loading="checkingPanelUpdate" @click="checkPanelUpdate" />
          </div>
          <q-item-label caption class="q-mt-sm">
            Read-only — this only compares versions and links to the release. It never downloads or
            applies anything.
          </q-item-label>
        </q-card>
      </div>
    </div>
  </q-page>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useQuasar } from 'quasar';
import {
  settingsApi,
  type SettingsResponseData,
  type ResourceDefaults,
  type BackupRetentionCeilings,
  type PanelUpdateStatus,
} from '@/api/settings';
import { useAuthStore } from '@/stores/auth';
import PageHeader from '@/components/PageHeader.vue';

const $q = useQuasar();
const auth = useAuthStore();

const settings = ref<SettingsResponseData | null>(null);
const defaultsForm = ref<ResourceDefaults | null>(null);
const defaultsBase = ref<ResourceDefaults | null>(null);
const savingDefaults = ref(false);
const restoringDefaults = ref(false);
const retentionForm = ref<BackupRetentionCeilings | null>(null);
const savingRetention = ref(false);
const panelUpdate = ref<PanelUpdateStatus | null>(null);
const checkingPanelUpdate = ref(false);
const cfKey = ref('');
const cfMasked = ref<string | null>(null);
const publicHost = ref('');
const startingPort = ref<number | null>(null);
const timezone = ref('');
const country = ref('');

const savingKey = ref(false);
const testingKey = ref(false);
const savingHost = ref(false);
const savingPort = ref(false);
const savingLoc = ref(false);

const defaultsCustomized = computed(() => {
  if (!defaultsForm.value || !defaultsBase.value) return false;
  const base = defaultsBase.value;
  return (Object.keys(base) as (keyof ResourceDefaults)[]).some(
    (k) => defaultsForm.value![k] !== base[k],
  );
});

async function load() {
  const [settingsRes, locRes, retentionRes] = await Promise.all([
    settingsApi.get(),
    settingsApi.localization(),
    settingsApi.getBackupRetention(),
  ]);
  settings.value = settingsRes;
  cfMasked.value = settingsRes.curseforge.masked;
  publicHost.value = settingsRes.publicHost;
  startingPort.value = settingsRes.startingPort ?? 25565;
  timezone.value = locRes.localization.timezone;
  country.value = locRes.localization.country;
  defaultsForm.value = { ...settingsRes.defaults };
  defaultsBase.value = { ...settingsRes.defaultsBase };
  retentionForm.value = { ...retentionRes.ceilings };

  if (auth.isAdmin) {
    try {
      const res = await settingsApi.getPanelUpdate();
      panelUpdate.value = res.update;
    } catch {
      // Admin-only route; ignore a transient failure here — "Check now" surfaces its own error.
    }
  }
}

function formatCheckedAt(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

async function checkPanelUpdate() {
  checkingPanelUpdate.value = true;
  try {
    const res = await settingsApi.getPanelUpdate(true);
    panelUpdate.value = res.update;
    if (res.update.error) {
      $q.notify({ type: 'warning', message: `Update check failed: ${res.update.error}` });
    } else if (res.update.updateAvailable) {
      $q.notify({ type: 'info', message: `Update available: ${res.update.latestVersion}` });
    } else {
      $q.notify({ type: 'positive', message: "You're running the latest stable release." });
    }
  } catch (err) {
    $q.notify({
      type: 'negative',
      message: err instanceof Error ? err.message : 'Update check failed.',
    });
  } finally {
    checkingPanelUpdate.value = false;
  }
}

async function saveBackupRetention() {
  if (!retentionForm.value) return;
  savingRetention.value = true;
  try {
    const res = await settingsApi.saveBackupRetention(retentionForm.value);
    retentionForm.value = { ...res.ceilings };
    $q.notify({ type: 'positive', message: 'Backup retention ceilings saved.' });
  } catch (err) {
    $q.notify({ type: 'negative', message: err instanceof Error ? err.message : 'Save failed.' });
  } finally {
    savingRetention.value = false;
  }
}

async function saveDefaults() {
  if (!defaultsForm.value) return;
  savingDefaults.value = true;
  try {
    const res = await settingsApi.saveDefaults(defaultsForm.value);
    defaultsForm.value = { ...res.defaults };
    $q.notify({ type: 'positive', message: 'Defaults for new servers saved.' });
  } catch (err) {
    $q.notify({ type: 'negative', message: err instanceof Error ? err.message : 'Save failed.' });
  } finally {
    savingDefaults.value = false;
  }
}

async function restoreDefaults() {
  restoringDefaults.value = true;
  try {
    const res = await settingsApi.restoreDefaults();
    defaultsForm.value = { ...res.defaults };
    $q.notify({ type: 'positive', message: 'Defaults restored to the built-in values.' });
  } catch (err) {
    $q.notify({
      type: 'negative',
      message: err instanceof Error ? err.message : 'Restore failed.',
    });
  } finally {
    restoringDefaults.value = false;
  }
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

async function saveStartingPort() {
  if (!startingPort.value || startingPort.value < 1024 || startingPort.value > 65535) {
    $q.notify({ type: 'negative', message: 'Starting port must be between 1024 and 65535.' });
    return;
  }
  savingPort.value = true;
  try {
    await settingsApi.saveStartingPort(startingPort.value);
    $q.notify({ type: 'positive', message: 'Starting port saved.' });
    await load();
  } catch (err) {
    $q.notify({ type: 'negative', message: err instanceof Error ? err.message : 'Save failed.' });
  } finally {
    savingPort.value = false;
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
