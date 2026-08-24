import { Injectable } from '@nestjs/common';
import { PassThrough } from 'node:stream';
import { DockerConnectionService } from './docker-connection.service';
import { ContainerService } from './container.service';

export interface FetchLogsOptions {
  tail?: number;
  timestamps?: boolean;
}

export interface FollowLogsResult {
  stream: PassThrough;
  stop: () => void;
}

/**
 * Container log access: bounded fetch for page loads + follow streams for
 * the WebSocket console. itzg containers run without TTY, so output arrives
 * in Docker's multiplexed framing and must be demuxed.
 */
@Injectable()
export class DockerLogsService {
  constructor(
    private readonly connection: DockerConnectionService,
    private readonly containers: ContainerService,
  ) {}

  /**
   * Fetch the last `tail` lines as a string. Pass `timestamps: true` to
   * prefix each line with Docker's RFC3339 receive time (used by analytics
   * ingest to timestamp events independently of the container's TZ).
   */
  async fetchLogs(
    serverId: string,
    { tail = 500, timestamps = false }: FetchLogsOptions = {},
  ): Promise<string> {
    try {
      const buf = await (
        await this.containers.getContainer(serverId)
      ).logs({
        stdout: true,
        stderr: true,
        tail,
        timestamps,
      });
      return this.demuxBuffer(buf);
    } catch (err: unknown) {
      if ((err as { statusCode?: number }).statusCode === 404) return '';
      throw err;
    }
  }

  /**
   * Follow logs from now on. Returns { stream, stop } where stream emits
   * utf8 lines-ish chunks. Caller must stop() on WebSocket close.
   */
  async followLogs(
    serverId: string,
    { tail = 200, timestamps = false }: FetchLogsOptions = {},
  ): Promise<FollowLogsResult> {
    const container = await this.containers.getContainer(serverId);
    const raw = await container.logs({
      stdout: true,
      stderr: true,
      follow: true,
      tail,
      timestamps,
    });
    const out = new PassThrough();
    this.connection.getDocker().modem.demuxStream(raw, out, out);
    raw.on('end', () => out.end());
    raw.on('error', () => out.end());
    return {
      stream: out,
      stop: () => {
        try {
          (raw as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
        } catch {
          /* already closed */
        }
      },
    };
  }

  /** Docker multiplexed log buffer → plain text (strips 8-byte frame headers). */
  demuxBuffer(buf: Buffer | string): string {
    if (!Buffer.isBuffer(buf)) return String(buf);
    const parts: string[] = [];
    let offset = 0;
    while (offset + 8 <= buf.length) {
      const type = buf[offset];
      if (type !== 0 && type !== 1 && type !== 2) {
        // Not framed (TTY container) — return as-is from here.
        parts.push(buf.subarray(offset).toString('utf8'));
        break;
      }
      const size = buf.readUInt32BE(offset + 4);
      parts.push(buf.subarray(offset + 8, offset + 8 + size).toString('utf8'));
      offset += 8 + size;
    }
    return parts.join('');
  }
}
