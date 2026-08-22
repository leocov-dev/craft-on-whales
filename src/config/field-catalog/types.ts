'use strict';

// Shared type definitions for the field catalog. Split out from index.ts
// because tsx/esbuild's single-file CommonJS transform of `export =` breaks
// when the same file also has ordinary `export interface`/`export type`
// declarations (tsc itself is fine with it — type-only exports don't
// conflict with `export =` — but esbuild's isolatedModules transform can't
// tell a type export from a value export without full type info, and emits
// broken interop code). Keeping this file type-only (nothing here has a
// runtime value) sidesteps the bug entirely: `import type` erases fully, so
// this file is never `require()`d at runtime.

/** Where a field's value ultimately lives. */
export type FieldScope = 'env' | 'docker' | 'properties' | 'panel';

/** Which form control renders and validates the field. */
export type FieldType =
  'text' | 'number' | 'size-mb' | 'boolean' | 'enum' | 'list' | 'password' | 'range' | 'cron' | 'duration';

/** Which wizard mode a field is visible in ('advanced' shows both). */
export type FieldMode = 'simple' | 'advanced';

/** Id of one of the catalog's SECTIONS entries. */
export type SectionId =
  | 'identity'
  | 'flavor'
  | 'resources'
  | 'jvm'
  | 'world'
  | 'gameplay'
  | 'players'
  | 'network'
  | 'rcon'
  | 'packs'
  | 'autopause'
  | 'maintenance'
  | 'advanced';

/** One choice in an 'enum' field's option list. */
export interface FieldOption {
  value: string;
  label: string;
  desc?: string;
}

/** A single configurable setting the panel exposes. */
export interface Field {
  key: string;
  scope: FieldScope;
  label: string;
  help: string;
  type: FieldType;
  unit?: string;
  default?: string | number | boolean;
  options?: FieldOption[];
  min?: number;
  max?: number;
  step?: number;
  mode: FieldMode;
  section: SectionId;
  danger?: boolean;
  requiresRestart?: boolean;
  hidden?: boolean;
  note?: string;
}

/** One tab/group in the settings UI. */
export interface Section {
  id: SectionId;
  label: string;
  icon: string;
}
