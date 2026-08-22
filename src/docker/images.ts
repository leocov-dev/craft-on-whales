'use strict';

// Image management: ensure-pulled with progress, and digest comparison for
// "image update available" checks.

const { getDocker } = require('./connect') as typeof import('./connect');
const { config } = require('../config');

// Overridable via MC_IMAGE_REPO for a private mirror / air-gapped registry.
const IMAGE_REPO: string = config.mcImageRepo;

function imageRef(javaTag?: string | null): string {
  return javaTag ? `${IMAGE_REPO}:${javaTag}` : `${IMAGE_REPO}:latest`;
}

async function imageExists(ref: string): Promise<boolean> {
  try {
    await getDocker().getImage(ref).inspect();
    return true;
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) return false;
    throw err;
  }
}

interface PullProgress {
  status: string;
  current: number;
  total: number;
}

type OnProgress = (progress: PullProgress) => void;

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
 * Pull an image, invoking onProgress({status, layers, done}) as layers move.
 * Resolves when the pull completes.
 */
function pullImage(ref: string, onProgress: OnProgress = () => {}): Promise<void> {
  const docker = getDocker();
  return new Promise((resolve, reject) => {
    docker.pull(ref, {}, (err: Error | null, stream?: NodeJS.ReadableStream) => {
      if (err || !stream) return reject(err);
      const layers = new Map<string, ProgressLayerDetail>();
      docker.modem.followProgress(
        stream,
        (doneErr: Error | null) => (doneErr ? reject(doneErr) : resolve()),
        (evt: ProgressEvent) => {
          if (evt.id && evt.progressDetail) layers.set(evt.id, evt.progressDetail);
          let current = 0;
          let total = 0;
          for (const d of layers.values()) {
            current += d.current || 0;
            total += d.total || 0;
          }
          onProgress({ status: evt.status || '', current, total });
        }
      );
    });
  });
}

async function ensureImage(ref: string, onProgress?: OnProgress): Promise<void> {
  if (!(await imageExists(ref))) await pullImage(ref, onProgress);
}

/** Local digest for update comparison (RepoDigests sha). */
async function localDigest(ref: string): Promise<string | null> {
  try {
    const info = await getDocker().getImage(ref).inspect();
    const rd = info.RepoDigests && info.RepoDigests[0];
    return rd ? (rd.split('@')[1] ?? null) : null;
  } catch {
    return null;
  }
}

export { IMAGE_REPO, imageRef, imageExists, pullImage, ensureImage, localDigest };
