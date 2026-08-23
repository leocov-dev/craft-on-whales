<template>
  <div>
    <q-card flat bordered class="console-card">
      <div ref="scrollEl" class="console-output">
        <div
          v-for="(line, i) in socket.lines.value"
          :key="i"
          class="console-line"
          :class="{
            'text-negative': line.level === 'ERROR',
            'text-warning': line.level === 'WARN',
          }"
        >
          {{ line.text }}
        </div>
        <div v-if="socket.ended.value" class="text-ink-faint">— server not running —</div>
      </div>
    </q-card>

    <q-form class="row q-gutter-x-sm q-mt-sm" @submit="sendCommand">
      <q-input
        v-model="command"
        class="col"
        dense
        outlined
        :disable="!canRunCommands"
        :placeholder="canRunCommands ? 'Type a command…' : 'Your role cannot run commands'"
        @keyup.up="historyUp"
        @keyup.down="historyDown"
      />
      <q-btn
        type="submit"
        color="primary"
        label="Run"
        :disable="!canRunCommands || !command.trim()"
      />
    </q-form>
  </div>
</template>

<script setup lang="ts">
import { ref, nextTick, watch, computed } from 'vue';
import { useQuasar } from 'quasar';
import { useConsoleSocket } from '@/composables/useConsoleSocket';
import { useServerDetail } from '@/composables/useServerDetail';
import { useAuthStore } from '@/stores/auth';

const $q = useQuasar();
const { server } = useServerDetail();
const auth = useAuthStore();

// server.value is already loaded — ServerDetailLayout awaits its fetch
// before rendering <router-view>, so this tab only ever mounts once it's set.
const socket = useConsoleSocket(server.value!.id);

const command = ref('');
const scrollEl = ref<HTMLElement>();
const history: string[] = [];
let historyIndex = -1;

const canRunCommands = computed(() => auth.role === 'admin' || auth.role === 'operator');

function sendCommand() {
  const cmd = command.value.trim();
  if (!cmd) return;
  socket.sendCommand(cmd);
  history.unshift(cmd);
  historyIndex = -1;
  command.value = '';
}

function historyUp() {
  if (historyIndex + 1 < history.length) {
    historyIndex += 1;
    command.value = history[historyIndex] ?? '';
  }
}
function historyDown() {
  if (historyIndex > 0) {
    historyIndex -= 1;
    command.value = history[historyIndex] ?? '';
  } else {
    historyIndex = -1;
    command.value = '';
  }
}

watch(
  () => socket.lastResult.value,
  (r) => {
    if (r?.error) $q.notify({ type: 'negative', message: r.error });
  },
);

watch(
  () => socket.lines.value.length,
  async () => {
    await nextTick();
    scrollEl.value?.scrollTo({ top: scrollEl.value.scrollHeight });
  },
);
</script>

<style scoped>
.console-card {
  background: #000;
}
.console-output {
  height: 480px;
  overflow-y: auto;
  padding: 12px;
  font-family: var(--font-mono);
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-word;
}
.console-line + .console-line {
  margin-top: 1px;
}
</style>
