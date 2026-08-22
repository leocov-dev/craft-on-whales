'use strict';

// Shared types for src/services/inventory.ts and src/services/inventory/nbt.ts.
// Extracted to their own type-only file (rather than living in either module
// alongside its `export =`) because tsx's esbuild-based CJS loader transforms
// each file independently and can silently drop type-only exports mixed into
// a file that also has a CommonJS `export =` value statement.

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
  /** Only present via normalizeItemDeep — nested backpack/shulker contents. */
  nested?: NestedInventory[];
}

/** One nested item-list entry inside detectNestedInventories' result item. */
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
