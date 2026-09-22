<template>
  <div v-if="server" class="row q-col-gutter-md">
    <div v-if="server.packPinNeedsReview" class="col-12">
      <q-banner class="bg-warning text-black" rounded>
        <template #avatar>
          <q-icon name="warning" />
        </template>
        This server's modpack has no pinned version, and the panel couldn't tell what's actually
        installed — it will keep re-downloading whatever build is newest on every start until you
        pick a version manually. This never happens automatically, so the world already on disk is
        safe until then.
        <template #action>
          <q-btn flat label="Pick version" @click="pickerOpen = true" />
        </template>
      </q-banner>

      <q-dialog v-model="pickerOpen">
        <q-card style="min-width: 360px" class="q-pa-sm">
          <q-card-section class="text-subtitle1">Pin the modpack version</q-card-section>
          <q-card-section class="q-gutter-md">
            <q-input
              v-model="pickForm.ref"
              filled
              dense
              label="Pack slug / URL / ID"
              :hint="
                packPlatform ? `Platform: ${packPlatform}` : 'Unknown platform for this server type'
              "
            />
            <q-input
              v-model="pickForm.versionId"
              filled
              dense
              label="Version ID (leave blank for the newest release)"
            />
            <q-toggle
              v-model="pickForm.force"
              label="Apply even if it looks like it changes the Minecraft version"
            />
          </q-card-section>
          <q-card-actions align="right">
            <q-btn flat label="Cancel" v-close-popup />
            <q-btn
              color="primary"
              label="Pin"
              :loading="pinning"
              :disable="!pickForm.ref.trim() || !packPlatform"
              @click="applyPick"
            />
          </q-card-actions>
        </q-card>
      </q-dialog>
    </div>

    <div class="col-12 col-md-6">
      <q-card flat bordered class="q-pa-md">
        <div class="q-gutter-md">
          <div class="text-subtitle1">Identity</div>
          <q-input v-model="form.name" label="Name" filled dense />
          <q-input
            v-model="form.description"
            label="Description"
            filled
            dense
            type="textarea"
            autogrow
          />
          <q-input v-model="tagsText" label="Tags (comma separated)" filled dense />
          <q-input v-model="form.notes" label="Notes" filled dense type="textarea" autogrow />
        </div>
      </q-card>
    </div>

    <div class="col-12 col-md-6">
      <q-card flat bordered class="q-pa-md">
        <div class="q-gutter-md">
          <div class="text-subtitle1">Resources</div>
          <q-input
            v-model.number="form.heapMb"
            type="number"
            label="Java heap (MB)"
            :hint="HEAP_FIELD_HINT"
            filled
            dense
          />
          <q-input
            v-model.number="form.containerMemoryMb"
            type="number"
            label="Container memory limit (MB)"
            filled
            dense
          />
          <q-input
            v-model.number="form.cpus"
            type="number"
            step="0.5"
            label="CPU limit (0 = unlimited)"
            filled
            dense
          />
          <q-input
            v-model.number="form.diskQuotaGb"
            type="number"
            label="Disk quota (GB)"
            filled
            dense
          />
        </div>
      </q-card>

      <q-card flat bordered class="q-pa-md q-mt-md">
        <div class="q-gutter-md">
          <div class="text-subtitle1">Lifecycle</div>
          <q-toggle v-model="form.autoStart" label="Auto-start with the panel" />
          <q-toggle v-model="form.autoRestart" label="Auto-restart on crash" />
          <q-select
            v-model="form.updatePolicy"
            :options="['manual', 'notify', 'auto']"
            filled
            dense
            label="Modpack update policy"
          />
        </div>
      </q-card>

      <q-card v-if="routerEnabled" flat bordered class="q-pa-md q-mt-md">
        <div class="q-gutter-md">
          <div class="text-subtitle1">mc-route</div>
          <q-input
            v-model="form.routerHostname"
            label="Subdomain"
            filled
            dense
            :placeholder="defaultSubdomain"
            hint="Lowercase letters, numbers, hyphens; max 30 chars. Leave blank to remove this server from the router."
          >
            <template #append>
              <q-btn
                flat
                dense
                round
                icon="auto_fix_high"
                title="Use suggested subdomain"
                @click="form.routerHostname = defaultSubdomain"
              />
            </template>
          </q-input>
          <q-item-label caption class="font-mono">
            {{ fullHostnamePreview || '(unrouted)' }}
          </q-item-label>
          <q-select
            v-model="form.routerAutoScale"
            label="Auto-scale mode"
            filled
            dense
            emit-value
            map-options
            :options="autoScaleOptions"
            hint="Default follows the global auto-scale settings on the Router page; On/Off override them for just this server."
          />
        </div>
      </q-card>
    </div>

    <div class="col-12">
      <q-btn color="primary" label="Save changes" :loading="saving" @click="save" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useQuasar } from 'quasar';
import { serversApi, type ServerPatch } from '@/api/servers';
import { packsApi, type PackPlatform } from '@/api/packs';
import { mcRouterApi } from '@/api/mcRouter';
import { useServerDetail } from '@/composables/useServerDetail';
import { HEAP_FIELD_HINT } from '@/composables/useServerStatus';
import { slugify } from '@/utils/slug';

const $q = useQuasar();
const { server, refresh } = useServerDetail();

// Mirrors PacksService.packEnv()'s TYPE <-> platform mapping — the only
// server types PackPinSweepService ever flags carry one of these.
const TYPE_TO_PLATFORM: Record<string, PackPlatform> = {
  AUTO_CURSEFORGE: 'curseforge',
  MODRINTH: 'modrinth',
  FTBA: 'ftb',
  GTNH: 'gtnh',
};
const packPlatform = computed<PackPlatform | null>(
  () => TYPE_TO_PLATFORM[server.value?.type ?? ''] ?? null,
);

const pickerOpen = ref(false);
const pinning = ref(false);
const pickForm = ref({ ref: '', versionId: '', force: false });
watch(pickerOpen, (open) => {
  if (open) pickForm.value = { ref: '', versionId: '', force: false };
});

async function applyPick() {
  if (!server.value || !packPlatform.value) return;
  pinning.value = true;
  try {
    const versionId = pickForm.value.versionId.trim();
    await packsApi.applyToServer(server.value.id, packPlatform.value, pickForm.value.ref.trim(), {
      ...(versionId ? { versionId } : {}),
      force: pickForm.value.force,
    });
    $q.notify({ type: 'positive', message: 'Modpack version pinned.' });
    pickerOpen.value = false;
    await refresh();
  } catch (err) {
    $q.notify({
      type: 'negative',
      message: err instanceof Error ? err.message : 'Pinning failed.',
    });
  } finally {
    pinning.value = false;
  }
}

const form = ref<ServerPatch>({});
const tagsText = ref('');
const saving = ref(false);

const routerEnabled = ref(false);
const routerBaseDomain = ref('');
const autoScaleOptions = [
  { label: 'Default', value: null },
  { label: 'On', value: 'on' },
  { label: 'Off', value: 'off' },
];

const defaultSubdomain = computed(() => (server.value ? slugify(server.value.name) : ''));
const fullHostnamePreview = computed(() => {
  const subdomain = form.value.routerHostname || defaultSubdomain.value;
  if (!subdomain) return '';
  return routerBaseDomain.value ? `${subdomain}.${routerBaseDomain.value}` : subdomain;
});

onMounted(async () => {
  const res = await mcRouterApi.get();
  routerEnabled.value = res.config.enabled;
  routerBaseDomain.value = res.config.baseDomain;
});

function loadForm() {
  if (!server.value) return;
  form.value = {
    name: server.value.name,
    description: server.value.description,
    notes: server.value.notes,
    heapMb: server.value.resources.heapMb,
    containerMemoryMb: server.value.resources.containerMemoryMb,
    cpus: server.value.resources.cpus,
    diskQuotaGb: Math.round(server.value.disk.quota / 1024 ** 3),
    autoStart: server.value.autoStart,
    autoRestart: server.value.autoRestart,
    updatePolicy: server.value.updatePolicy,
    routerHostname: server.value.routerHostname ?? '',
    routerAutoScale: server.value.routerAutoScale,
  };
  tagsText.value = server.value.tags.join(', ');
}
watch(server, loadForm, { immediate: true });

async function save() {
  saving.value = true;
  try {
    const tags = tagsText.value
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    await serversApi.patch(server.value!.id, { ...form.value, tags });
    $q.notify({ type: 'positive', message: 'Settings saved.' });
    await refresh();
  } catch (err) {
    $q.notify({ type: 'negative', message: err instanceof Error ? err.message : 'Save failed.' });
  } finally {
    saving.value = false;
  }
}
</script>
