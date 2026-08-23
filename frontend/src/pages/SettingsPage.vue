<template>
  <q-page class="q-pa-md">
    <div class="text-h6 q-mb-md">Settings</div>

    <div class="row q-col-gutter-md q-mb-md">
      <div class="col-12 col-lg-6">
        <q-card flat bordered class="q-pa-md">
          <div class="text-subtitle1 q-mb-md">API keys</div>
          <div class="row q-gutter-sm items-start no-wrap">
            <q-input
              v-model="cfKey"
              class="col"
              type="password"
              outlined
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
          <p class="text-caption text-ink-faint q-mt-sm">
            Required for Auto-CurseForge packs and CF mod downloads. Stored encrypted at rest; new
            keys are live-tested before saving.
          </p>
          <p class="text-caption text-ink-faint q-mt-md">
            <strong>Modrinth</strong> — no key needed, its public API is used directly.
          </p>
        </q-card>
      </div>

      <div class="col-12 col-lg-6">
        <q-card flat bordered class="q-pa-md">
          <div class="text-subtitle1 q-mb-md">Panel</div>
          <div class="row q-gutter-sm items-start no-wrap">
            <q-input
              v-model="publicHost"
              class="col"
              outlined
              dense
              label="Public domain"
              placeholder="mc.example.com"
              autocomplete="off"
            />
            <q-btn label="Save domain" :loading="savingHost" @click="saveHost" />
          </div>
          <p class="text-caption text-ink-faint q-mt-sm">
            Shown to players instead of your IP in connect addresses. Leave blank to use the
            server's IP.
          </p>

          <div class="row q-col-gutter-sm q-mt-md">
            <div class="col-6">
              <q-input v-model="timezone" outlined dense label="Time zone" />
            </div>
            <div class="col-6">
              <q-input v-model="country" outlined dense label="Country" />
            </div>
          </div>
          <q-btn
            label="Save time zone"
            class="q-mt-sm"
            :loading="savingLoc"
            @click="saveLocalization"
          />
          <p class="text-caption text-ink-faint q-mt-sm">
            Controls how dates and player-activity times display across the panel.
          </p>

          <div class="row q-col-gutter-md q-mt-lg text-body2">
            <div class="col-6">
              <div class="text-caption text-ink-faint">Bind address</div>
              <div class="font-mono">{{ settings?.panel.host }}</div>
            </div>
            <div class="col-6">
              <div class="text-caption text-ink-faint">Port</div>
              <div class="font-mono">{{ settings?.panel.port }}</div>
            </div>
          </div>
          <p class="text-caption text-ink-faint q-mt-sm">
            Set via .env (PANEL_HOST / PANEL_PORT) — a restart applies changes.
          </p>

          <div class="text-subtitle1 q-mt-lg q-mb-sm">Defaults for new servers</div>
          <div v-if="settings" class="row q-col-gutter-md text-body2">
            <div class="col-6">
              <span class="text-caption text-ink-faint">Java heap</span>
              <div>{{ settings.defaults.heapMb }} MB</div>
            </div>
            <div class="col-6">
              <span class="text-caption text-ink-faint">Container limit</span>
              <div>{{ settings.defaults.containerMemoryMb }} MB</div>
            </div>
            <div class="col-6">
              <span class="text-caption text-ink-faint">Disk quota</span>
              <div>{{ settings.defaults.diskQuotaGb }} GB</div>
            </div>
            <div class="col-6">
              <span class="text-caption text-ink-faint">Quota warnings</span>
              <div>
                {{ settings.defaults.quotaWarnPct }}% / {{ settings.defaults.quotaCriticalPct }}%
              </div>
            </div>
          </div>
        </q-card>
      </div>
    </div>

    <q-card flat bordered>
      <q-card-section class="text-subtitle1">Users</q-card-section>
      <q-list separator>
        <q-item v-for="u in users" :key="u.id">
          <q-item-section>
            <div class="row items-center q-gutter-x-xs">
              <span>{{ u.username }}</span>
              <q-badge v-if="u.id === auth.user?.id" color="grey" label="you" />
            </div>
          </q-item-section>
          <q-item-section style="max-width: 140px">
            <q-select
              :model-value="u.role"
              dense
              outlined
              emit-value
              map-options
              :options="roleOptions"
              @update:model-value="(role: Role) => setRole(u, role)"
            />
          </q-item-section>
          <q-item-section>
            <q-badge v-if="u.totpEnabled" color="positive" label="2FA on" />
            <span v-else class="text-caption text-ink-faint">2FA off</span>
          </q-item-section>
          <q-item-section class="text-caption text-ink-faint">
            {{ new Date(u.createdAt).toLocaleDateString() }}
          </q-item-section>
          <q-item-section side>
            <div class="row q-gutter-x-xs">
              <q-btn flat dense round icon="key" @click="changePassword(u)">
                <q-tooltip>Set a new password</q-tooltip>
              </q-btn>
              <q-btn
                v-if="u.totpEnabled && u.id !== auth.user?.id"
                flat
                dense
                round
                icon="lock_reset"
                @click="resetTotp(u)"
              >
                <q-tooltip>Reset their 2FA</q-tooltip>
              </q-btn>
              <q-btn
                v-if="u.id !== auth.user?.id"
                flat
                dense
                round
                icon="delete"
                color="negative"
                @click="removeUser(u)"
              >
                <q-tooltip>Delete user</q-tooltip>
              </q-btn>
            </div>
          </q-item-section>
        </q-item>
      </q-list>
      <q-card-section>
        <q-btn flat icon="add" label="Add user" @click="addUserOpen = true" />
        <p class="text-caption text-ink-faint q-mt-sm">
          Roles: <strong>admin</strong> — everything; <strong>operator</strong> — manage servers but
          not storage, users, or update policies; <strong>viewer</strong> — read-only.
        </p>
      </q-card-section>
    </q-card>

    <q-dialog v-model="addUserOpen">
      <q-card style="min-width: 360px">
        <q-card-section class="text-subtitle1">Add user</q-card-section>
        <q-card-section class="q-gutter-md">
          <q-input v-model="newUser.username" label="Username" outlined dense />
          <q-input v-model="newUser.password" type="password" label="Password" outlined dense />
          <q-select
            v-model="newUser.role"
            :options="roleOptions"
            emit-value
            map-options
            outlined
            dense
            label="Role"
          />
        </q-card-section>
        <q-card-actions align="right">
          <q-btn flat label="Cancel" v-close-popup />
          <q-btn color="primary" label="Add" :loading="addingUser" @click="createUser" />
        </q-card-actions>
      </q-card>
    </q-dialog>
  </q-page>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useQuasar } from 'quasar';
import { settingsApi, type PanelUser, type SettingsResponseData } from '@/api/settings';
import type { Role } from '@/api/auth';
import { useAuthStore } from '@/stores/auth';

const $q = useQuasar();
const auth = useAuthStore();

const settings = ref<SettingsResponseData | null>(null);
const cfKey = ref('');
const cfMasked = ref<string | null>(null);
const publicHost = ref('');
const timezone = ref('');
const country = ref('');
const users = ref<PanelUser[]>([]);

const savingKey = ref(false);
const testingKey = ref(false);
const savingHost = ref(false);
const savingLoc = ref(false);
const addUserOpen = ref(false);
const addingUser = ref(false);
const newUser = ref<{ username: string; password: string; role: Role }>({
  username: '',
  password: '',
  role: 'operator',
});

const roleOptions: { label: string; value: Role }[] = [
  { label: 'admin', value: 'admin' },
  { label: 'operator', value: 'operator' },
  { label: 'viewer', value: 'viewer' },
];

async function load() {
  const [settingsRes, locRes, usersRes] = await Promise.all([
    settingsApi.get(),
    settingsApi.localization(),
    settingsApi.users(),
  ]);
  settings.value = settingsRes;
  cfMasked.value = settingsRes.curseforge.masked;
  publicHost.value = settingsRes.publicHost;
  timezone.value = locRes.localization.timezone;
  country.value = locRes.localization.country;
  users.value = usersRes.users;
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

async function setRole(user: PanelUser, role: Role) {
  await settingsApi.setUserRole(user.id, role);
  await load();
}

function changePassword(user: PanelUser) {
  $q.dialog({
    title: `Set a new password — ${user.username}`,
    prompt: { model: '', type: 'password', isValid: (v: string) => v.length >= 8 },
    cancel: true,
  }).onOk((password: string) => {
    void settingsApi.setUserPassword(user.id, password).then(() => {
      $q.notify({ type: 'positive', message: 'Password updated.' });
    });
  });
}

function resetTotp(user: PanelUser) {
  $q.dialog({
    title: `Reset 2FA for ${user.username}?`,
    message: 'They will need to re-enroll from scratch.',
    cancel: true,
    ok: { color: 'negative', label: 'Reset' },
  }).onOk(() => {
    void settingsApi.resetUserTotp(user.id).then(load);
  });
}

function removeUser(user: PanelUser) {
  $q.dialog({
    title: `Delete ${user.username}?`,
    message: 'This cannot be undone.',
    cancel: true,
    ok: { color: 'negative', label: 'Delete' },
  }).onOk(() => {
    void settingsApi.deleteUser(user.id).then(load);
  });
}

async function createUser() {
  if (!newUser.value.username.trim() || newUser.value.password.length < 8) {
    $q.notify({ type: 'negative', message: 'Username and an 8+ character password are required.' });
    return;
  }
  addingUser.value = true;
  try {
    await settingsApi.createUser(
      newUser.value.username.trim(),
      newUser.value.password,
      newUser.value.role,
    );
    addUserOpen.value = false;
    newUser.value = { username: '', password: '', role: 'operator' };
    await load();
  } catch (err) {
    $q.notify({
      type: 'negative',
      message: err instanceof Error ? err.message : 'Could not add user.',
    });
  } finally {
    addingUser.value = false;
  }
}

onMounted(load);
</script>
