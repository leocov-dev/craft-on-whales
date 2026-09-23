<template>
  <div>
    <div class="row items-center q-mb-md">
      <q-toggle
        :model-value="whitelistEnforced"
        label="Enforce whitelist"
        @update:model-value="setEnforced"
      />
      <q-space />
      <div v-if="!running" class="text-caption text-warning">
        Server is stopped — actions are limited.
      </div>
    </div>

    <q-card flat bordered>
      <q-list separator>
        <q-item v-for="p in players" :key="p.name">
          <q-item-section avatar>
            <q-icon
              :name="p.online ? 'circle' : 'radio_button_unchecked'"
              :color="p.online ? 'positive' : 'grey'"
              size="12px"
            />
          </q-item-section>
          <q-item-section>
            <q-item-label>
              {{ p.name }}
              <q-badge v-if="p.op" color="warning" label="op" class="q-ml-xs" />
              <q-badge v-if="p.banned" color="negative" label="banned" class="q-ml-xs" />
            </q-item-label>
            <q-item-label caption>
              {{ p.whitelisted ? 'Whitelisted' : 'Not whitelisted' }}
              <template v-if="p.banReason"> · {{ p.banReason }}</template>
              <template v-if="p.banExpires"> · expires {{ p.banExpires }}</template>
            </q-item-label>
          </q-item-section>
          <q-item-section side>
            <div class="row q-gutter-x-xs items-center">
              <q-toggle
                :model-value="p.whitelisted"
                dense
                @update:model-value="(v: boolean) => toggleWhitelist(p, v)"
                label="WL"
              />
              <q-toggle
                :model-value="p.op"
                dense
                @update:model-value="(v: boolean) => toggleOp(p, v)"
                label="OP"
              />
              <q-btn v-if="p.online" dense flat label="Kick" @click="kickPlayer(p)" />
              <q-btn
                v-if="!p.banned"
                dense
                flat
                label="Ban"
                color="negative"
                @click="openBanDialog(p)"
              />
              <q-btn v-else dense flat label="Pardon" @click="pardonPlayer(p)" />
              <q-btn v-if="auth.canWrite" dense flat icon="more_vert">
                <q-menu>
                  <q-list>
                    <q-item clickable v-close-popup @click="openNotesDialog(p)">
                      <q-item-section avatar><q-icon name="sticky_note_2" /></q-item-section>
                      <q-item-section>Moderator Notes…</q-item-section>
                    </q-item>
                    <q-item
                      v-if="!p.online"
                      clickable
                      v-close-popup
                      class="text-negative"
                      @click="deletePlayer(p)"
                    >
                      <q-item-section avatar><q-icon name="delete_forever" /></q-item-section>
                      <q-item-section>Delete Player…</q-item-section>
                    </q-item>
                  </q-list>
                </q-menu>
              </q-btn>
            </div>
          </q-item-section>
        </q-item>
        <q-item v-if="players.length === 0">
          <q-item-section class="text-center">
            <q-item-label caption>No players have connected yet.</q-item-label>
          </q-item-section>
        </q-item>
      </q-list>
    </q-card>

    <div v-if="bannedIps.length" class="q-mt-md">
      <div class="text-subtitle1 q-mb-sm">Banned IPs</div>
      <q-card flat bordered>
        <q-list separator>
          <q-item v-for="ip in bannedIps" :key="ip.ip">
            <q-item-section class="font-mono">{{ ip.ip }}</q-item-section>
            <q-item-section side class="text-caption">{{ ip.player ?? '—' }}</q-item-section>
            <q-item-section side class="text-caption">{{ ip.reason ?? '—' }}</q-item-section>
            <q-item-section side class="text-caption">
              {{ ip.expires && ip.expires !== 'forever' ? `expires ${ip.expires}` : 'permanent' }}
            </q-item-section>
            <q-item-section side>
              <q-btn dense flat label="Pardon" @click="pardonIpAddr(ip)" />
            </q-item-section>
          </q-item>
        </q-list>
      </q-card>
    </div>

    <PlayerBanDialog
      v-model="banDialogOpen"
      :server-id="server?.id ?? ''"
      :player-name="banTarget?.name ?? ''"
      @banned="load"
    />
    <PlayerNotesDialog
      v-model="notesDialogOpen"
      :server-id="server?.id ?? ''"
      :player-name="notesTarget?.name ?? ''"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useQuasar } from 'quasar';
import { playersApi, type PlayerListEntry, type BannedIpEntry } from '@/api/players';
import { useServerDetail } from '@/composables/useServerDetail';
import { useAuthStore } from '@/stores/auth';
import PlayerBanDialog from '@/components/PlayerBanDialog.vue';
import PlayerNotesDialog from '@/components/PlayerNotesDialog.vue';

const $q = useQuasar();
const auth = useAuthStore();
const { server } = useServerDetail();

const players = ref<PlayerListEntry[]>([]);
const bannedIps = ref<BannedIpEntry[]>([]);
const whitelistEnforced = ref(false);
const running = ref(false);

const banDialogOpen = ref(false);
const banTarget = ref<PlayerListEntry | null>(null);
const notesDialogOpen = ref(false);
const notesTarget = ref<PlayerListEntry | null>(null);

async function load() {
  if (!server.value) return;
  const res = await playersApi.list(server.value.id);
  players.value = res.players;
  bannedIps.value = res.bannedIps;
  whitelistEnforced.value = res.whitelistEnforced;
  running.value = res.running;
}

async function setEnforced(v: boolean) {
  if (!server.value) return;
  await playersApi.setWhitelistEnforced(server.value.id, v);
  await load();
}

async function toggleWhitelist(p: PlayerListEntry, v: boolean) {
  if (!server.value) return;
  await playersApi.setWhitelist(server.value.id, p.name, v);
  await load();
}

async function toggleOp(p: PlayerListEntry, v: boolean) {
  if (!server.value) return;
  await playersApi.setOp(server.value.id, p.name, v);
  await load();
}

function kickPlayer(p: PlayerListEntry) {
  if (!server.value) return;
  void playersApi
    .kick(server.value.id, p.name)
    .then(load)
    .catch((err: unknown) => {
      $q.notify({ type: 'negative', message: err instanceof Error ? err.message : 'Kick failed.' });
    });
}

function openBanDialog(p: PlayerListEntry) {
  banTarget.value = p;
  banDialogOpen.value = true;
}

function pardonPlayer(p: PlayerListEntry) {
  if (!server.value) return;
  void playersApi.pardon(server.value.id, p.name).then(load);
}

function pardonIpAddr(ip: BannedIpEntry) {
  if (!server.value) return;
  void playersApi.pardonIp(server.value.id, ip.ip).then(load);
}

function openNotesDialog(p: PlayerListEntry) {
  notesTarget.value = p;
  notesDialogOpen.value = true;
}

function deletePlayer(p: PlayerListEntry) {
  if (!server.value) return;
  const sid = server.value.id;
  $q.dialog({
    title: `Delete ${p.name}?`,
    message:
      'This permanently removes them from the whitelist, operators and bans, and deletes their saved inventory snapshots and moderator notes. This cannot be undone.',
    cancel: true,
    ok: { color: 'negative', label: 'Delete' },
  }).onOk(() => {
    void playersApi
      .deletePlayer(sid, p.name)
      .then(load)
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
