import { inject, type InjectionKey, type Ref } from 'vue';
import type { ServerDetail } from '@/api/servers';

export interface ServerDetailContext {
  server: Ref<ServerDetail | null>;
  loading: Ref<boolean>;
  refresh: () => Promise<void>;
}

export const serverDetailKey: InjectionKey<ServerDetailContext> = Symbol('serverDetail');

/** Used by tab components nested under ServerDetailLayout.vue, which provides this. */
export function useServerDetail(): ServerDetailContext {
  const ctx = inject(serverDetailKey);
  if (!ctx) throw new Error('useServerDetail() called outside ServerDetailLayout');
  return ctx;
}
