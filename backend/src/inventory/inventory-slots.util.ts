// God-mode slot editing — pure functions operating on raw prismarine-nbt
// trees ({type, value} tags) and RCON slot-name addressing. Ported verbatim
// from the "God-mode slot editing" section of src/services/inventory.ts. No
// DI — the raw tree is genuinely dynamic (arbitrary modded NBT), so it's
// typed `any` rather than forced through prismarine-nbt's Tags union.
//
// Two mechanisms exist for actually applying an edit (RCON while online,
// direct .dat rewrite while offline) — that orchestration lives in
// InventoryService; this file only has the mutation primitives both paths
// share (the offline path uses these directly, the online path uses
// resolveSlot/clampCount for validation and rconSlot addressing).

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { NESTED_MAX_PATH, NESTED_KEY_RE } from './nbt-codec';

// Vanilla armor slot numbers inside the playerdata Inventory list.
export const ARMOR_SLOTS: Record<number, string> = {
  100: 'feet',
  101: 'legs',
  102: 'chest',
  103: 'head',
};
export const OFFHAND_SLOT = -106;

const ARMOR_PIECES = ['head', 'chest', 'legs', 'feet'];
// 1.21.5 (DataVersion 4325) moved armor/offhand into the `equipment` compound.
const EQUIPMENT_DATAVERSION = 4325;
const MAX_STACK = 99; // `item replace` count argument limit — mirrored offline

export type ContainerName =
  'hotbar' | 'inventory' | 'enderchest' | 'armor' | 'offhand';

interface SlotContainerDef {
  size: number;
  kind: 'list' | 'equipment';
  list?: string;
  base?: number;
  pieces?: string[];
  legacy?: number[];
  rcon: (n: number) => string;
}

const SLOT_CONTAINERS: Record<ContainerName, SlotContainerDef> = {
  hotbar: {
    size: 9,
    kind: 'list',
    list: 'Inventory',
    base: 0,
    rcon: (n) => `hotbar.${n}`,
  },
  inventory: {
    size: 27,
    kind: 'list',
    list: 'Inventory',
    base: 9,
    rcon: (n) => `inventory.${n}`,
  },
  enderchest: {
    size: 27,
    kind: 'list',
    list: 'EnderItems',
    base: 0,
    rcon: (n) => `enderchest.${n}`,
  },
  armor: {
    size: 4,
    kind: 'equipment',
    pieces: ARMOR_PIECES,
    legacy: [103, 102, 101, 100],
    rcon: (n) => `armor.${ARMOR_PIECES[n]}`,
  },
  offhand: {
    size: 1,
    kind: 'equipment',
    pieces: ['offhand'],
    legacy: [OFFHAND_SLOT],
    rcon: () => 'weapon.offhand',
  },
};

export interface SlotSpec {
  container: ContainerName;
  slot: number;
  kind: 'list' | 'equipment';
  list: string | null;
  nbtSlot: number;
  piece: string | null;
  rconSlot: string;
}

/** Validate container + slot; resolve every addressing scheme at once. */
export function resolveSlot(
  container: string,
  slot: number | string,
): SlotSpec {
  const def = SLOT_CONTAINERS[container as ContainerName];
  if (!def) throw new BadRequestException(`Unknown container "${container}"`);
  const n = Math.trunc(Number(slot));
  if (!Number.isInteger(n) || n < 0 || n >= def.size) {
    throw new BadRequestException(
      `Slot ${slot} is out of range for ${container} (0-${def.size - 1})`,
    );
  }
  return {
    container: container as ContainerName,
    slot: n,
    kind: def.kind,
    list: def.kind === 'list' ? def.list! : null,
    nbtSlot: def.kind === 'list' ? def.base! + n : def.legacy![n]!,
    piece: def.kind === 'equipment' ? def.pieces![n]! : null,
    rconSlot: def.rcon(n),
  };
}

export function clampCount(count: number): number {
  return Math.min(MAX_STACK, Math.max(1, Math.trunc(Number(count) || 1)));
}

// --------------------------------------------------------------- raw tags

const tag = {
  byte: (v: number) => ({ type: 'byte', value: v }),
  int: (v: number) => ({ type: 'int', value: v }),
  string: (v: string) => ({ type: 'string', value: v }),
};

/** Fresh 1.20.5+ item stack (no components). */
export function makeRawItem(id: string, count: number): any {
  return { id: tag.string(id), count: tag.int(count) };
}

/** Set an item's count, preserving the field flavor (modern int / legacy byte). */
export function setRawCount(itemValue: any, count: number): void {
  if (itemValue.count) itemValue.count.value = count;
  else if (itemValue.Count) itemValue.Count.value = count;
  else itemValue.count = tag.int(count);
}

export function rawId(itemValue: any): string | null {
  return itemValue && itemValue.id ? String(itemValue.id.value) : null;
}

/** Inventory/EnderItems as a mutable array of compound values (created on demand). */
export function rawItemList(
  root: any,
  name: string,
  { create = false }: { create?: boolean } = {},
): any[] | null {
  let list = root[name];
  if (!list) {
    if (!create) return null;
    list = root[name] = {
      type: 'list',
      value: { type: 'compound', value: [] },
    };
  }
  if (list.type !== 'list')
    throw new Error(`${name} in the player file is not a list`);
  // Empty NBT lists carry element type 'end' — retype on first insert.
  if (list.value.type === 'end' || !Array.isArray(list.value.value)) {
    list.value = { type: 'compound', value: [] };
  } else if (list.value.type !== 'compound') {
    throw new Error(
      `${name} in the player file has unexpected element type "${list.value.type}"`,
    );
  }
  return list.value.value;
}

/** Modern layout: `equipment` present, or DataVersion >= 1.21.5. */
function usesEquipmentCompound(root: any): boolean {
  if (root.equipment && root.equipment.type === 'compound') return true;
  const dv = root.DataVersion ? Number(root.DataVersion.value) : 0;
  return dv >= EQUIPMENT_DATAVERSION;
}

export interface OfflineSlotRef {
  get(): any | null;
  set(itemValue: any): void;
  remove(): void;
}

/**
 * Uniform accessor for one slot in the raw tree. get/set/remove re-scan on
 * every call so interleaved removals can never act on stale indexes.
 */
export function offlineSlotRef(root: any, spec: SlotSpec): OfflineSlotRef {
  if (spec.kind === 'equipment' && usesEquipmentCompound(root)) {
    const eq = () => {
      if (!root.equipment || root.equipment.type !== 'compound') {
        root.equipment = { type: 'compound', value: {} };
      }
      return root.equipment.value;
    };
    return {
      get() {
        const piece = eq()[spec.piece!];
        return piece && piece.type === 'compound' && piece.value.id
          ? piece.value
          : null;
      },
      set(itemValue: any) {
        delete itemValue.Slot; // equipment entries carry no Slot field
        eq()[spec.piece!] = { type: 'compound', value: itemValue };
      },
      remove() {
        delete eq()[spec.piece!];
      },
    };
  }
  // List-backed (Inventory / EnderItems) — armor/offhand fall through here on
  // pre-1.21.5 saves via their legacy slot numbers.
  const listName = spec.kind === 'equipment' ? 'Inventory' : spec.list!;
  const find = (entries: any[]) =>
    entries.findIndex(
      (e) => e && e.Slot && Number(e.Slot.value) === spec.nbtSlot,
    );
  return {
    get() {
      const entries = rawItemList(root, listName);
      if (!entries) return null;
      const i = find(entries);
      return i === -1 ? null : entries[i];
    },
    set(itemValue: any) {
      const entries = rawItemList(root, listName, { create: true })!;
      itemValue.Slot = tag.byte(spec.nbtSlot);
      const i = find(entries);
      if (i === -1) entries.push(itemValue);
      else entries[i] = itemValue;
    },
    remove() {
      const entries = rawItemList(root, listName);
      if (!entries) return;
      const i = find(entries);
      if (i !== -1) entries.splice(i, 1);
    },
  };
}

export interface SlotEditResult {
  item: string | null;
  count: number;
  note?: string | null;
}

/** Pure slot edit on a raw root. Returns edit metadata. */
export function applyOfflineSlotEdit(
  root: any,
  spec: SlotSpec,
  {
    op,
    item,
    count,
  }: { op: 'set' | 'delete' | 'count'; item: string | null; count: number },
): SlotEditResult {
  const ref = offlineSlotRef(root, spec);
  if (op === 'set') {
    ref.set(makeRawItem(item!, count));
    return { item, count };
  }
  const cur = ref.get();
  if (!cur)
    throw new NotFoundException(
      `${spec.rconSlot} is empty — nothing to ${op === 'delete' ? 'delete' : 're-count'}`,
    );
  if (op === 'delete') {
    const meta = {
      item: rawId(cur),
      count: Number((cur.count || cur.Count || {}).value || 1),
    };
    ref.remove();
    return meta;
  }
  setRawCount(cur, count); // op === 'count' — components untouched
  return { item: rawId(cur), count };
}

export interface MoveResult {
  item: string | null;
  count: number;
  swapped: boolean;
}

/** Pure move/swap on a raw root. */
export function applyOfflineMove(
  root: any,
  fromSpec: SlotSpec,
  toSpec: SlotSpec,
): MoveResult {
  const fromRef = offlineSlotRef(root, fromSpec);
  const toRef = offlineSlotRef(root, toSpec);
  const src = fromRef.get();
  if (!src)
    throw new NotFoundException(
      `${fromSpec.rconSlot} is empty — nothing to move`,
    );
  const dst = toRef.get();
  fromRef.remove();
  if (dst) toRef.remove();
  toRef.set(src);
  if (dst) fromRef.set(dst); // swap
  return {
    item: rawId(src),
    count: Number((src.count || src.Count || {}).value || 1),
    swapped: Boolean(dst),
  };
}

// Nested (backpack) editing — offline only. Walk the RAW tree along the same
// path detectNestedInventories reported on the simplified view (the shapes
// map 1:1: compound key <-> string segment, list index <-> number segment).

export function assertNestedPath(pathSegs: unknown): (string | number)[] {
  if (
    !Array.isArray(pathSegs) ||
    !pathSegs.length ||
    pathSegs.length > NESTED_MAX_PATH
  ) {
    throw new BadRequestException('Invalid nested inventory path');
  }
  for (const seg of pathSegs) {
    const okString = typeof seg === 'string' && NESTED_KEY_RE.test(seg);
    const okIndex = Number.isInteger(seg) && seg >= 0 && seg <= 255;
    if (!okString && !okIndex)
      throw new BadRequestException('Invalid nested inventory path');
  }
  return pathSegs as (string | number)[];
}

/** Follow path segments through raw tags; returns the tag at the end. */
function walkRaw(startTag: any, pathSegs: (string | number)[]): any {
  let cur = startTag;
  for (const seg of pathSegs) {
    if (cur.type === 'compound') {
      if (typeof seg !== 'string' || !cur.value[seg])
        throw new NotFoundException(
          'That nested inventory no longer exists — reload',
        );
      cur = cur.value[seg];
    } else if (cur.type === 'list') {
      if (
        !Number.isInteger(seg) ||
        !Array.isArray(cur.value.value) ||
        (seg as number) >= cur.value.value.length
      ) {
        throw new NotFoundException(
          'That nested inventory no longer exists — reload',
        );
      }
      cur = { type: cur.value.type, value: cur.value.value[seg as number] };
    } else {
      throw new NotFoundException(
        'That nested inventory no longer exists — reload',
      );
    }
  }
  return cur;
}

/** Pure nested edit on a raw root. */
export function applyOfflineNestedEdit(
  root: any,
  spec: SlotSpec,
  {
    path: pathSegs,
    index,
    op,
    item,
    count,
  }: {
    path: unknown;
    index: number;
    op: 'set' | 'delete' | 'count';
    item: string | null;
    count: number;
  },
): SlotEditResult {
  const segs = assertNestedPath(pathSegs);
  const holder = offlineSlotRef(root, spec).get();
  if (!holder)
    throw new NotFoundException(
      `${spec.rconSlot} is empty — the backpack is gone. Reload.`,
    );
  const listTag = walkRaw({ type: 'compound', value: holder }, segs);
  if (
    listTag.type !== 'list' ||
    listTag.value.type !== 'compound' ||
    !Array.isArray(listTag.value.value)
  ) {
    throw new BadRequestException('That path does not point at an item list');
  }
  const entries = listTag.value.value;
  if (!Number.isInteger(index) || index < 0 || index >= entries.length) {
    throw new NotFoundException('That nested slot no longer exists — reload');
  }
  const el = entries[index];
  // Wrapped shape {slot, item:{...}} vs direct {id, count, Slot?}.
  const wrapped =
    !el.id && el.item && el.item.type === 'compound' && el.item.value.id;
  const inner = wrapped ? el.item.value : el;
  if (!inner.id) throw new NotFoundException('That nested slot is empty');

  if (op === 'delete') {
    const meta = {
      item: rawId(inner),
      count: Number((inner.count || inner.Count || {}).value || 1),
    };
    entries.splice(index, 1);
    return meta;
  }
  if (op === 'count') {
    setRawCount(inner, count);
    return { item: rawId(inner), count };
  }
  // op === 'set' — replace with a fresh stack, keeping the element's slot marker.
  const fresh = makeRawItem(item!, count);
  if (wrapped) {
    el.item = { type: 'compound', value: fresh };
  } else {
    if (el.Slot) fresh.Slot = el.Slot;
    entries[index] = fresh;
  }
  return { item, count };
}
