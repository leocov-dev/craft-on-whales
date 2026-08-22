'use strict';

// FIELD CATALOG — the single source of truth for every configurable setting
// the panel exposes: itzg env vars, Docker resource limits, server.properties
// keys, and panel settings. Forms render from it; server-side validation is
// derived from it; nothing anywhere shows a raw env var without its friendly
// label and help text.
//
// Entry schema (all sections use it) — see the Field type below for the
// authoritative shape:
// {
//   key:      'MEMORY'                    // env var name, or property key for scope 'properties'
//   scope:    'env' | 'docker' | 'properties' | 'panel'
//   label:    'RAM (Java heap)'           // friendly, human
//   help:     '1-2 sentences of plain English, sourced from the itzg docs.'
//   type:     'text'|'number'|'size-mb'|'boolean'|'enum'|'list'|'password'|'range'|'cron'|'duration'
//   unit:     'MB' | 'cores' | 'players' | … (optional)
//   default:  value the image/panel uses when unset (optional)
//   options:  [{value, label, desc?}] for enum (optional)
//   min, max, step: for number/range (optional)
//   mode:     'simple' | 'advanced'       // which wizard mode shows it
//   section:  section id (matches SECTIONS below)
//   danger:   true → red styling + extra warning copy (optional)
//   requiresRestart: true when a running container must be recreated to apply
//   hidden:   true → never rendered (footguns the panel manages itself)
//   note:     short 'recommended' hint or warning shown as a badge (optional)
// }

// Types live in ./types (not here) — tsx/esbuild's single-file `export =`
// transform breaks when the same file also has ordinary `export`
// declarations. See the comment at the top of types.ts.
import type { Field, FieldMode, FieldScope, SectionId, Section } from './types';

const SECTIONS: Section[] = [
  { id: 'identity', label: 'Identity', icon: 'tag' },
  { id: 'flavor', label: 'Flavor & version', icon: 'box' },
  { id: 'resources', label: 'Resources', icon: 'gauge' },
  { id: 'jvm', label: 'Java / JVM tuning', icon: 'wrench' },
  { id: 'world', label: 'World', icon: 'earth' },
  { id: 'gameplay', label: 'Gameplay rules', icon: 'swords' },
  { id: 'players', label: 'Players, whitelist & ops', icon: 'users' },
  { id: 'network', label: 'Networking & ports', icon: 'network' },
  { id: 'rcon', label: 'RCON & console', icon: 'terminal' },
  { id: 'packs', label: 'Modpacks & content', icon: 'package' },
  { id: 'autopause', label: 'Auto-pause / auto-stop', icon: 'pause' },
  { id: 'maintenance', label: 'Logs & maintenance', icon: 'file-text' },
  { id: 'advanced', label: 'Advanced & experimental', icon: 'flask-conical' },
];

const fields: Field[] = [
  ...(require('./resources') as Field[]),
  ...(require('./jvm') as Field[]),
  ...(require('./general') as Field[]),
  ...(require('./world') as Field[]),
  ...(require('./gameplay') as Field[]),
  ...(require('./players') as Field[]),
  ...(require('./network') as Field[]),
  ...(require('./rcon') as Field[]),
  ...(require('./packs') as Field[]),
  ...(require('./autopause') as Field[]),
  ...(require('./maintenance') as Field[]),
];

const byKey = new Map<string, Field>(fields.map((f) => [`${f.scope}:${f.key}`, f]));

function forSection(sectionId: SectionId, mode: FieldMode = 'advanced'): Field[] {
  return fields.filter((f) => f.section === sectionId && !f.hidden && (mode === 'advanced' || f.mode === 'simple'));
}

function getField(scope: FieldScope, key: string): Field | null {
  return byKey.get(`${scope}:${key}`) || null;
}

const catalog = { SECTIONS, fields, forSection, getField };

export = catalog;
