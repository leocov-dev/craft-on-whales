import { Injectable, OnModuleDestroy, BadGatewayException, BadRequestException } from '@nestjs/common';
import { and, desc, eq, gt } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { SecretsService } from '../auth/secrets.service';
import { integrations, events, servers } from '../db/schema';
import type { DiscordConfig, EmbedField, EmbedPayload, EventToggles, NotificationKind, SetDiscordConfigOptions } from './integrations.types';

const KIND = 'discord-webhook';

const DEFAULT_EVENTS: EventToggles = { lifecycle: true, crashes: true, backups: true, updates: true, players: true };

const WEBHOOK_RE = /^https:\/\/(discord|discordapp)\.com\/api\/webhooks\//;

// Embed accent color per notification kind (decimal RGB, matches panel palette).
const COLORS: Record<NotificationKind, number> = {
  crash: 0xe5484d, // red
  start: 0x3fa62b, // green
  stop: 0x8b8f98, // grey
  backup: 0x3b82f6, // blue
  update: 0xe99417, // gold
  player: 0x21a7ab, // teal
};

// History event type → [notification kind, toggle category]
const EVENT_MAP: Record<string, [NotificationKind, keyof EventToggles]> = {
  started: ['start', 'lifecycle'],
  stopped: ['stop', 'lifecycle'],
  crashed: ['crash', 'crashes'],
  'crash-loop': ['crash', 'crashes'],
  'backup-created': ['backup', 'backups'],
  'backup-restored': ['backup', 'backups'],
  'update-applied': ['update', 'updates'],
  'update-rolled-back': ['update', 'updates'],
  'update-failed': ['update', 'updates'],
  'player-ban': ['player', 'players'],
  'player-kick': ['player', 'players'],
};

const TITLES: Record<string, string> = {
  started: 'Server started',
  stopped: 'Server stopped',
  crashed: 'Server crashed',
  'crash-loop': 'Crash loop detected',
  'backup-created': 'Backup created',
  'backup-restored': 'Backup restored',
  'update-applied': 'Update applied',
  'update-rolled-back': 'Update rolled back',
  'update-failed': 'Update failed',
  'player-ban': 'Player banned',
  'player-kick': 'Player kicked',
};

/**
 * Discord webhook notifications (MP6, webhook mode only — no bot). The
 * webhook URL is a secret and lives encrypted in `integrations.config_cipher`;
 * per-event toggles live in plain `config_json`. Delivery is fire-and-forget:
 * a broken webhook must never break panel operations. Ports
 * `src/integrations/discord.ts`.
 */
@Injectable()
export class DiscordService implements OnModuleDestroy {
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastSeenId = 0;
  private readonly lastErrorLog = new Map<string, number>();

  constructor(
    private readonly dbService: DbService,
    private readonly secrets: SecretsService
  ) {}

  private get db() {
    return this.dbService.db;
  }

  private async row(serverId: string) {
    const [r] = await this.db.select().from(integrations).where(and(eq(integrations.serverId, serverId), eq(integrations.kind, KIND))).limit(1);
    return r;
  }

  /** Masked, UI-safe view of the config. Never returns the webhook URL. */
  async getConfig(serverId: string): Promise<DiscordConfig> {
    const r = await this.row(serverId);
    const cfg = r ? JSON.parse(r.configJson || '{}') : {};
    return {
      enabled: Boolean(r && r.enabled),
      hasWebhook: Boolean(r && r.configCipher),
      webhookMasked: r && r.configCipher ? this.maskWebhook(await this.webhookUrl(serverId)) : null,
      events: { ...DEFAULT_EVENTS, ...(cfg.events || {}) },
    };
  }

  /** Decrypted webhook URL (internal use only — never expose over HTTP). */
  private async webhookUrl(serverId: string): Promise<string | null> {
    const r = await this.row(serverId);
    if (!r || !r.configCipher) return null;
    try {
      return JSON.parse(this.secrets.decrypt(r.configCipher)).webhookUrl || null;
    } catch {
      return null; // SESSION_SECRET changed — treat as unset
    }
  }

  private maskWebhook(url: string | null): string | null {
    if (!url) return null;
    // Keep scheme/host/webhook id, hide the token entirely.
    const m = /^(https:\/\/(?:discord|discordapp)\.com\/api\/webhooks\/\d+)\//.exec(url);
    return m ? `${m[1]}/••••••••` : 'https://discord.com/api/webhooks/••••••••';
  }

  /**
   * Upsert the config. webhookUrl: undefined = keep current, '' or null = clear,
   * string = validate + encrypt. events merges over the stored toggles.
   */
  async setConfig(serverId: string, { enabled, webhookUrl: url, events: toggles }: SetDiscordConfigOptions = {}): Promise<DiscordConfig> {
    const existing = await this.row(serverId);
    const cfg = existing ? JSON.parse(existing.configJson || '{}') : {};
    const nextEvents: EventToggles = { ...DEFAULT_EVENTS, ...(cfg.events || {}), ...(toggles || {}) };

    let cipher: string | null = existing ? (existing.configCipher ?? null) : null;
    if (url !== undefined) {
      if (url === null || url === '') {
        cipher = null;
      } else {
        if (!WEBHOOK_RE.test(url)) throw new BadRequestException('Webhook URL must start with https://discord.com/api/webhooks/');
        cipher = this.secrets.encrypt(JSON.stringify({ webhookUrl: url }));
      }
    }

    await this.db
      .insert(integrations)
      .values({
        serverId,
        kind: KIND,
        enabled: enabled === undefined ? Boolean(existing && existing.enabled) : Boolean(enabled),
        configCipher: cipher,
        configJson: JSON.stringify({ events: nextEvents }),
      })
      .onConflictDoUpdate({
        target: [integrations.serverId, integrations.kind],
        set: {
          enabled: enabled === undefined ? Boolean(existing && existing.enabled) : Boolean(enabled),
          configCipher: cipher,
          configJson: JSON.stringify({ events: nextEvents }),
          updatedAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
        },
      });
    return this.getConfig(serverId);
  }

  /** Send a test embed so the user can confirm the webhook works. Throws on failure. */
  async testWebhook(serverId: string): Promise<{ ok: true }> {
    const url = await this.webhookUrl(serverId);
    if (!url) throw new BadRequestException('No webhook URL saved for this server yet');
    const [server] = await this.db.select({ displayName: servers.displayName }).from(servers).where(eq(servers.id, serverId)).limit(1);
    const res = await this.post(
      url,
      this.buildEmbed('start', {
        title: 'Minecraft Server Manager test notification',
        description: `Webhook is wired up for **${server ? server.displayName : serverId}**. You will receive the event types you enabled.`,
      })
    );
    if (!res.ok) throw new BadGatewayException(`Discord answered HTTP ${res.status} — check the webhook URL`);
    return { ok: true };
  }

  /**
   * Send a notification if the integration is enabled and has a webhook.
   * Never throws; failures are logged at most once per hour per server.
   */
  async notify(serverId: string, kind: NotificationKind, payload: EmbedPayload = {}): Promise<boolean> {
    const r = await this.row(serverId);
    if (!r || !r.enabled || !r.configCipher) return false;
    const url = await this.webhookUrl(serverId);
    if (!url) return false;
    try {
      const res = await this.post(url, this.buildEmbed(kind, payload));
      if (!res.ok) throw new Error(`Discord HTTP ${res.status}`);
      return true;
    } catch (err) {
      this.logThrottled(serverId, err);
      return false;
    }
  }

  private buildEmbed(kind: NotificationKind, { title, description, fields }: EmbedPayload = {}) {
    return {
      username: 'Minecraft Server Manager',
      embeds: [
        {
          title: title || 'Server event',
          description: description || undefined,
          color: COLORS[kind] || COLORS.stop,
          fields: ((fields || []) as EmbedField[]).slice(0, 10).map((f) => ({
            name: String(f.name).slice(0, 256),
            value: String(f.value).slice(0, 1024),
            inline: f.inline !== false,
          })),
          timestamp: new Date().toISOString(),
          footer: { text: 'Minecraft Server Manager' },
        },
      ],
    };
  }

  private post(url: string, body: unknown): Promise<Response> {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
  }

  // One error log line per server per hour — a dead webhook must not spam the panel log.
  private logThrottled(serverId: string, err: unknown): void {
    const last = this.lastErrorLog.get(serverId) || 0;
    if (Date.now() - last < 60 * 60 * 1000) return;
    this.lastErrorLog.set(serverId, Date.now());
    // eslint-disable-next-line no-console
    console.warn(`[discord] webhook delivery failed for ${serverId} (muted for 1h): ${err instanceof Error ? err.message : err}`);
  }

  // ---------------------------------------------------------------------
  // Event bridge: polls the events table (the single source of truth for
  // panel history) and forwards mapped rows to Discord. Polling instead of
  // hooking recordEvent keeps this module fully decoupled from every event
  // producer. NOTE: legacy calls startEventBridge() explicitly from server
  // boot; this port exposes the same method for a future main.ts wiring
  // (not auto-started via onModuleInit, to match the plan's guidance that
  // boot side effects stay explicit) — TODO(main.ts): wire
  // `discordService.startEventBridge()` into the bootstrap sequence once a
  // controller layer needs it wired for real notifications to flow.
  startEventBridge({ intervalMs = 15000 }: { intervalMs?: number } = {}): void {
    if (this.pollTimer) return;
    // Start at the current high-water mark: never replay pre-boot history.
    this.db
      .select({ id: events.id })
      .from(events)
      .orderBy(desc(events.id))
      .limit(1)
      .then(([latest]) => {
        this.lastSeenId = latest?.id ?? 0;
      })
      .catch((err: unknown) => console.warn('[discord] event bridge high-water mark lookup failed:', err instanceof Error ? err.message : err));
    this.pollTimer = setInterval(() => {
      this.pollOnce().catch((err) => console.warn('[discord] event bridge poll failed:', err instanceof Error ? err.message : err));
    }, intervalMs);
    this.pollTimer.unref?.();
  }

  onModuleDestroy(): void {
    this.stopEventBridge();
  }

  stopEventBridge(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  private async pollOnce(): Promise<void> {
    const rows = await this.db.select().from(events).where(gt(events.id, this.lastSeenId)).orderBy(events.id).limit(100);
    if (!rows.length) return;
    this.lastSeenId = rows[rows.length - 1]?.id ?? this.lastSeenId;

    for (const evt of rows) {
      const mapped = EVENT_MAP[evt.type];
      if (!mapped || !evt.serverId) continue;
      const [kind, category] = mapped;
      const cfg = await this.getConfig(evt.serverId);
      if (!cfg.enabled || !cfg.hasWebhook || !cfg.events[category]) continue;

      const [server] = await this.db.select({ displayName: servers.displayName }).from(servers).where(eq(servers.id, evt.serverId)).limit(1);
      await this.notify(evt.serverId, kind, {
        title: TITLES[evt.type] || evt.type,
        description: evt.summary,
        fields: [
          { name: 'Server', value: server ? server.displayName : evt.serverId },
          { name: 'By', value: evt.actor || 'system' },
        ],
      });
    }
  }
}
