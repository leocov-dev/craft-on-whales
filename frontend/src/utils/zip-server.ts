// Pure helpers for the Modpacks page's "Upload zip" tab (create a server from a .mrpack or a
// zip of jars). Kept free of Vue/Quasar so `node --test` can run them.

import type { NewServerPreview } from './new-server';
import type { ServerFromZipPreview, ZipServerTarget } from '../../../shared/types/mods';

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

/** Map a zip preview to the shared dialog's model. */
export function zipPreviewToModel(p: ServerFromZipPreview): NewServerPreview {
  const warnings: string[] = [];
  if (p.targetError) warnings.push(p.targetError);
  if (p.indexFiles > 0)
    warnings.push(
      `${p.indexFiles} files from the pack index are downloaded when the server is created.`,
    );
  const caption = p.target
    ? describeZipTarget(p.target)
    : 'Loader and Minecraft version not detected';
  return {
    name: p.packName ?? p.archiveName,
    caption: p.packVersion ? `${caption} · ${p.packVersion}` : caption,
    items: p.jars.map((j) => ({
      name: j.name ?? j.filename,
      caption: [j.kind, j.version, j.name ? j.filename : null].filter(Boolean).join(' · ') || '—',
    })),
    itemsLabel: 'Jars',
    warnings,
  };
}

/** The "Upload zip" source: the archive and how to read it. */
export interface ZipSourceModel {
  file: File | null;
  loader: ZipLoaderChoice;
  /** '' = auto-detect. */
  mcVersion: string;
  applyOverrides: boolean;
}
