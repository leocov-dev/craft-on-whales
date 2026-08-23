<template>
  <q-page class="q-pa-md">
    <div v-if="!player" class="row justify-center q-pa-xl">
      <q-spinner color="primary" size="32px" />
    </div>
    <template v-else>
      <div class="row items-center q-gutter-x-sm q-mb-md">
        <q-icon name="person" size="32px" />
        <div>
          <div class="text-h6">{{ player.name }}</div>
          <div class="text-caption" :class="player.online ? 'text-positive' : 'text-ink-faint'">
            {{ player.online ? 'Online' : 'Offline' }}
          </div>
        </div>
        <q-badge v-if="player.op" color="warning" label="op" />
        <q-badge v-if="player.banned" color="negative" label="banned" />
      </div>

      <div class="row q-col-gutter-md">
        <div class="col-12 col-md-6">
          <q-card flat bordered class="q-pa-md q-gutter-md">
            <div class="text-subtitle1">Access</div>
            <q-toggle
              :model-value="player.whitelisted"
              label="Whitelisted"
              @update:model-value="(v: boolean) => toggleWhitelist(v)"
            />
            <q-toggle
              :model-value="player.op"
              label="Operator"
              @update:model-value="(v: boolean) => toggleOp(v)"
            />
            <div v-if="player.banned" class="text-caption text-negative">
              Banned{{ player.banReason ? `: ${player.banReason}` : '' }}
            </div>
            <div class="row q-gutter-sm">
              <q-btn v-if="player.online" dense outline label="Kick" @click="kickPlayer" />
              <q-btn
                v-if="!player.banned"
                dense
                outline
                color="negative"
                label="Ban"
                @click="banPlayer"
              />
              <q-btn v-else dense outline label="Pardon" @click="pardonPlayer" />
            </div>
          </q-card>
        </div>

        <div class="col-12 col-md-6">
          <q-card flat bordered class="q-pa-md">
            <div class="text-subtitle1 q-mb-sm">Details</div>
            <div class="row q-col-gutter-md text-body2">
              <div class="col-6">
                <div class="text-caption text-ink-faint">UUID</div>
                <div class="font-mono" style="font-size: 11px">{{ player.uuid ?? '—' }}</div>
              </div>
              <div class="col-6">
                <div class="text-caption text-ink-faint">Last seen</div>
                <div>{{ player.lastSeen ?? '—' }}</div>
              </div>
            </div>
          </q-card>
        </div>
      </div>
    </template>
  </q-page>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import { useQuasar } from 'quasar';
import { playersApi, type PlayerListEntry } from '@/api/players';

const route = useRoute();
const $q = useQuasar();

const serverId = String(route.params.id);
const playerName = String(route.params.name);
const player = ref<PlayerListEntry | null>(null);

async function load() {
  const res = await playersApi.list(serverId);
  player.value = res.players.find((p) => p.name.toLowerCase() === playerName.toLowerCase()) ?? {
    name: playerName,
    bedrock: false,
    uuid: null,
    online: false,
    whitelisted: false,
    op: false,
    opLevel: null,
    bypassesPlayerLimit: false,
    banned: false,
    banReason: null,
    banDate: null,
    banSource: null,
    lastSeen: null,
  };
}

async function toggleWhitelist(v: boolean) {
  await playersApi.setWhitelist(serverId, playerName, v);
  await load();
}
async function toggleOp(v: boolean) {
  await playersApi.setOp(serverId, playerName, v);
  await load();
}
function kickPlayer() {
  void playersApi
    .kick(serverId, playerName)
    .then(load)
    .catch((err: unknown) => {
      $q.notify({ type: 'negative', message: err instanceof Error ? err.message : 'Kick failed.' });
    });
}
function banPlayer() {
  $q.dialog({
    title: `Ban ${playerName}?`,
    prompt: { model: '', type: 'text', label: 'Reason (optional)' },
    cancel: true,
    ok: { color: 'negative', label: 'Ban' },
  }).onOk((reason: string) => {
    void playersApi.ban(serverId, playerName, reason || undefined).then(load);
  });
}
function pardonPlayer() {
  void playersApi.pardon(serverId, playerName).then(load);
}

onMounted(load);
</script>
