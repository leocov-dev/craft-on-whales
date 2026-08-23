import { z as zod } from 'zod';

// Portable .mcserver.zip snapshots of a server's full recipe (identity, env,
// resources, pinned pack, custom-mod overlay, config files, optionally
// embedded jars and world). Secrets are never written to a blueprint.

export const PANEL_VERSION = '0.1';
// Any env var whose NAME matches this is a secret and never leaves the panel.
export const SECRET_ENV_RE = /PASSWORD|TOKEN|KEY|SECRET/i;

export const KNOWN_TYPES = new Set([
  'VANILLA',
  'PAPER',
  'PURPUR',
  'PUFFERFISH',
  'LEAF',
  'FOLIA',
  'SPIGOT',
  'BUKKIT',
  'CANYON',
  'FABRIC',
  'QUILT',
  'FORGE',
  'NEOFORGE',
  'AUTO_CURSEFORGE',
  'MODRINTH',
  'FTBA',
  'CURSEFORGE',
  'PACKWIZ',
]);

// ---- Manifest schema (msm: 1) ----

export const overlayEntrySchema = zod.object({
  name: zod.string().min(1).max(200),
  kind: zod.enum(['mod', 'plugin', 'datapack', 'resourcepack']).default('mod'),
  filename: zod.string().max(200).nullable().default(null),
  sourceUrl: zod.string().max(1000).nullable().default(null),
  platform: zod.string().max(20).nullable().default(null),
  projectId: zod.string().max(60).nullable().default(null),
  fileId: zod.string().max(60).nullable().default(null),
  version: zod.string().max(120).nullable().default(null),
  // null = skip verification (e.g. starter blueprints resolve "latest compatible" at import time)
  sha256: zod
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable()
    .default(null),
});

export const manifestSchema = zod.object({
  msm: zod.literal(1),
  name: zod.string().trim().min(1).max(120),
  createdAt: zod.string().max(40),
  panelVersion: zod.string().max(20),
  notes: zod.string().max(4000).default(''),
  identity: zod.object({
    name: zod.string().trim().min(1).max(80),
    description: zod.string().max(4000).default(''),
    icon: zod.string().max(64).default('grass'),
    accent: zod
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .default('#3fa62b'),
    tags: zod.array(zod.string().max(24)).max(16).default([]),
  }),
  config: zod.object({
    type: zod.string().trim().min(1).max(32),
    mcVersion: zod.string().trim().min(1).max(32),
    javaTag: zod.string().max(16).default(''),
    env: zod.record(zod.string(), zod.string()).default({}),
  }),
  resources: zod.object({
    heapMb: zod.number().int().min(512).max(262144),
    containerMemoryMb: zod.number().int().min(1024).max(524288),
    cpus: zod.number().min(0).max(128),
    diskQuotaGb: zod.number().min(0).max(16384),
    quotaStrict: zod.boolean().default(false),
    updatePolicy: zod.enum(['manual', 'notify', 'auto']).default('manual'),
  }),
  pack: zod
    .object({
      platform: zod.enum(['curseforge', 'modrinth', 'ftb', 'gtnh']),
      projectRef: zod.string().min(1).max(400),
      projectName: zod.string().max(200).default(''),
      versionId: zod.string().min(1).max(60),
      versionName: zod.string().max(200).default(''),
    })
    .nullable()
    .default(null),
  overlay: zod.array(overlayEntrySchema).max(500).default([]),
  configFiles: zod.array(zod.string().min(1).max(300)).max(2000).default([]),
  embedFiles: zod.boolean().default(false),
  world: zod.boolean().default(false),
});

export type BlueprintManifest = zod.infer<typeof manifestSchema>;
export type OverlayEntry = zod.infer<typeof overlayEntrySchema>;

export interface ExportOptions {
  includeConfig?: boolean;
  embedFiles?: boolean;
  includeWorld?: boolean;
}

export interface ImportPreviewResult {
  manifest: BlueprintManifest;
  warnings: string[];
  entries: { count: number; payloadBytes: number };
}

export interface ImportReportItem {
  name: string;
  status: 'ok' | 'hash-mismatch' | 'failed';
  error?: string;
}

export interface ImportOverrides {
  name?: string;
  description?: string;
  icon?: string;
  accent?: string;
  tags?: string[];
  mcVersion?: string;
  heapMb?: number;
  containerMemoryMb?: number;
  cpus?: number;
  diskQuotaGb?: number;
  containerName?: string;
  networkName?: string;
  extraPorts?: unknown;
  extraBinds?: unknown;
}
