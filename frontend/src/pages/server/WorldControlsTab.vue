<template>
  <div v-if="loading">
    <q-spinner color="primary" />
  </div>
  <q-banner v-else-if="!running" rounded>
    <template #avatar>
      <q-icon name="info" color="primary" />
    </template>
    World controls need a running server — start it to read or change time, weather, and gamerules.
  </q-banner>

  <div v-else-if="state">
    <q-card flat bordered class="q-pa-md q-mb-md">
      <div class="text-subtitle1 q-mb-sm">Quick actions</div>
      <div class="row q-col-gutter-md">
        <div class="col-12 col-md-6">
          <q-item-label caption>Time</q-item-label>
          <q-item-label class="q-mb-xs"
            >{{ state.timeLabel ?? '—' }} ({{ state.clock ?? '—' }})</q-item-label
          >
          <div class="row q-gutter-xs">
            <q-btn dense outline label="Day" :disable="!canWrite" @click="run('time-day')" />
            <q-btn dense outline label="Noon" :disable="!canWrite" @click="run('time-noon')" />
            <q-btn dense outline label="Night" :disable="!canWrite" @click="run('time-night')" />
            <q-btn
              dense
              outline
              label="Midnight"
              :disable="!canWrite"
              @click="run('time-midnight')"
            />
          </div>
        </div>

        <div class="col-12 col-md-6">
          <q-item-label caption>Weather</q-item-label>
          <div class="row q-gutter-xs q-mt-md">
            <q-btn dense outline label="Clear" :disable="!canWrite" @click="run('weather-clear')" />
            <q-btn dense outline label="Rain" :disable="!canWrite" @click="run('weather-rain')" />
            <q-btn
              dense
              outline
              label="Thunder"
              :disable="!canWrite"
              @click="run('weather-thunder')"
            />
          </div>
        </div>

        <div class="col-12 col-md-6">
          <q-item-label caption>Difficulty</q-item-label>
          <div class="row q-gutter-xs q-mt-md">
            <q-btn
              dense
              outline
              label="Peaceful"
              :disable="!canWrite"
              @click="run('difficulty-peaceful')"
            />
            <q-btn
              dense
              outline
              label="Easy"
              :disable="!canWrite"
              @click="run('difficulty-easy')"
            />
            <q-btn
              dense
              outline
              label="Normal"
              :disable="!canWrite"
              @click="run('difficulty-normal')"
            />
            <q-btn
              dense
              outline
              label="Hard"
              :disable="!canWrite"
              @click="run('difficulty-hard')"
            />
          </div>
        </div>

        <div class="col-12 col-md-6">
          <q-item-label caption>PvP &amp; saving</q-item-label>
          <div class="row items-center q-gutter-md q-mt-xs">
            <q-toggle
              :model-value="state.pvp"
              label="PvP"
              :disable="!canWrite"
              @update:model-value="(v: boolean) => run(v ? 'pvp-on' : 'pvp-off')"
            />
            <q-btn
              dense
              outline
              icon="save"
              label="Save world"
              :disable="!canWrite"
              @click="run('save-all')"
            />
          </div>
        </div>
      </div>
    </q-card>

    <q-card flat bordered>
      <q-list separator>
        <q-expansion-item
          v-for="group in GAMERULE_GROUPS"
          :key="group.title"
          :label="group.title"
          :default-opened="group.title === 'World rules'"
        >
          <q-list separator>
            <q-item v-for="key in group.keys" :key="key">
              <q-item-section>
                <q-item-label>{{ ruleLabel(key) }}</q-item-label>
                <q-item-label v-if="!ruleSupported(key) || !ruleQuickAction(key)" caption>
                  <template v-if="!ruleSupported(key)"
                    >Not supported on this server version.</template
                  >
                  <template v-else
                    >Read-only — no quick action wired up for this rule yet.</template
                  >
                </q-item-label>
              </q-item-section>
              <q-item-section side>
                <q-toggle
                  v-if="ruleSupported(key)"
                  :model-value="!!state[key]"
                  :disable="!canWrite || !ruleQuickAction(key)"
                  @update:model-value="(v: boolean) => toggleRule(key, v)"
                />
                <q-icon v-else name="block" color="grey" size="24px" />
              </q-item-section>
            </q-item>
          </q-list>
        </q-expansion-item>
      </q-list>
    </q-card>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useQuasar } from 'quasar';
import { worldControlsApi, type WorldState, type GameruleKey } from '@/api/worldControls';
import { useServerDetail } from '@/composables/useServerDetail';
import { useAuthStore } from '@/stores/auth';

const $q = useQuasar();
const { server } = useServerDetail();
const auth = useAuthStore();

// Console-gated ('console' server capability, backend-enforced) — same
// precedent as ConsoleTab.vue's canRunCommands: disable the controls for a
// role that can't run them rather than hiding the tab, and let a 403 from a
// stale/desynced role surface as a normal error toast.
const canWrite = auth.canWrite;

const loading = ref(true);
const running = ref(false);
const state = ref<WorldState | null>(null);

// Grouped exactly the way world-controls.types.ts's GameruleKey comments
// group them, so this table reads the same as the backend's own doc split.
const GAMERULE_GROUPS: { title: string; keys: GameruleKey[] }[] = [
  {
    title: 'World rules',
    keys: [
      'keepInventory',
      'doDaylightCycle',
      'doWeatherCycle',
      'doImmediateRespawn',
      'doLimitedCrafting',
      'doTileDrops',
      'doEntityDrops',
      'doFireTick',
      'allowFireTicksAwayFromPlayer',
      'doVinesSpread',
      'waterSourceConversion',
      'lavaSourceConversion',
      'tntExplodes',
      'projectilesCanBreakBlocks',
      'blockExplosionDropDecay',
      'mobExplosionDropDecay',
      'tntExplosionDropDecay',
      'enderPearlsVanishOnDeath',
      'globalSoundEvents',
      'spectatorsGenerateChunks',
      'reducedDebugInfo',
      'disableElytraMovementCheck',
      'locatorBar',
    ],
  },
  {
    title: 'Mobs & damage',
    keys: [
      'doMobSpawning',
      'mobGriefing',
      'doInsomnia',
      'doMobLoot',
      'doPatrolSpawning',
      'doTraderSpawning',
      'doWardenSpawning',
      'disableRaids',
      'forgiveDeadPlayers',
      'universalAnger',
      'naturalRegeneration',
      'fallDamage',
      'fireDamage',
      'drowningDamage',
      'freezeDamage',
    ],
  },
  {
    title: 'Chat & messages',
    keys: [
      'showDeathMessages',
      'announceAdvancements',
      'sendCommandFeedback',
      'commandBlockOutput',
      'logAdminCommands',
    ],
  },
];

// Only the gamerules QUICK_ACTIONS (backend/src/world-controls/world-controls.constants.ts)
// actually curates an on/off pair for. Every other gamerule in the 43-key
// union is display-only here — this UI only ever calls the existing `quick`
// endpoint, never a raw-gamerule-set path.
const RULE_QUICK_ACTIONS: Partial<Record<GameruleKey, { on: string; off: string }>> = {
  keepInventory: { on: 'keepinv-on', off: 'keepinv-off' },
  doDaylightCycle: { on: 'daycycle-on', off: 'daycycle-off' },
  doWeatherCycle: { on: 'weathercycle-on', off: 'weathercycle-off' },
  mobGriefing: { on: 'mobgrief-on', off: 'mobgrief-off' },
  doMobSpawning: { on: 'mobspawn-on', off: 'mobspawn-off' },
  doFireTick: { on: 'firetick-on', off: 'firetick-off' },
  fallDamage: { on: 'falldmg-on', off: 'falldmg-off' },
  naturalRegeneration: { on: 'naturalregen-on', off: 'naturalregen-off' },
  doInsomnia: { on: 'phantoms-on', off: 'phantoms-off' },
  doImmediateRespawn: { on: 'instantrespawn-on', off: 'instantrespawn-off' },
};

function ruleQuickAction(key: GameruleKey) {
  return RULE_QUICK_ACTIONS[key];
}

// A gamerule the server doesn't recognize on its MC version is simply absent
// from `state` (see getState() in world-controls.service.ts) — never `false`.
// That's a distinct "unsupported" case from an explicit off, so it renders
// disabled rather than as an unchecked toggle.
function ruleSupported(key: GameruleKey): boolean {
  return typeof state.value?.[key] === 'boolean';
}

function ruleLabel(key: string): string {
  return key.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
}

async function load() {
  if (!server.value) return;
  loading.value = true;
  try {
    const res = await worldControlsApi.state(server.value.id);
    running.value = res.running;
    state.value = res.state;
  } finally {
    loading.value = false;
  }
}

async function run(action: string) {
  if (!server.value) return;
  try {
    const res = await worldControlsApi.quick(server.value.id, action);
    $q.notify({ type: 'positive', message: res.label });
    await load();
  } catch (err) {
    $q.notify({ type: 'negative', message: err instanceof Error ? err.message : 'Action failed.' });
  }
}

function toggleRule(key: GameruleKey, value: boolean) {
  const pair = ruleQuickAction(key);
  if (!pair) return;
  void run(value ? pair.on : pair.off);
}

onMounted(load);
</script>
