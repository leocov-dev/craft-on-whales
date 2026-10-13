import { inject, type ComputedRef, type InjectionKey, type Ref } from 'vue';
import type { ServerDetail, ServerOperation } from '@/api/servers';

export interface ServerDetailContext {
  server: Ref<ServerDetail | null>;
  loading: Ref<boolean>;
  /** The background operation locking this server, or null. Tabs disable their mutating controls while set. */
  operation: ComputedRef<ServerOperation | null>;
  refresh: () => Promise<void>;
  /** Bumped each time a live status push arrives — watch it to re-check a tab's own socket. */
  statusVersion: Ref<number>;
  /** Bumped when a recreate replaced the container: any tab holding a
   *  container-bound stream (ConsoleTab's log follower) must reconnect. */
  containerVersion: Ref<number>;
}

export const serverDetailKey: InjectionKey<ServerDetailContext> = Symbol('serverDetail');

/** Used by tab components nested under ServerDetailLayout.vue, which provides this. */
export function useServerDetail(): ServerDetailContext {
  const ctx = inject(serverDetailKey);
  if (!ctx) throw new Error('useServerDetail() called outside ServerDetailLayout');
  return ctx;
}
