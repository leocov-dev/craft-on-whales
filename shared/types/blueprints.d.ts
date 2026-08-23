/** `GET /api/blueprints`'s listing entry, and the shape `POST /export`/`/clone`'s `blueprint` field returns. */
export interface BlueprintViewModel {
  id: string;
  name: string;
  filename: string;
  rel_path: string;
  size_bytes: number;
  builtin: boolean;
  created_at: string;
  created: string;
  notes: string;
  pack: string | null;
  overlayCount: number;
  type: string;
  mcVersion: string;
  world: boolean;
}

export interface BlueprintManifest {
  identity?: { name?: string; description?: string };
  notes?: string;
  config: { type: string; mcVersion: string };
  pack?: { projectName?: string; projectRef?: string; versionName?: string; versionId?: string };
  overlay?: unknown[];
  world?: unknown;
  configFiles: string[];
}

export interface ImportPreview {
  manifest: BlueprintManifest;
  warnings: string[];
  entries: { count: number; payloadBytes: number };
}
