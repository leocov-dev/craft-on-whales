export type ContentKind = 'mod' | 'plugin' | 'datapack' | 'resourcepack';

/** `GET /api/servers/:id/mods` row shape. */
export interface ContentItem {
  id: string | null;
  name: string;
  file: string;
  kind: ContentKind;
  source: string;
  version: string | null;
  size: number;
  enabled: boolean;
  disabledVia?: null;
  missing?: boolean;
  sharedWith: number | null;
  iconUrl: string | null;
  updateAvailable?: string | null;
  /** The zip / .mrpack import that installed this row (see ContentImportSummary), if any. */
  importId?: string | null;
}

/** What kind of archive a Mods-tab import was. */
export type ContentImportFormat = 'mrpack' | 'jars';

/** Which identification layer recognized a jar (backend JarIdentifierService). */
export type JarIdentitySource = 'modrinth' | 'curseforge' | 'metadata' | 'unknown';

/** `GET /api/servers/:id/mods/imports` row, also `ContentImportReport.import`. */
export interface ContentImportSummary {
  id: string;
  format: ContentImportFormat;
  name: string;
  version: string | null;
  actor: string;
  createdAt: string;
  /** server_content rows still attached to this import. */
  contentCount: number;
  /** Override files still tracked for revert. */
  overrideCount: number;
}

/** A jar the import installed as a panel-managed (overlay) server_content row. */
export interface ContentImportInstalled {
  contentId: string;
  /** Installed filename in mods/ or plugins/. */
  filename: string;
  /** Where the jar was in the archive (or the `path` a .mrpack index gave it). */
  path: string;
  name: string;
  version: string | null;
  kind: 'mod' | 'plugin';
  /** `bundled`: the jar was inside the archive. `download`: fetched from a .mrpack index URL. */
  origin: 'bundled' | 'download';
  source: JarIdentitySource;
  platform: 'modrinth' | 'curseforge' | null;
  projectId: string | null;
  iconUrl: string | null;
}

export type ContentImportSkipReason =
  | 'client-only' // .mrpack env.server === "unsupported"
  | 'not-a-mod' // .mrpack file outside mods/ or plugins/ (resource/shader packs, …)
  | 'wrong-kind' // a plugin on a mod server, or the reverse
  | 'wrong-loader' // identified for loaders this server doesn't run
  | 'already-installed' // a file with that name is already in the content dir
  | 'duplicate'; // a second jar with the same filename in the same archive

export interface ContentImportSkipped {
  name: string;
  path: string;
  reason: ContentImportSkipReason;
  /** Human-readable specifics, e.g. "built for forge; server runs fabric". */
  detail?: string;
}

export interface ContentImportFailed {
  name: string;
  path: string;
  error: string;
}

export interface ContentImportOverrideWrite {
  /** Path relative to the server directory, `/`-separated. */
  path: string;
  /** `replaced`: a file was there and is backed up for revert. `created`: revert deletes it. */
  action: 'created' | 'replaced';
}

/** The result of `POST /api/servers/:id/mods/import` — the finished task's `result`. */
export interface ContentImportReport {
  /** null when nothing was installed or written (no import row was kept). */
  import: ContentImportSummary | null;
  pack: {
    format: ContentImportFormat;
    /** .mrpack: the index's `name`/`versionId`. Jar zips: the uploaded filename. */
    name: string;
    version: string | null;
    /** .mrpack only (`dependencies`); null for jar zips. */
    mcVersion: string | null;
    loader: string | null;
    loaderVersion: string | null;
  };
  installed: ContentImportInstalled[];
  skipped: ContentImportSkipped[];
  failed: ContentImportFailed[];
  overrides: {
    /** false when the request set applyOverrides=false or the apply failed (see `warnings`). */
    applied: boolean;
    written: ContentImportOverrideWrite[];
    /**
     * Override paths not written. `not-a-file`: a directory or symlink is at
     * that path on the server. `reserved`: inside the panel's `.import-backups/`.
     * `disabled`: the request set applyOverrides=false.
     */
    skipped: { path: string; reason: 'not-a-file' | 'reserved' | 'disabled' }[];
  };
  /** Pack-level notes, e.g. a Minecraft or loader mismatch with this server. */
  warnings: string[];
}

/** `DELETE /api/servers/:id/mods/imports/:importId` result. */
export interface ContentImportRemoval {
  /** Filenames of the server_content rows removed. */
  removedContent: string[];
  overrides: {
    /** Files put back to what was there before the import. */
    restored: string[];
    /** Files the import created, deleted. */
    deleted: string[];
    /** Files changed or removed after the import; left as they are. */
    kept: string[];
  };
}

/** Loaders `POST /api/servers/from-zip` can create a server for. */
export type ZipServerLoader = 'fabric' | 'forge' | 'neoforge' | 'quilt' | 'paper';

/** What `POST /api/servers/from-zip` created the server as. */
export interface ZipServerTarget {
  loader: ZipServerLoader;
  mcVersion: string;
  /** The .mrpack's own loader build, when the server runs the pack's loader. */
  loaderVersion: string | null;
}

/** `POST /api/servers/from-zip` task result. */
export interface ServerFromZipResult {
  serverId: string;
  name: string;
  target: ZipServerTarget;
  report: ContentImportReport;
  /** Set when the server was created and filled but didn't start. */
  startError: string | null;
}

/** `GET /api/servers/:id/pending-downloads` row shape. */
export interface PendingDownload {
  name: string;
  versionName: string;
  filename: string;
  url: string;
  slug: string | null;
  fileId: string | null;
}
