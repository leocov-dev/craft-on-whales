import { defineStore, acceptHMRUpdate } from 'pinia';
import {
  serversApi,
  type ServerViewModel,
  type ServerStatus,
  type LifecycleAction,
} from '@/api/servers';
import { useServersSocket } from '@/composables/useServersSocket';

// Safety-net poll for anything the status bus doesn't carry (and for a push
// that was dropped); status itself arrives over /ws/servers.
const LIVE_POLL_MS = 30_000;

// Module-level, not state: a socket handle and a timer aren't serializable and
// must not be made reactive.
let liveSocket: { close: () => void } | null = null;
let livePoll: ReturnType<typeof setInterval> | undefined;
let fetchSeq = 0;
// Bumped on every pushed status; lets refreshLive() drop a response that was
// requested before a newer push landed instead of overwriting it.
let pushEpoch = 0;

interface State {
  servers: ServerViewModel[];
  loading: boolean;
  loaded: boolean;
  /** Replaced (new object) on every pushed deletion, so watchers fire even for a repeated id. */
  lastRemoved: { id: string } | null;
}

export const useServersStore = defineStore('servers', {
  state: (): State => ({
    servers: [],
    loading: false,
    loaded: false,
    lastRemoved: null,
  }),

  getters: {
    sorted: (state) =>
      [...state.servers].sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }),
      ),
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
      const seq = ++fetchSeq;
      try {
        const { servers } = await serversApi.list();
        if (seq !== fetchSeq) return; // a newer fetch is in flight or done
        this.servers = servers;
        this.loaded = true;
      } finally {
        this.loading = false;
      }
    },

    /** Poll-friendly hydration: merges live status/stats/players without a full re-fetch. */
    async refreshLive() {
      const epoch = pushEpoch;
      const { servers: live } = await serversApi.live();
      const statusStale = epoch !== pushEpoch;
      for (const s of this.servers) {
        const e = live[s.id];
        if (!e) continue;
        if (!statusStale) s.status = e.status;
        if (e.cpuPct !== null) s.stats.cpuPct = e.cpuPct;
        if (e.memUsedMb !== null) s.stats.memUsedMb = e.memUsedMb;
        if (e.players) s.players = { ...s.players, ...e.players };
        if (e.phase) s.statusDetail = e.phase;
        else delete s.statusDetail;
      }
    },

    /** Applies a pushed status; false if the server isn't in the list yet. */
    applyStatus(id: string, status: string): boolean {
      const s = this.servers.find((x) => x.id === id);
      if (!s) return false;
      pushEpoch += 1;
      s.status = status as ServerStatus; // the wire carries a plain string
      delete s.statusDetail;
      return true;
    },

    /**
     * Keeps the list live for as long as the signed-in layout is mounted:
     * /ws/servers pushes status and create/delete, and a slow poll backstops it.
     * Idempotent; pair with stopLive().
     */
    startLive() {
      if (liveSocket) return;
      const resync = () => {
        if (this.loaded) void this.fetchServers().catch(() => undefined);
      };
      liveSocket = useServersSocket({
        onStatus: (id, status) => {
          // Unknown id = created since we last fetched.
          if (!this.applyStatus(id, status)) resync();
        },
        onListChanged: (id, change) => {
          if (change === 'deleted') this.lastRemoved = { id };
          resync();
        },
        onConnect: resync,
      });
      livePoll = setInterval(() => {
        if (this.loaded) void this.refreshLive().catch(() => undefined);
      }, LIVE_POLL_MS);
    },

    stopLive() {
      liveSocket?.close();
      liveSocket = null;
      clearInterval(livePoll);
      livePoll = undefined;
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
