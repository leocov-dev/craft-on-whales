import { defineStore, acceptHMRUpdate } from 'pinia';
import { serversApi, type ServerViewModel, type LifecycleAction } from '@/api/servers';

export type SortKey = 'status' | 'name' | 'size' | 'started' | 'created';

// Mirrors src/web/routes/index.ts's STATUS_RANK — lower sorts first.
const STATUS_RANK: Record<string, number> = {
  running: 0,
  unhealthy: 1,
  starting: 2,
  updating: 3,
  crashed: 4,
  'over-quota': 5,
  stopped: 6,
};

const SORTERS: Record<SortKey, (a: ServerViewModel, b: ServerViewModel) => number> = {
  status: (a, b) =>
    (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9) || a.name.localeCompare(b.name),
  name: (a, b) => a.name.localeCompare(b.name),
  size: (a, b) => b.disk.used - a.disk.used,
  started: (a, b) => String(b.lastStarted).localeCompare(String(a.lastStarted)),
  created: (a, b) => String(b.created).localeCompare(String(a.created)),
};

interface State {
  servers: ServerViewModel[];
  loading: boolean;
  loaded: boolean;
  sort: SortKey;
}

export const useServersStore = defineStore('servers', {
  state: (): State => ({
    servers: [],
    loading: false,
    loaded: false,
    sort: 'status',
  }),

  getters: {
    sorted: (state) => [...state.servers].sort(SORTERS[state.sort]),
    totals: (state) => ({
      running: state.servers.filter((s) => s.status === 'running' || s.status === 'unhealthy')
        .length,
      total: state.servers.length,
      players: state.servers.reduce((n, s) => n + s.players.online, 0),
      updates: state.servers.filter((s) => s.updateAvailable).length,
    }),
    byId: (state) => (id: string) => state.servers.find((s) => s.id === id) ?? null,
  },

  actions: {
    async fetchServers() {
      this.loading = true;
      try {
        const { servers } = await serversApi.list();
        this.servers = servers;
        this.loaded = true;
      } finally {
        this.loading = false;
      }
    },

    /** Poll-friendly hydration: merges live status/stats/players without a full re-fetch. */
    async refreshLive() {
      const { servers: live } = await serversApi.live();
      for (const s of this.servers) {
        const e = live[s.id];
        if (!e) continue;
        s.status = e.status;
        if (e.cpuPct !== null) s.stats.cpuPct = e.cpuPct;
        if (e.memUsedMb !== null) s.stats.memUsedMb = e.memUsedMb;
        if (e.players) s.players = { ...s.players, ...e.players };
        if (e.phase) s.statusDetail = e.phase;
        else delete s.statusDetail;
      }
    },

    async runAction(id: string, action: LifecycleAction) {
      await serversApi.action(id, action);
      await this.fetchServers();
    },

    async remove(id: string) {
      await serversApi.remove(id);
      this.servers = this.servers.filter((s) => s.id !== id);
    },
  },
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useServersStore, import.meta.hot));
}
