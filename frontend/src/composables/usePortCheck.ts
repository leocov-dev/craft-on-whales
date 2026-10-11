import { computed, onBeforeUnmount, ref, watch, type Ref } from 'vue';
import { wizardApi } from '@/api/wizard';
import { useServersStore } from '@/stores/servers';
import type { ServerViewModel } from '@/api/servers';

/**
 * Validates a game port as the user types: range, clash with an existing server's game/RCON
 * port, then (debounced) whether the host has it free.
 */
export function usePortCheck(port: Ref<number | undefined>) {
  const servers = useServersStore();
  const portChecking = ref(false);
  const remoteInUse = ref(false);
  let debounce: ReturnType<typeof setTimeout> | null = null;

  const inRange = (p: number) => Number.isInteger(p) && p >= 1024 && p <= 65535;
  const conflictWith = (p: number) =>
    servers.servers.find((s: ServerViewModel) => s.ports?.game === p || s.ports?.rcon === p);

  const portError = computed(() => {
    const p = port.value;
    if (!p) return null;
    if (!inRange(p)) return 'Port must be an integer between 1024 and 65535';
    const conflict = conflictWith(p);
    if (conflict) return `Port ${p} is already in use by server "${conflict.name}".`;
    if (remoteInUse.value) return `Port ${p} is already in use or unavailable on host.`;
    return null;
  });

  watch(port, (p) => {
    remoteInUse.value = false;
    if (debounce) clearTimeout(debounce);
    if (!p || !inRange(p) || conflictWith(p)) {
      portChecking.value = false;
      return;
    }
    portChecking.value = true;
    debounce = setTimeout(() => {
      void (async () => {
        try {
          const res = await wizardApi.checkPort(p);
          if (port.value === p) remoteInUse.value = !res.free;
        } catch {
          // best-effort
        } finally {
          if (port.value === p) portChecking.value = false;
        }
      })();
    }, 300);
  });

  onBeforeUnmount(() => {
    if (debounce) clearTimeout(debounce);
  });

  return { portError, portChecking };
}
