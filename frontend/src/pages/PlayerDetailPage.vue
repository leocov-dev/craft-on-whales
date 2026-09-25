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
          <q-item-label caption :style="player.online ? { color: 'var(--q-positive)' } : undefined">
            {{ player.online ? 'Online' : 'Offline' }}
          </q-item-label>
        </div>
        <q-badge v-if="player.op" color="warning" label="op" />
        <q-badge v-if="player.banned" color="negative" label="banned" />
      </div>

      <div class="row q-col-gutter-md">
        <div class="col-12 col-md-6">
          <q-card flat bordered class="q-pa-md">
            <div class="q-gutter-md">
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
                <template v-if="player.banExpires"> · expires {{ player.banExpires }}</template>
              </div>
              <div class="row q-gutter-sm">
                <q-btn v-if="player.online" dense outline label="Kick" @click="kickPlayer" />
                <q-btn
                  v-if="!player.banned"
                  dense
                  outline
                  color="negative"
                  label="Ban"
                  @click="banDialogOpen = true"
                />
                <q-btn v-else dense outline label="Pardon" @click="pardonPlayer" />
                <q-btn dense outline label="Notes" @click="notesDialogOpen = true" />
                <q-btn
                  v-if="auth.canWrite && !player.online"
                  dense
                  outline
                  color="negative"
                  label="Delete Player…"
                  @click="deletePlayer"
                />
              </div>
            </div>
          </q-card>
        </div>

        <div class="col-12 col-md-6">
          <q-card flat bordered class="q-pa-md">
            <div class="text-subtitle1 q-mb-sm">Details</div>
            <div class="row q-col-gutter-md text-body2">
              <div class="col-6">
                <q-item-label caption>UUID</q-item-label>
                <div class="font-mono" style="font-size: 11px">{{ player.uuid ?? '—' }}</div>
              </div>
              <div class="col-6">
                <q-item-label caption>Last seen</q-item-label>
                <div>{{ player.lastSeen ?? '—' }}</div>
              </div>
            </div>
          </q-card>
        </div>
      </div>
    </template>

    <PlayerBanDialog
      v-model="banDialogOpen"
      :server-id="serverId"
      :player-name="playerName"
      @banned="load"
    />
    <PlayerNotesDialog v-model="notesDialogOpen" :server-id="serverId" :player-name="playerName" />
  </q-page>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useQuasar } from 'quasar';
import { playersApi, type PlayerListEntry } from '@/api/players';
import { useAuthStore } from '@/stores/auth';
import PlayerBanDialog from '@/components/PlayerBanDialog.vue';
import PlayerNotesDialog from '@/components/PlayerNotesDialog.vue';

const route = useRoute();
const router = useRouter();
const $q = useQuasar();
const auth = useAuthStore();

const serverId = String(route.params.id);
const playerName = String(route.params.name);
const player = ref<PlayerListEntry | null>(null);
const banDialogOpen = ref(false);
const notesDialogOpen = ref(false);

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
    banExpires: null,
    lastSeen: null,
    lastKnownIp: null,
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
function pardonPlayer() {
  void playersApi.pardon(serverId, playerName).then(load);
}

function deletePlayer() {
  $q.dialog({
    title: `Delete ${playerName}?`,
    message:
      'This permanently removes them from the whitelist, operators and bans, and deletes their saved inventory snapshots and moderator notes. This cannot be undone.',
    cancel: true,
    ok: { color: 'negative', label: 'Delete' },
  }).onOk(() => {
    void playersApi
      .deletePlayer(serverId, playerName)
      .then(() => {
        $q.notify({ type: 'positive', message: `${playerName} deleted.` });
        void router.push(`/servers/${serverId}/players`);
      })
      .catch((err: unknown) => {
        $q.notify({
          type: 'negative',
          message: err instanceof Error ? err.message : 'Delete failed.',
        });
      });
  });
}

onMounted(load);
</script>
