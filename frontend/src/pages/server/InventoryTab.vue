<template>
  <div class="row q-col-gutter-md">
    <div class="col-12 col-md-4">
      <div class="text-subtitle1 q-mb-sm">Players</div>
      <q-list bordered separator>
        <q-item
          v-for="p in players"
          :key="p.uuid"
          clickable
          :active="selected?.uuid === p.uuid"
          @click="select(p)"
        >
          <q-item-section>{{ p.name ?? p.uuid }}</q-item-section>
        </q-item>
        <q-item v-if="players.length === 0">
          <q-item-section class="text-center"
            ><q-item-label caption>No player data yet.</q-item-label></q-item-section
          >
        </q-item>
      </q-list>
    </div>

    <div class="col-12 col-md-8">
      <q-banner v-if="!detail" rounded class="q-mb-lg">
        <template #avatar>
          <q-icon name="info" color="primary" />
        </template>
        Select a player to view their inventory.
      </q-banner>
      <div v-else class="q-gutter-md">
        <q-card flat bordered class="q-pa-md">
          <div class="row items-center q-gutter-x-sm">
            <div class="text-subtitle1">{{ detail.name ?? detail.uuid }}</div>
            <q-badge v-if="edit?.online" color="positive" label="online" />
            <q-space />
            <div class="row q-gutter-x-sm">
              <q-input
                v-model="giveItem"
                dense
                filled
                placeholder="minecraft:diamond"
                style="width: 220px"
              />
              <q-input
                v-model.number="giveCount"
                dense
                filled
                type="number"
                style="width: 90px"
              />
              <q-btn dense outline label="Give" @click="giveToPlayer" />
              <q-btn dense outline color="negative" label="Clear all" @click="clearPlayer" />
            </div>
          </div>
          <div class="row q-col-gutter-md q-mt-sm">
            <q-item-label caption>Health: {{ detail.health ?? '—' }}</q-item-label>
            <q-item-label caption>XP level: {{ detail.xpLevel ?? '—' }}</q-item-label>
            <q-item-label caption>Dimension: {{ detail.pos?.dimension ?? '—' }}</q-item-label>
          </div>
        </q-card>

        <q-card flat bordered class="q-pa-md">
          <div class="text-subtitle2 q-mb-sm">Armor + Offhand</div>
          <div class="row q-gutter-sm">
            <q-chip v-for="a in detail.armor" :key="a.piece" outline dense>
              {{ a.piece }}: {{ a.count }}× {{ a.displayName ?? a.id }}
            </q-chip>
            <q-chip v-if="detail.offhand" outline dense>
              offhand: {{ detail.offhand.count }}×
              {{ detail.offhand.displayName ?? detail.offhand.id }}
            </q-chip>
          </div>
        </q-card>

        <q-card flat bordered class="q-pa-md">
          <div class="text-subtitle2 q-mb-sm">Inventory ({{ detail.inventory.length }} stacks)</div>
          <div class="row q-gutter-sm">
            <q-chip v-for="(it, i) in detail.inventory" :key="i" outline dense>
              {{ it.count }}× {{ it.displayName ?? it.id }}
            </q-chip>
            <q-item-label v-if="detail.inventory.length === 0" caption>Empty.</q-item-label>
          </div>
        </q-card>

        <q-card flat bordered class="q-pa-md">
          <div class="text-subtitle2 q-mb-sm">
            Ender chest ({{ detail.enderChest.length }} stacks)
          </div>
          <div class="row q-gutter-sm">
            <q-chip v-for="(it, i) in detail.enderChest" :key="i" outline dense>
              {{ it.count }}× {{ it.displayName ?? it.id }}
            </q-chip>
            <q-item-label v-if="detail.enderChest.length === 0" caption>Empty.</q-item-label>
          </div>
        </q-card>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useQuasar } from 'quasar';
import { inventoryApi, type PlayerWithData, type PlayerInventoryData } from '@/api/inventory';
import { useServerDetail } from '@/composables/useServerDetail';

const $q = useQuasar();
const { server } = useServerDetail();

const players = ref<PlayerWithData[]>([]);
const selected = ref<PlayerWithData | null>(null);
const detail = ref<PlayerInventoryData | null>(null);
const edit = ref<{ online: boolean; mechanism: string } | null>(null);
const giveItem = ref('minecraft:diamond');
const giveCount = ref(1);

async function loadPlayers() {
  if (!server.value) return;
  const res = await inventoryApi.listPlayers(server.value.id);
  players.value = res.players;
}

async function select(p: PlayerWithData) {
  if (!server.value) return;
  selected.value = p;
  const res = await inventoryApi.getPlayer(server.value.id, p.uuid);
  detail.value = res.player;
  edit.value = res.edit;
}

async function giveToPlayer() {
  if (!server.value || !detail.value) return;
  try {
    await inventoryApi.give(
      server.value.id,
      detail.value.name ?? detail.value.uuid,
      giveItem.value,
      giveCount.value,
    );
    $q.notify({ type: 'positive', message: 'Given.' });
  } catch (err) {
    $q.notify({ type: 'negative', message: err instanceof Error ? err.message : 'Give failed.' });
  }
}

function clearPlayer() {
  if (!server.value || !detail.value) return;
  $q.dialog({
    title: `Clear ${detail.value.name ?? detail.value.uuid}'s inventory?`,
    cancel: true,
    ok: { color: 'negative', label: 'Clear' },
  }).onOk(() => {
    void inventoryApi.clear(server.value!.id, detail.value!.name ?? detail.value!.uuid).then(() => {
      if (selected.value) void select(selected.value);
    });
  });
}

onMounted(loadPlayers);
</script>
