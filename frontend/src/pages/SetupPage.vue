<template>
  <q-card class="col-12" style="max-width: 720px">
    <q-stepper v-model="step" flat animated color="primary">
      <q-step :name="1" title="Welcome" icon="waving_hand">
        <div class="text-center q-mb-md">
          <div class="text-h6">Welcome to Craft on Whales</div>
          <q-item-label caption class="q-mt-sm">
            Guided setup: we'll check your system and create your admin account.
          </q-item-label>
        </div>
        <q-btn
          color="primary"
          label="Get started"
          icon-right="arrow_forward"
          class="full-width"
          @click="startChecks"
        />
      </q-step>

      <q-step :name="2" title="System check" icon="fact_check">
        <div v-if="checksLoading" class="row items-center q-gutter-sm">
          <q-spinner color="primary" size="20px" />
          <q-item-label caption>Running checks…</q-item-label>
        </div>
        <template v-else-if="checks">
          <q-banner :class="`bg-${overallColor} text-white q-mb-md`" rounded dense>
            <template #avatar>
              <q-icon :name="overallIcon" />
            </template>
            {{ overallText }}
          </q-banner>
          <q-list separator>
            <q-item v-for="row in checkRows" :key="row.label">
              <q-item-section avatar>
                <q-icon :name="levelIcon(row.level)" :color="levelColor(row.level)" />
              </q-item-section>
              <q-item-section>
                <q-item-label>{{ row.label }}</q-item-label>
                <q-item-label caption>{{ row.detail }}</q-item-label>
              </q-item-section>
            </q-item>
          </q-list>
        </template>
        <div class="row q-gutter-sm q-mt-md">
          <q-btn flat label="Back" icon="arrow_back" @click="step = 1" />
          <q-btn flat label="Re-check" icon="refresh" @click="loadChecks" />
          <q-space />
          <q-btn
            color="primary"
            label="Continue"
            icon-right="arrow_forward"
            :disable="overallLevel === 'fail'"
            @click="step = 3"
          />
        </div>
      </q-step>

      <q-step :name="3" title="Create admin" icon="shield">
        <q-banner v-if="error" class="bg-negative text-white q-mb-md" dense rounded>
          {{ error }}
        </q-banner>
        <q-form class="q-gutter-md" @submit="createAdmin">
          <q-input
            v-model="username"
            label="Username"
            autocomplete="username"
            :rules="[(v) => (v.length >= 2 && v.length <= 32) || '2–32 characters']"
          />
          <q-input
            v-model="password"
            label="Password"
            type="password"
            autocomplete="new-password"
            hint="At least 8 characters."
            :rules="[(v) => v.length >= 8 || 'At least 8 characters']"
          />
          <div class="row q-gutter-sm">
            <q-btn flat label="Back" icon="arrow_back" @click="step = 2" />
            <q-space />
            <q-btn
              type="submit"
              color="primary"
              label="Create admin"
              icon="shield"
              :loading="loading"
            />
          </div>
        </q-form>
      </q-step>

      <q-step :name="4" title="Done" icon="celebration">
        <div class="column items-center text-center q-gutter-sm">
          <q-icon name="celebration" color="positive" size="48px" />
          <div class="text-subtitle1">You're all set!</div>
          <q-item-label caption>
            Craft on Whales is ready. Spin up your first Minecraft server whenever you like.
          </q-item-label>
        </div>
        <div class="column q-gutter-sm q-mt-md">
          <q-btn color="primary" label="Create your first server" icon="add" to="/servers/new" />
          <q-btn flat label="Go to the dashboard" to="/" />
        </div>
      </q-step>
    </q-stepper>
  </q-card>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import { authApi, type SetupChecks, type SetupCheckLevel } from '@/api/auth';
import { ApiError } from '@/api/http';
import { useAuthStore } from '@/stores/auth';

const auth = useAuthStore();

const step = ref(1);
const checks = ref<SetupChecks | null>(null);
const checksLoading = ref(false);
const username = ref('');
const password = ref('');
const loading = ref(false);
const error = ref('');

async function loadChecks() {
  checksLoading.value = true;
  try {
    const { checks: c } = await authApi.setupChecks();
    checks.value = c;
  } finally {
    checksLoading.value = false;
  }
}

function startChecks() {
  step.value = 2;
  void loadChecks();
}

const checkRows = computed(() => {
  const c = checks.value;
  if (!c) return [];
  return [
    {
      label: 'Docker',
      detail: c.docker.available
        ? `Connected (v${c.docker.version ?? '?'})`
        : (c.docker.error ?? 'Not reachable — you can still explore the panel'),
      level: c.docker.level,
    },
    {
      label: 'Node.js',
      detail: `v${c.node.version} (requires ${c.node.required}+)`,
      level: c.node.level,
    },
    { label: 'Data directory', detail: c.dataDir.path, level: c.dataDir.level },
    {
      label: 'Session secret',
      detail: c.sessionSecret.weak ? 'Set, but weak — consider rotating it' : 'Set',
      level: c.sessionSecret.level,
    },
  ];
});

const overallLevel = computed<SetupCheckLevel>(() => {
  const levels = checkRows.value.map((row) => row.level);
  if (levels.includes('fail')) return 'fail';
  if (levels.includes('warn')) return 'warn';
  return 'pass';
});

const overallIcon = computed(() =>
  overallLevel.value === 'pass'
    ? 'check_circle'
    : overallLevel.value === 'warn'
      ? 'warning'
      : 'block',
);
const overallColor = computed(() =>
  overallLevel.value === 'pass' ? 'positive' : overallLevel.value === 'warn' ? 'warning' : 'negative',
);
const overallText = computed(() =>
  overallLevel.value === 'pass'
    ? "You're good to go."
    : overallLevel.value === 'warn'
      ? 'You can continue, but review the warnings below.'
      : "Can't continue until this is fixed.",
);

function levelIcon(level: SetupCheckLevel) {
  return level === 'pass' ? 'check_circle' : level === 'warn' ? 'warning' : 'error';
}
function levelColor(level: SetupCheckLevel) {
  return level === 'pass' ? 'positive' : level === 'warn' ? 'warning' : 'negative';
}

async function createAdmin() {
  loading.value = true;
  error.value = '';
  try {
    await auth.setup(username.value, password.value);
    step.value = 4;
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : 'Something went wrong.';
  } finally {
    loading.value = false;
  }
}
</script>
