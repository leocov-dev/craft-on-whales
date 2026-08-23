import { Injectable, NotFoundException } from '@nestjs/common';
import { asc, eq, isNull, and } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { servers } from '../db/schema';
import type { Server } from './types';

type ServerRow = typeof servers.$inferSelect;

/**
 * Read-only access to `servers` rows, normalized into the `Server` shape
 * every other service works with. Not named directly in the plan's SOLID
 * split, but pulled out as its own service (judgment call) since
 * ServerLifecycleService, ServerEnvironmentService, and ServerPreviewService
 * all need identical row-reading/mapping logic — better a single source of
 * truth than three copies.
 */
@Injectable()
export class ServerQueryService {
  constructor(private readonly dbService: DbService) {}

  private get db() {
    return this.dbService.db;
  }

  private rowToServer(row: ServerRow | undefined): Server | null {
    if (!row) return null;
    return {
      id: row.id,
      display_name: row.displayName,
      description: row.description,
      icon: row.icon,
      accent: row.accent,
      tags: JSON.parse(row.tagsJson || '[]'),
      notes: row.notes,
      type: row.type,
      mc_version: row.mcVersion,
      java_tag: row.javaTag,
      env: JSON.parse(row.envJson || '{}'),
      port_game: row.portGame,
      port_rcon: row.portRcon,
      port_query: row.portQuery,
      port_bedrock: row.portBedrock,
      rcon_password_cipher: row.rconPasswordCipher,
      heap_mb: row.heapMb,
      container_memory_mb: row.containerMemoryMb,
      container_swap_mb: row.containerSwapMb,
      cpus: row.cpus,
      disk_quota_bytes: row.diskQuotaBytes,
      quota_strict: row.quotaStrict ? 1 : 0,
      update_policy: row.updatePolicy as Server['update_policy'],
      auto_start: row.autoStart ? 1 : 0,
      auto_restart: row.autoRestart ? 1 : 0,
      container_id: row.containerId,
      pending_recreate: row.pendingRecreate ? 1 : 0,
      status: row.status,
      last_started_at: row.lastStartedAt,
      created_at: row.createdAt,
      deleted_at: row.deletedAt,
      console_label: row.consoleLabel,
      container_name: row.containerName,
      network_name: row.networkName,
      containerName: row.containerName,
      networkName: row.networkName,
      router_hostname: row.routerHostname,
      router_auto_scale: row.routerAutoScale,
      routerHostname: row.routerHostname,
      routerAutoScale: row.routerAutoScale,
      extraPorts: JSON.parse(row.extraPortsJson || '[]'),
      extraBinds: JSON.parse(row.extraBindsJson || '[]'),
    };
  }

  async listServers(): Promise<Server[]> {
    const rows = await this.db.select().from(servers).where(isNull(servers.deletedAt)).orderBy(asc(servers.createdAt));
    return rows.map((r) => this.rowToServer(r)).filter((s): s is Server => s !== null);
  }

  async getServer(id: string): Promise<Server | null> {
    const [row] = await this.db
      .select()
      .from(servers)
      .where(and(eq(servers.id, id), isNull(servers.deletedAt)))
      .limit(1);
    return this.rowToServer(row);
  }

  async mustGet(id: string): Promise<Server> {
    const server = await this.getServer(id);
    if (!server) throw new NotFoundException('Server not found');
    return server;
  }
}
