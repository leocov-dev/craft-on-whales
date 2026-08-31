<template>
  <q-page class="q-pa-md">
    <PageHeader title="Users" icon="group" />

    <q-card flat bordered>
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
              filled
              emit-value
              map-options
              :options="roleOptions"
              @update:model-value="(role: Role) => setRole(u, role)"
            />
          </q-item-section>
          <q-item-section>
            <q-badge v-if="u.totpEnabled" color="positive" label="2FA on" />
            <q-item-label v-else caption>2FA off</q-item-label>
          </q-item-section>
          <q-item-section>
            <q-item-label caption>{{ new Date(u.createdAt).toLocaleDateString() }}</q-item-label>
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
        <q-item-label caption class="q-mt-sm">
          Roles: <strong>admin</strong> — everything; <strong>operator</strong> — manage servers but
          not storage, users, or update policies; <strong>viewer</strong> — read-only.
        </q-item-label>
      </q-card-section>
    </q-card>

    <q-dialog v-model="addUserOpen">
      <q-card style="min-width: 360px">
        <q-card-section class="text-subtitle1">Add user</q-card-section>
        <q-card-section class="q-gutter-md">
          <q-input v-model="newUser.username" label="Username" filled dense />
          <q-input v-model="newUser.password" type="password" label="Password" filled dense />
          <q-select
            v-model="newUser.role"
            :options="roleOptions"
            emit-value
            map-options
            filled
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
import { settingsApi, type PanelUser } from '@/api/settings';
import type { Role } from '@/api/auth';
import { useAuthStore } from '@/stores/auth';
import PageHeader from '@/components/PageHeader.vue';

const $q = useQuasar();
const auth = useAuthStore();

const users = ref<PanelUser[]>([]);

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
  const usersRes = await settingsApi.users();
  users.value = usersRes.users;
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
