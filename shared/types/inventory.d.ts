/** [{id, lvl}] enchantment entry, normalized from either NBT container shape. */
export interface NormalizedEnchant {
  id: string;
  lvl: number;
}

/** A normalized simplified-NBT item stack. */
export interface NormalizedItem {
  slot: number | null;
  id: string;
  count: number;
  displayName?: string;
  enchants?: NormalizedEnchant[];
  damage?: number;
  /** Only present via the deep-normalize path — nested backpack/shulker contents. */
  nested?: NestedInventory[];
}

/** One nested item-list entry inside a NestedInventory. */
export interface NestedInventoryEntry {
  index: number;
  id: string | null;
  slot: number | null;
  count?: number;
  displayName?: string;
  enchants?: NormalizedEnchant[];
  damage?: number;
  nested?: NestedInventory[];
  wrapped?: boolean;
}

/** One nested item list (backpack/shulker/bundle contents) found inside an item. */
export interface NestedInventory {
  path: (string | number)[];
  label: string;
  items: NestedInventoryEntry[];
}

/** `GET /api/servers/:id/inventory/players` list entry — no full data loaded yet. */
export interface PlayerWithData {
  uuid: string;
  name: string | null;
  lastModified: number;
}

/** `GET /api/servers/:id/inventory/player/:uuid`'s player payload. */
export interface PlayerInventoryData {
  uuid: string;
  name: string | null;
  inventory: NormalizedItem[];
  enderChest: NormalizedItem[];
  armor: (NormalizedItem & { piece: string })[];
  offhand: NormalizedItem | null;
  pos: { x: number; y: number; z: number; dimension: string | null } | null;
  health: number | null;
  xpLevel: number | null;
  lastModified: number;
}
