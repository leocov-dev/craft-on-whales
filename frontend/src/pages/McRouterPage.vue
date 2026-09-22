<template>
  <q-page class="q-pa-md">
    <PageHeader title="Router" icon="alt_route" />

    <div class="row q-col-gutter-md">
      <div class="col-12 col-lg-6">
        <q-card flat bordered class="q-pa-md">
          <div class="text-subtitle1 q-mb-sm">mc-router</div>
          <q-toggle v-model="config.enabled" label="Enable mc-router" />
          <q-item-label caption class="q-mt-sm" style="max-width: 60ch">
            Starts a managed <code>itzg/mc-router</code> container that proxies Minecraft client
            connections by hostname to your servers. It needs read-write access to the Docker socket
            to start/stop servers automatically — the same access level as this panel itself.
          </q-item-label>

          <q-input
            v-model.number="config.listenPort"
            type="number"
            label="Listen port"
            filled
            dense
            class="q-mt-md"
            hint="The public port players connect to."
          />

          <q-input
            v-model="config.baseDomain"
            label="Base domain"
            filled
            dense
            class="q-mt-md"
            placeholder="example.com"
            hint="Appended to each server's subdomain (set per-server, under its Settings tab) to form its route hostname — e.g. subdomain 'survival' + this domain gives survival.example.com. Leave blank to type a full hostname per server instead."
          />

          <div class="text-subtitle1 q-mt-lg q-mb-sm">Auto-scale</div>
          <q-toggle
            v-model="config.autoScaleUp"
            label="Start a server when a player connects to its hostname"
          />
          <q-toggle
            v-model="config.autoScaleDown"
            label="Stop a server after it's idle"
            class="q-mt-sm"
          />

          <q-input
            v-model="config.autoScaleDownAfter"
            label="Idle timeout"
            filled
            dense
            class="q-mt-md"
            style="max-width: 160px"
            hint="e.g. 10m, 1h, 30s"
          />
          <q-input
            v-model="config.autoScaleAsleepMotd"
            label="Asleep MOTD"
            filled
            dense
            class="q-mt-md"
            placeholder="Server is sleeping — connect to wake it"
          />
          <q-input
            v-model="config.autoScaleLoadingMotd"
            label="Loading MOTD"
            filled
            dense
            class="q-mt-md"
            placeholder="Server is starting…"
          />

          <q-btn
            color="primary"
            label="Save"
            class="q-mt-md"
            :loading="savingConfig"
            @click="saveConfig"
          />
        </q-card>
      </div>

      <div class="col-12 col-lg-6">
        <q-card flat bordered class="q-pa-md">
          <div class="text-subtitle1 q-mb-sm">Routes</div>
          <q-list separator>
            <q-item
              v-for="route in routes"
              :key="route.id"
              clickable
              :to="`/servers/${route.id}/settings`"
            >
              <q-item-section>
                <q-item-label>{{ route.name }}</q-item-label>
                <q-item-label caption class="font-mono">
                  {{ route.hostname || '(no subdomain set)' }}
                </q-item-label>
              </q-item-section>
              <q-item-section side>
                {{ autoScaleLabel(route.autoScale) }}
              </q-item-section>
            </q-item>
            <q-item v-if="!routes.length">
              <q-item-section class="text-caption">No servers yet.</q-item-section>
            </q-item>
          </q-list>
          <q-item-label caption class="q-mt-md" style="max-width: 60ch">
            Each server's subdomain and auto-scale mode are set on that server's own Settings tab,
            under mc-route — click a row to jump there. Changing either recreates that server's
            container to apply the new routing labels, automatically next start or immediately if
            it's already running.
          </q-item-label>
        </q-card>
      </div>
    </div>
  </q-page>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useQuasar } from 'quasar';
import { mcRouterApi, type McRouterConfig, type RouterRoute } from '@/api/mcRouter';
import PageHeader from '@/components/PageHeader.vue';

const $q = useQuasar();

const config = ref<McRouterConfig>({
  enabled: false,
  listenPort: 25565,
  baseDomain: '',
  autoScaleUp: true,
  autoScaleDown: true,
  autoScaleDownAfter: '10m',
  autoScaleAsleepMotd: '',
  autoScaleLoadingMotd: '',
});
const routes = ref<RouterRoute[]>([]);
const savingConfig = ref(false);

function autoScaleLabel(mode: 'on' | 'off' | null): string {
  if (mode === 'on') return 'On';
  if (mode === 'off') return 'Off';
  return 'Default (follows global auto-scale)';
}

async function load() {
  const res = await mcRouterApi.get();
  config.value = res.config;
  routes.value = res.routes;
}

async function saveConfig() {
  savingConfig.value = true;
  try {
    const res = await mcRouterApi.save(config.value);
    config.value = res.config;
    routes.value = res.routes;
    $q.notify({ type: 'positive', message: 'Router settings saved.' });
  } catch (err) {
    $q.notify({ type: 'negative', message: err instanceof Error ? err.message : 'Save failed.' });
  } finally {
    savingConfig.value = false;
  }
}

onMounted(load);
</script>
