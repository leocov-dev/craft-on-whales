import { ConflictException } from '@nestjs/common';
import type { DownloadMeta } from '../library/library.service';
import type { BlockedDownload } from './mods.types';

const SOURCE_LABEL: Record<BlockedDownload['source'], string> = {
  curseforge: 'CurseForge',
  hangar: 'Hangar',
  spiget: 'SpigotMC',
};

function blockedMessage(b: BlockedDownload): string {
  const what = b.version ? `${b.name} ${b.version}` : b.name;
  const where = b.externalUrl || b.pageUrl;
  switch (b.reason) {
    case 'distribution-disabled':
      return `${what}: the author disallows automated downloads — download it from ${where}, then upload the jar`;
    case 'premium':
      return `${what} is a premium ${SOURCE_LABEL[b.source]} resource, so it can't be downloaded automatically — buy and download it at ${where}, then upload the jar`;
    case 'external':
      return `${what} isn't hosted on ${SOURCE_LABEL[b.source]}, so it can't be downloaded automatically — get it from ${where}, then upload the jar`;
  }
}

// externalUrl is whatever the project's author typed (Hangar, SpigotMC) and
// the UI renders it as a link, so only http(s) gets through.
function withSafeExternalUrl(b: BlockedDownload): BlockedDownload {
  return b.externalUrl && !/^https?:\/\//i.test(b.externalUrl)
    ? { ...b, externalUrl: null }
    : b;
}

/**
 * A registry file the panel won't download itself (see BlockedDownload).
 * The 409 body carries `blocked` for the UI's manual-upload fallback.
 * `meta` is the provenance the file would have been installed with. It stays
 * server-side (the exception filter only sends `getResponse()`); the manual
 * upload route re-resolves the link and uses it for the library row and the
 * hash check.
 */
export class BlockedDownloadException extends ConflictException {
  readonly blocked: BlockedDownload;

  constructor(
    blocked: BlockedDownload,
    readonly meta: DownloadMeta,
  ) {
    const safe = withSafeExternalUrl(blocked);
    super({
      statusCode: 409,
      error: 'Conflict',
      message: blockedMessage(safe),
      blocked: safe,
    });
    this.blocked = safe;
  }
}
