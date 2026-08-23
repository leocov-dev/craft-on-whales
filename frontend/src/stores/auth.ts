import { defineStore, acceptHMRUpdate } from 'pinia';
import { authApi, type SessionUser } from '@/api/auth';
import { ApiError } from '@/api/http';

type Status = 'unknown' | 'loading' | 'authenticated' | 'anonymous';

interface State {
  user: SessionUser | null;
  status: Status;
}

export const useAuthStore = defineStore('auth', {
  state: (): State => ({
    user: null,
    status: 'unknown',
  }),

  getters: {
    isAuthenticated: (state) => state.status === 'authenticated',
    role: (state) => state.user?.role ?? null,
    isAdmin: (state) => state.user?.role === 'admin',
    canWrite: (state) => state.user?.role === 'admin' || state.user?.role === 'operator',
  },

  actions: {
    /** Call once at app start (and after route changes into protected areas) to resolve session state. */
    async fetchSession() {
      this.status = 'loading';
      try {
        const { user } = await authApi.session();
        this.user = user;
        this.status = 'authenticated';
      } catch (err) {
        this.user = null;
        this.status = 'anonymous';
        if (!(err instanceof ApiError && err.status === 401)) throw err;
      }
    },

    /** Returns true if login completed, false if a TOTP code is now required. */
    async login(username: string, password: string, next?: string): Promise<boolean> {
      const { totpRequired } = await authApi.login(username, password, next);
      if (totpRequired) return false;
      await this.fetchSession();
      return true;
    },

    async loginTotp(code: string): Promise<void> {
      await authApi.loginTotp(code);
      await this.fetchSession();
    },

    async logout(): Promise<void> {
      await authApi.logout();
      this.user = null;
      this.status = 'anonymous';
    },

    async setup(username: string, password: string): Promise<void> {
      await authApi.setup(username, password);
      await this.fetchSession();
    },
  },
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useAuthStore, import.meta.hot));
}
