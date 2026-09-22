import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { servers, userServerPermissions, users } from '../db/schema';
import { EventsService } from '../events/events.service';
import type { Role } from '../auth/auth.service';

/** A user identity shape narrow enough for every permission check below. */
export interface PermissionSubject {
  id: string;
  role: Role;
}

/**
 * Every capability, in display/storage order. `view` is the baseline: every
 * other capability implies it (see `normalize()`), and a user with none of
 * these on a server cannot see it at all — see PERMISSIONS_NOTES.md.
 */
export const CAPABILITIES = [
  'view',
  'power',
  'console',
  'players',
  'content',
  'backups',
  'files',
  'settings',
  'delete',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

const CAP_SET: ReadonlySet<string> = new Set(CAPABILITIES);
const ALL: Capability[] = [...CAPABILITIES];

/** One line of copy per capability, for the admin Permissions UI. */
export const CAPABILITY_INFO: Record<
  Capability,
  { label: string; help: string }
> = {
  view: {
    label: 'View',
    help: 'See the server, its status, console output, players, and stats. Without View the server does not exist for this user anywhere in the panel.',
  },
  power: {
    label: 'Power',
    help: 'Start, stop, restart, kill, and rebuild the server; schedule power actions.',
  },
  console: {
    label: 'Console',
    help: 'Run console/RCON commands, send chat, and use world quick actions.',
  },
  players: {
    label: 'Players',
    help: 'Kick, ban, pardon, whitelist, op, and teleport players.',
  },
  content: {
    label: 'Content',
    help: 'Install/remove mods, plugins, and packs; manage worlds and inventories.',
  },
  backups: {
    label: 'Backups',
    help: 'Create, restore, download, and delete backups.',
  },
  files: {
    label: 'Files',
    help: 'Browse, edit, upload, and download server files, logs, and crash reports; export blueprints.',
  },
  settings: {
    label: 'Settings',
    help: 'Change server settings, properties, integrations, icon, and versions.',
  },
  delete: {
    label: 'Delete',
    help: 'Delete the server.',
  },
};

/**
 * Global-role defaults. `admin` is never overridden by a per-server grant
 * (see `effective()`), but `operator`'s ALL default and `viewer`'s
 * view-only default are both just the starting point — an explicit
 * `user_server_permissions` row for either role replaces it for that one
 * server.
 */
export const ROLE_DEFAULTS: Record<Role, Capability[]> = {
  admin: ALL,
  operator: ALL,
  viewer: ['view'],
};

/**
 * Canonical form of a capability list: known names only, deduplicated, in
 * catalog order, and `view` implied by any other capability. Throws 400 on
 * an unknown name so a typo in an API call is never silently stored.
 */
export function normalize(input: unknown): Capability[] {
  if (!Array.isArray(input)) {
    throw new BadRequestException(
      'Permissions must be a list of capability names.',
    );
  }
  const set = new Set<string>();
  for (const raw of input) {
    const cap = String(raw);
    if (!CAP_SET.has(cap)) {
      throw new BadRequestException(`Unknown permission "${cap}".`);
    }
    set.add(cap);
  }
  if (set.size > 0) set.add('view');
  return CAPABILITIES.filter((c) => set.has(c));
}

/** Parse a stored `perms` cell: JSON array, falling back to a comma list. */
function parseStored(text: string | null | undefined): Capability[] {
  if (text == null) return [];
  const s = String(text).trim();
  if (!s) return [];
  try {
    const parsed: unknown = JSON.parse(s);
    if (Array.isArray(parsed)) {
      return CAPABILITIES.filter((c) => parsed.includes(c));
    }
  } catch {
    // Not JSON — fall through to the legacy comma form (matches the
    // column's `default('view')` seed value).
  }
  const parts = s.split(',').map((p) => p.trim());
  return CAPABILITIES.filter((c) => parts.includes(c));
}

export function roleDefault(role: Role): Capability[] {
  return ROLE_DEFAULTS[role] ?? [];
}

/**
 * Answers "may user X do CAP on server Z" everywhere in the app — the one
 * thing every server-scoped guard, gateway, and list endpoint consults. See
 * `PERMISSIONS_NOTES.md` for the full design writeup.
 */
@Injectable()
export class PermissionsService {
  constructor(
    private readonly dbService: DbService,
    private readonly events: EventsService,
  ) {}

  private get db() {
    return this.dbService.db;
  }

  /** The explicit grant row for one pair, or `null` when the role default applies. */
  async getGrant(
    userId: string,
    serverId: string,
  ): Promise<Capability[] | null> {
    const [row] = await this.db
      .select({ perms: userServerPermissions.perms })
      .from(userServerPermissions)
      .where(
        and(
          eq(userServerPermissions.userId, userId),
          eq(userServerPermissions.serverId, serverId),
        ),
      )
      .limit(1);
    if (!row) return null;
    return parseStored(row.perms);
  }

  /** Effective capabilities for a user on one server. Admin always gets ALL. */
  async effective(
    user: PermissionSubject | null | undefined,
    serverId: string,
  ): Promise<Capability[]> {
    if (!user) return [];
    if (user.role === 'admin') return ALL;
    const grant = await this.getGrant(user.id, serverId);
    return grant === null ? roleDefault(user.role) : grant;
  }

  async can(
    user: PermissionSubject | null | undefined,
    serverId: string,
    cap: Capability,
  ): Promise<boolean> {
    if (!CAP_SET.has(cap)) throw new Error(`Unknown capability: ${cap}`);
    const eff = await this.effective(user, serverId);
    return eff.includes(cap);
  }

  /**
   * Ids of every server the user may see. Includes soft-deleted servers on
   * purpose (a server hidden from someone stays hidden in their history and
   * kept backups too, and vice versa — a user who could view it keeps
   * seeing it there after deletion), so this is safe to apply to fleet-wide
   * lists over `servers`, `backups`, and `events` alike.
   */
  async visibleServerIds(
    user: PermissionSubject | null | undefined,
  ): Promise<Set<string>> {
    const all = new Set(
      (await this.db.select({ id: servers.id }).from(servers)).map((r) => r.id),
    );
    if (!user) return new Set();
    if (user.role === 'admin') return all;

    const rows = await this.db
      .select({
        serverId: userServerPermissions.serverId,
        perms: userServerPermissions.perms,
      })
      .from(userServerPermissions)
      .where(eq(userServerPermissions.userId, user.id));
    const defaultSees = roleDefault(user.role).includes('view');
    if (rows.length === 0) return defaultSees ? all : new Set();

    const overridden = new Map(
      rows.map((r) => [r.serverId, parseStored(r.perms)]),
    );
    const out = new Set<string>();
    for (const id of all) {
      const grant = overridden.get(id);
      const sees = grant === undefined ? defaultSees : grant.length > 0;
      if (sees) out.add(id);
    }
    return out;
  }

  /** Filter any array of server-ish rows (`id` field) to the ones the user may see. */
  async filterVisible<T extends { id: string }>(
    user: PermissionSubject | null | undefined,
    rows: T[],
  ): Promise<T[]> {
    if (user && user.role === 'admin') return rows;
    const ids = await this.visibleServerIds(user);
    return rows.filter((r) => ids.has(r.id));
  }

  /**
   * The full matrix for the admin Permissions page: every non-admin user ×
   * every live server, with the explicit grant (`null` = role default) and
   * the resolved effective list.
   */
  async listMatrix(): Promise<{
    capabilities: { key: Capability; label: string; help: string }[];
    users: { id: string; username: string; role: Role }[];
    servers: { id: string; name: string }[];
    rows: {
      user: { id: string; username: string; role: Role };
      roleDefault: Capability[];
      servers: {
        serverId: string;
        grant: Capability[] | null;
        effective: Capability[];
      }[];
    }[];
  }> {
    const userRows = await this.db
      .select({ id: users.id, username: users.username, role: users.role })
      .from(users);
    const nonAdmin = userRows
      .filter((u) => u.role !== 'admin')
      .map((u) => ({ id: u.id, username: u.username, role: u.role as Role }))
      .sort((a, b) => a.username.localeCompare(b.username));

    const serverRows = await this.db
      .select({ id: servers.id, name: servers.displayName })
      .from(servers)
      .where(isNull(servers.deletedAt));
    const liveServers = [...serverRows].sort((a, b) =>
      a.name.localeCompare(b.name),
    );

    const grantRows = await this.db
      .select({
        userId: userServerPermissions.userId,
        serverId: userServerPermissions.serverId,
        perms: userServerPermissions.perms,
      })
      .from(userServerPermissions);
    const grants = new Map(
      grantRows.map((r) => [`${r.userId}|${r.serverId}`, parseStored(r.perms)]),
    );

    const rows = nonAdmin.map((u) => ({
      user: u,
      roleDefault: roleDefault(u.role),
      servers: liveServers.map((s) => {
        const grant = grants.get(`${u.id}|${s.id}`);
        return {
          serverId: s.id,
          grant: grant === undefined ? null : grant,
          effective: grant === undefined ? roleDefault(u.role) : grant,
        };
      }),
    }));

    return {
      capabilities: CAPABILITIES.map((c) => ({
        key: c,
        ...CAPABILITY_INFO[c],
      })),
      users: nonAdmin,
      servers: liveServers,
      rows,
    };
  }

  /**
   * Set (or with `perms === null`, clear) the explicit grant for one pair.
   * `[]` hides the server from that user entirely.
   */
  async setGrant(
    userId: string,
    serverId: string,
    perms: unknown,
    opts: { actor: string },
  ): Promise<{ grant: Capability[] | null; effective: Capability[] }> {
    const [user] = await this.db
      .select({ id: users.id, username: users.username, role: users.role })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!user) throw new NotFoundException('That user no longer exists.');
    if (user.role === 'admin') {
      throw new ConflictException(
        'Admins always have every permission. Change their role first.',
      );
    }
    const [server] = await this.db
      .select({ id: servers.id, name: servers.displayName })
      .from(servers)
      .where(and(eq(servers.id, serverId), isNull(servers.deletedAt)))
      .limit(1);
    if (!server) throw new NotFoundException('That server no longer exists.');

    if (perms === null) {
      await this.db
        .delete(userServerPermissions)
        .where(
          and(
            eq(userServerPermissions.userId, userId),
            eq(userServerPermissions.serverId, serverId),
          ),
        );
      this.events.recordEvent({
        serverId,
        actor: opts.actor,
        type: 'permissions-changed',
        summary: `Permissions for ${user.username} on ${server.name} reset to the ${user.role} default.`,
        details: { userId, serverId, grant: null },
      });
      return { grant: null, effective: roleDefault(user.role as Role) };
    }

    const list = normalize(perms);
    await this.db
      .insert(userServerPermissions)
      .values({ userId, serverId, perms: JSON.stringify(list) })
      .onConflictDoUpdate({
        target: [userServerPermissions.userId, userServerPermissions.serverId],
        set: { perms: JSON.stringify(list) },
      });
    this.events.recordEvent({
      serverId,
      actor: opts.actor,
      type: 'permissions-changed',
      summary: list.length
        ? `Permissions for ${user.username} on ${server.name} set to ${list.join(', ')}.`
        : `${server.name} hidden from ${user.username}.`,
      details: { userId, serverId, grant: list },
    });
    return { grant: list, effective: list };
  }
}
