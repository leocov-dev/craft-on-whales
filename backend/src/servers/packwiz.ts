import type { Server } from './types';

/**
 * Whether a server's content comes from a packwiz pack. The image has no
 * `TYPE=PACKWIZ`: a packwiz server keeps its real loader as `type` and is
 * marked only by the `PACKWIZ_URL` it is installed with (packs.service removes
 * it again when the pack is replaced). `type === 'PACKWIZ'` is a legacy value
 * `PackwizTypeSweepService` repairs at boot.
 */
export function isPackwizServer(server: Pick<Server, 'type' | 'env'>): boolean {
  return server.type === 'PACKWIZ' || Boolean(server.env.PACKWIZ_URL);
}
