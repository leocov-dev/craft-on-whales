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
            <q-item-label caption
              >{{ p.whitelisted ? 'Whitelisted' : 'Not whitelisted'
              }}<template v-if="p.banReason"> · {{ p.banReason }}</template></q-item-label
            >
          </q-item-section>
          <q-item-section side>
            <div class="row q-gutter-x-xs">
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
                @click="banPlayer(p)"
              />
              <q-btn v-else dense flat label="Pardon" @click="pardonPlayer(p)" />
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
            <q-item-section side class="text-caption">{{ ip.reason ?? '—' }}</q-item-section>
            <q-item-section side>
              <q-btn dense flat label="Pardon" @click="pardonIpAddr(ip)" />
            </q-item-section>
          </q-item>
        </q-list>
      </q-card>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useQuasar } from 'quasar';
import { playersApi, type PlayerListEntry, type BannedIpEntry } from '@/api/players';
import { useServerDetail } from '@/composables/useServerDetail';

const $q = useQuasar();
const { server } = useServerDetail();

const players = ref<PlayerListEntry[]>([]);
const bannedIps = ref<BannedIpEntry[]>([]);
const whitelistEnforced = ref(false);
const running = ref(false);

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

function banPlayer(p: PlayerListEntry) {
  if (!server.value) return;
  $q.dialog({
    title: `Ban ${p.name}?`,
    prompt: { model: '', type: 'text', label: 'Reason (optional)' },
    cancel: true,
    ok: { color: 'negative', label: 'Ban' },
  }).onOk((reason: string) => {
    void playersApi.ban(server.value!.id, p.name, reason || undefined).then(load);
  });
}

function pardonPlayer(p: PlayerListEntry) {
  if (!server.value) return;
  void playersApi.pardon(server.value.id, p.name).then(load);
}

function pardonIpAddr(ip: BannedIpEntry) {
  if (!server.value) return;
  void playersApi.pardonIp(server.value.id, ip.ip).then(load);
}

onMounted(load);
</script>
