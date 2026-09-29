<template>
  <q-dialog :model-value="modelValue" @update:model-value="(v) => emit('update:modelValue', v)">
    <q-card bordered class="shadow-12" style="width: 640px; max-width: 95vw">
      <q-card-section v-if="report">
        <div class="text-subtitle1">Imported {{ packTitle }}</div>
        <q-item-label caption>{{ packCaption }}</q-item-label>
      </q-card-section>

      <q-card-section v-if="report" class="q-pt-none" style="max-height: 60vh; overflow-y: auto">
        <q-banner
          v-for="(w, i) in report.warnings"
          :key="`w${i}`"
          dense
          rounded
          class="bg-warning text-black q-mb-sm"
        >
          <template #avatar><q-icon name="warning" /></template>
          {{ w }}
        </q-banner>

        <q-banner v-if="!report.import" dense rounded class="q-mb-sm">
          <template #avatar><q-icon name="info" color="primary" /></template>
          Nothing was installed or written, so no import was recorded.
        </q-banner>

        <q-list bordered separator class="rounded-borders">
          <q-expansion-item
            v-if="report.installed.length"
            icon="check_circle"
            header-class="text-positive"
            :label="`Installed (${report.installed.length})`"
            default-opened
          >
            <q-list dense separator>
              <q-item v-for="j in report.installed" :key="j.contentId">
                <q-item-section avatar>
                  <q-avatar v-if="j.iconUrl" square size="24px"
                    ><img :src="j.iconUrl" :alt="j.name"
                  /></q-avatar>
                  <q-icon v-else name="extension" />
                </q-item-section>
                <q-item-section>
                  <q-item-label>{{ j.name }}</q-item-label>
                  <q-item-label caption
                    >{{ j.kind }} · {{ j.version ?? '—' }} · {{ j.filename }}</q-item-label
                  >
                </q-item-section>
                <q-item-section side>
                  <q-badge
                    :color="j.source === 'unknown' ? 'grey' : 'primary'"
                    :label="SOURCE_LABELS[j.source]"
                  />
                </q-item-section>
              </q-item>
            </q-list>
          </q-expansion-item>

          <q-expansion-item
            v-if="report.skipped.length"
            icon="block"
            :label="`Skipped (${report.skipped.length})`"
            :default-opened="!report.installed.length"
          >
            <q-list dense separator>
              <q-item v-for="(s, i) in report.skipped" :key="`s${i}`">
                <q-item-section>
                  <q-item-label>{{ s.name }}</q-item-label>
                  <q-item-label caption>{{ s.detail ?? s.path }}</q-item-label>
                </q-item-section>
                <q-item-section side>
                  <q-badge outline color="grey" :label="SKIP_LABELS[s.reason]" />
                </q-item-section>
              </q-item>
            </q-list>
          </q-expansion-item>

          <q-expansion-item
            v-if="report.failed.length"
            icon="error"
            header-class="text-negative"
            :label="`Failed (${report.failed.length})`"
            default-opened
          >
            <q-list dense separator>
              <q-item v-for="(f, i) in report.failed" :key="`f${i}`">
                <q-item-section>
                  <q-item-label>{{ f.name }}</q-item-label>
                  <q-item-label caption class="text-negative">{{ f.error }}</q-item-label>
                </q-item-section>
              </q-item>
            </q-list>
          </q-expansion-item>

          <q-expansion-item icon="settings" :label="overridesLabel">
            <q-list dense separator>
              <q-item v-for="o in report.overrides.written" :key="o.path">
                <q-item-section>
                  <q-item-label>{{ o.path }}</q-item-label>
                </q-item-section>
                <q-item-section side>
                  <q-badge
                    outline
                    :color="o.action === 'replaced' ? 'warning' : 'positive'"
                    :label="o.action === 'replaced' ? 'replaced (backed up)' : 'created'"
                  />
                </q-item-section>
              </q-item>
              <q-item v-for="o in report.overrides.skipped" :key="`os-${o.path}`">
                <q-item-section>
                  <q-item-label>{{ o.path }}</q-item-label>
                </q-item-section>
                <q-item-section side>
                  <q-badge outline color="grey" :label="OVERRIDE_SKIP_LABELS[o.reason]" />
                </q-item-section>
              </q-item>
              <q-item v-if="!report.overrides.written.length && !report.overrides.skipped.length">
                <q-item-section>
                  <q-item-label caption>This archive had no override files.</q-item-label>
                </q-item-section>
              </q-item>
            </q-list>
          </q-expansion-item>
        </q-list>
      </q-card-section>

      <q-card-actions align="right">
        <q-btn flat label="Close" @click="emit('update:modelValue', false)" />
      </q-card-actions>
    </q-card>
  </q-dialog>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { ContentImportReport, ContentImportSkipReason } from '@/api/mods';

const props = defineProps<{
  modelValue: boolean;
  report: ContentImportReport | null;
}>();

const emit = defineEmits<{
  'update:modelValue': [boolean];
}>();

const SOURCE_LABELS: Record<ContentImportReport['installed'][number]['source'], string> = {
  modrinth: 'Modrinth',
  curseforge: 'CurseForge',
  metadata: 'Jar metadata',
  unknown: 'Unidentified',
};

const SKIP_LABELS: Record<ContentImportSkipReason, string> = {
  'client-only': 'Client-only',
  'not-a-mod': 'Not a mod or plugin',
  'wrong-kind': 'Wrong kind for this server',
  'wrong-loader': 'Wrong mod loader',
  'already-installed': 'Already installed',
  duplicate: 'Duplicate in archive',
};

const OVERRIDE_SKIP_LABELS: Record<
  ContentImportReport['overrides']['skipped'][number]['reason'],
  string
> = {
  'not-a-file': 'Folder or link in the way',
  reserved: 'Reserved path',
  disabled: 'Not applied',
};

const packTitle = computed(() => {
  const p = props.report?.pack;
  if (!p) return '';
  return p.version ? `${p.name} ${p.version}` : p.name;
});

const packCaption = computed(() => {
  const p = props.report?.pack;
  if (!p) return '';
  const parts = [p.format === 'mrpack' ? 'Modrinth pack (.mrpack)' : 'Jar zip'];
  if (p.mcVersion) parts.push(`Minecraft ${p.mcVersion}`);
  if (p.loader) parts.push(p.loaderVersion ? `${p.loader} ${p.loaderVersion}` : p.loader);
  return parts.join(' · ');
});

const overridesLabel = computed(() => {
  const o = props.report?.overrides;
  if (!o) return 'Override files';
  if (!o.applied) return 'Override files: not applied';
  const replaced = o.written.filter((w) => w.action === 'replaced').length;
  const created = o.written.length - replaced;
  return `Override files: ${created} created, ${replaced} replaced`;
});
</script>
