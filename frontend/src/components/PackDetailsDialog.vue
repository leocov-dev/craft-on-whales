<template>
  <q-dialog :model-value="modelValue" @update:model-value="(v) => emit('update:modelValue', v)">
    <q-card style="min-width: 420px; max-width: 640px; width: 100%">
      <q-card-section v-if="loading" class="text-center q-pa-lg">
        <q-spinner size="32px" color="primary" />
      </q-card-section>

      <q-banner v-else-if="error" class="bg-negative text-white">{{ error }}</q-banner>

      <template v-else-if="pack">
        <q-card-section class="row no-wrap items-start q-gutter-x-sm">
          <q-avatar v-if="pack.iconUrl" square size="40px"
            ><img :src="pack.iconUrl" :alt="pack.name"
          /></q-avatar>
          <q-icon v-else name="inventory_2" size="40px" />
          <div class="col min-width-0">
            <div class="text-subtitle1 ellipsis">{{ pack.name }}</div>
            <div class="text-caption text-ink-faint">
              {{ pack.mcVersion || '—' }}
              <template v-if="pack.loaders?.length"> · {{ pack.loaders.join(', ') }}</template>
              <template v-if="pack.downloads != null">
                · {{ pack.downloads.toLocaleString() }} downloads</template
              >
            </div>
          </div>
        </q-card-section>

        <q-card-section v-if="pack.description" class="text-body2 q-pt-none">
          <div v-html="pack.description" />
        </q-card-section>

        <q-separator />

        <q-card-section class="q-pb-none">
          <div class="text-subtitle2">Mods{{ mods.length ? ` (${mods.length})` : '' }}</div>
        </q-card-section>
        <q-card-section style="max-height: 360px; overflow-y: auto" class="q-pt-sm">
          <div v-if="mods.length === 0" class="text-caption text-ink-faint">No mods found.</div>
          <q-list v-else separator>
            <q-item v-for="m in mods" :key="m.filename ?? m.file ?? m.name">
              <q-item-section avatar>
                <q-icon name="extension" />
              </q-item-section>
              <q-item-section>
                <q-item-label>{{ m.name }}</q-item-label>
                <q-item-label caption>{{ modCaption(m) }}</q-item-label>
              </q-item-section>
            </q-item>
          </q-list>
        </q-card-section>
      </template>

      <q-card-actions align="right">
        <q-btn flat label="Close" @click="emit('update:modelValue', false)" />
        <q-btn
          v-if="showCreate"
          color="primary"
          label="Create server"
          :loading="creating"
          :disable="loading || !!error"
          @click="emit('create')"
        />
      </q-card-actions>
    </q-card>
  </q-dialog>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import { packsApi, type PackDetails, type PackModInfo, type PackPlatform } from '@/api/packs';
import { formatBytes } from '@/composables/useServerStatus';

const props = defineProps<{
  modelValue: boolean;
  // Preview an uninstalled pack by platform+packRef, or an installed server's pin by serverId.
  platform?: PackPlatform | undefined;
  packRef?: string | undefined;
  serverId?: string | undefined;
  showCreate?: boolean | undefined;
  creating?: boolean | undefined;
}>();

const emit = defineEmits<{
  'update:modelValue': [boolean];
  create: [];
}>();

const loading = ref(false);
const error = ref<string | null>(null);
const pack = ref<PackDetails | null>(null);
const mods = ref<PackModInfo[]>([]);

function modCaption(m: PackModInfo): string {
  if (m.side) return m.side === 'both' ? 'client + server' : m.side;
  const parts = [m.kind, m.version, m.size ? formatBytes(m.size) : null].filter(Boolean);
  return parts.join(' · ') || '—';
}

async function load() {
  loading.value = true;
  error.value = null;
  pack.value = null;
  mods.value = [];
  try {
    if (props.serverId) {
      const [detailsRes, modsRes] = await Promise.all([
        packsApi.details({ serverId: props.serverId }).catch(() => null),
        packsApi.packMods(props.serverId),
      ]);
      pack.value = detailsRes?.pack ?? null;
      mods.value = modsRes.mods;
    } else if (props.platform && props.packRef) {
      const res = await packsApi.details({ platform: props.platform, ref: props.packRef });
      pack.value = res.pack;
      mods.value = res.pack.mods ?? [];
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not load pack details.';
  } finally {
    loading.value = false;
  }
}

watch(
  () => [props.modelValue, props.platform, props.packRef, props.serverId],
  () => {
    if (props.modelValue) void load();
  },
  { immediate: true },
);
</script>
