import { Injectable } from '@nestjs/common';
import { ConfigService } from '../config/config.service';
import { DockerConnectionService } from './docker-connection.service';

export interface PullProgress {
  status: string;
  current: number;
  total: number;
}

export type OnProgress = (progress: PullProgress) => void;

interface ProgressLayerDetail {
  current?: number;
  total?: number;
}

interface ProgressEvent {
  id?: string;
  status?: string;
  progressDetail?: ProgressLayerDetail;
}

/**
 * Image management: ensure-pulled with progress, and digest comparison for
 * "image update available" checks.
 */
@Injectable()
export class DockerImagesService {
  /** Overridable via MC_IMAGE_REPO for a private mirror / air-gapped registry. */
  readonly imageRepo: string;

  constructor(
    private readonly config: ConfigService,
    private readonly connection: DockerConnectionService,
  ) {
    this.imageRepo = this.config.mcImageRepo;
  }

  imageRef(javaTag?: string | null): string {
    return javaTag
      ? `${this.imageRepo}:${javaTag}`
      : `${this.imageRepo}:latest`;
  }

  async imageExists(ref: string): Promise<boolean> {
    try {
      await this.connection.getDocker().getImage(ref).inspect();
      return true;
    } catch (err: unknown) {
      if ((err as { statusCode?: number }).statusCode === 404) return false;
      throw err;
    }
  }

  /**
   * Pull an image, invoking onProgress({status, layers, done}) as layers
   * move. Resolves when the pull completes.
   */
  pullImage(ref: string, onProgress: OnProgress = () => {}): Promise<void> {
    const docker = this.connection.getDocker();
    return new Promise((resolve, reject) => {
      docker.pull(
        ref,
        {},
        (err: Error | null, stream?: NodeJS.ReadableStream) => {
          if (err || !stream) return reject(err);
          const layers = new Map<string, ProgressLayerDetail>();
          docker.modem.followProgress(
            stream,
            (doneErr: Error | null) => (doneErr ? reject(doneErr) : resolve()),
            (evt: ProgressEvent) => {
              if (evt.id && evt.progressDetail)
                layers.set(evt.id, evt.progressDetail);
              let current = 0;
              let total = 0;
              for (const d of layers.values()) {
                current += d.current || 0;
                total += d.total || 0;
              }
              onProgress({ status: evt.status || '', current, total });
            },
          );
        },
      );
    });
  }

  async ensureImage(ref: string, onProgress?: OnProgress): Promise<void> {
    if (!(await this.imageExists(ref))) await this.pullImage(ref, onProgress);
  }

  /** Local digest for update comparison (RepoDigests sha). */
  async localDigest(ref: string): Promise<string | null> {
    try {
      const info = await this.connection.getDocker().getImage(ref).inspect();
      const rd = info.RepoDigests && info.RepoDigests[0];
      return rd ? (rd.split('@')[1] ?? null) : null;
    } catch {
      return null;
    }
  }
}
