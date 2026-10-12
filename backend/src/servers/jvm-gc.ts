/**
 * Garbage-collector presets for a server's JVM. The choice is stored in the
 * server's env as the panel-owned `GC_PRESET` key (no schema change) and
 * translated into the itzg image's own variables at container-assembly time;
 * `GC_PRESET` itself never reaches the container. See SERVERS_NOTES.md
 * ("Garbage-collector presets").
 */

export const GC_PRESETS = [
  'default',
  'aikar',
  'meowice',
  'zgc',
  'shenandoah',
  'parallel',
  'serial',
] as const;
export type GcPreset = (typeof GC_PRESETS)[number];

export const GC_PRESET_ENV_KEY = 'GC_PRESET';

/** Image toggles that select a whole flag set (each carries its own GC). */
const FLAG_SET_ENV: Partial<Record<GcPreset, string>> = {
  aikar: 'USE_AIKAR_FLAGS',
  meowice: 'USE_MEOWICE_FLAGS',
};
const ALL_FLAG_SET_KEYS = [
  'USE_AIKAR_FLAGS',
  'USE_MEOWICE_FLAGS',
  'USE_MEOWICE_GRAALVM_FLAGS',
];

/** Both take space-delimited raw JVM arguments; the image's docs put `-XX`
 *  options in the second. A user may have put a collector in either. */
const JVM_OPTS_KEYS = ['JVM_OPTS', 'JVM_XX_OPTS'] as const;

/** Plain collector flags, appended to `JVM_XX_OPTS`. */
const COLLECTOR_FLAGS: Partial<Record<GcPreset, string>> = {
  zgc: '-XX:+UseZGC',
  shenandoah: '-XX:+UseShenandoahGC',
  parallel: '-XX:+UseParallelGC',
  serial: '-XX:+UseSerialGC',
};

/** Any `-XX:+Use…GC` selector; two of them make the JVM refuse to start. */
const COLLECTOR_TOKEN_RE = /^-XX:\+Use\w*GC$/;

const isOn = (v: string | undefined): boolean => v?.toLowerCase() === 'true';

function isGcPreset(v: unknown): v is GcPreset {
  return (GC_PRESETS as readonly unknown[]).includes(v);
}

/** The preset a server is on: the explicit key, else what legacy env implies. */
export function gcPresetOf(env: Record<string, string>): GcPreset {
  const explicit = env[GC_PRESET_ENV_KEY];
  if (isGcPreset(explicit)) return explicit;
  if (isOn(env.USE_AIKAR_FLAGS)) return 'aikar';
  if (isOn(env.USE_MEOWICE_FLAGS)) return 'meowice';
  return 'default';
}

/**
 * Translate `GC_PRESET` into image variables (returns a new object). Without
 * the key, env passes through untouched so servers configured by hand or by a
 * blueprint (`USE_AIKAR_FLAGS`) keep working. With it, the key is
 * authoritative over the flag-set toggles and any collector already in
 * `JVM_OPTS`.
 */
export function applyGcPreset(
  env: Record<string, string>,
): Record<string, string> {
  const out = { ...env };
  const raw = out[GC_PRESET_ENV_KEY];
  delete out[GC_PRESET_ENV_KEY];
  if (raw === undefined) return out;
  const preset = isGcPreset(raw) ? raw : 'default';
  // The GraalVM add-on only means something alongside MeowIce's flags.
  const keep = preset === 'meowice' ? out.USE_MEOWICE_GRAALVM_FLAGS : undefined;
  for (const key of ALL_FLAG_SET_KEYS) delete out[key];
  if (keep !== undefined) out.USE_MEOWICE_GRAALVM_FLAGS = keep;
  if (preset !== 'default') {
    for (const key of JVM_OPTS_KEYS) {
      if (!out[key]) continue;
      const rest = out[key]
        .split(/\s+/)
        .filter((t) => t && !COLLECTOR_TOKEN_RE.test(t));
      if (rest.length) out[key] = rest.join(' ');
      else delete out[key];
    }
  }
  const toggle = FLAG_SET_ENV[preset];
  if (toggle) out[toggle] = 'true';
  const flag = COLLECTOR_FLAGS[preset];
  if (flag)
    out.JVM_XX_OPTS = out.JVM_XX_OPTS ? `${out.JVM_XX_OPTS} ${flag}` : flag;
  return out;
}
