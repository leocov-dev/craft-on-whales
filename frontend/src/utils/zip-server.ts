// Pure helpers for the Modpacks page's "Upload zip" tab (create a server from a .mrpack or a
// zip of jars). Kept free of Vue/Quasar so `node --test` can run them.

import type { ZipServerTarget } from '../../../shared/types/mods';

/** The loader choices, in display order. 'auto' lets the backend read it from the archive. */
export const ZIP_LOADER_OPTIONS = [
  { label: 'Auto-detect', value: 'auto' },
  { label: 'Fabric', value: 'fabric' },
  { label: 'Quilt', value: 'quilt' },
  { label: 'Forge', value: 'forge' },
  { label: 'NeoForge', value: 'neoforge' },
  { label: 'Paper (plugins)', value: 'paper' },
] as const;

export type ZipLoaderChoice = (typeof ZIP_LOADER_OPTIONS)[number]['value'];

/** A server-name suggestion from the uploaded file's name: extension dropped, separators spaced. */
export function serverNameFromArchive(filename: string, maxLen = 80): string {
  return filename
    .replace(/\.(zip|mrpack)$/i, '')
    .replace(/[_+]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen)
    .trim();
}

const LOADER_LABELS: Record<ZipServerTarget['loader'], string> = {
  fabric: 'Fabric',
  quilt: 'Quilt',
  forge: 'Forge',
  neoforge: 'NeoForge',
  paper: 'Paper',
};

/** "Fabric 0.16.5 · Minecraft 1.21.1": what the server was created as. */
export function describeZipTarget(t: ZipServerTarget): string {
  const loader = t.loaderVersion
    ? `${LOADER_LABELS[t.loader]} ${t.loaderVersion}`
    : LOADER_LABELS[t.loader];
  return `${loader} · Minecraft ${t.mcVersion}`;
}
