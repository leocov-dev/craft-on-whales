// Pure types for the Modpacks page's create-server flow, shared by its components.

/** The settings every "new server from a pack" mode shares, whatever the pack source. */
export interface NewServerSettingsModel {
  name: string;
  portGame: number | undefined;
  diskQuotaGb: number;
  heapMb: number;
  containerMemoryMb: number;
}

/** A pack-agnostic preview of what a create would make; the Modpacks page's one preview dialog renders it. */
export interface NewServerPreview {
  name: string;
  iconUrl?: string | null | undefined;
  caption: string;
  /** Trusted pack-registry HTML, as in PackDetailsDialog. */
  description?: string | undefined;
  items: { name: string; caption: string }[];
  itemsLabel: string;
  warnings: string[];
}
