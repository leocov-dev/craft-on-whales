import { applyGcPreset, gcPresetOf } from './jvm-gc';

describe('gcPresetOf', () => {
  it('defaults when nothing is set', () => {
    expect(gcPresetOf({})).toBe('default');
  });

  it('reads legacy flag-set toggles', () => {
    expect(gcPresetOf({ USE_AIKAR_FLAGS: 'true' })).toBe('aikar');
    expect(gcPresetOf({ USE_MEOWICE_FLAGS: 'TRUE' })).toBe('meowice');
  });

  it('prefers the explicit key and ignores junk', () => {
    expect(gcPresetOf({ GC_PRESET: 'zgc', USE_AIKAR_FLAGS: 'true' })).toBe(
      'zgc',
    );
    expect(gcPresetOf({ GC_PRESET: 'nope' })).toBe('default');
  });
});

describe('applyGcPreset', () => {
  it('passes env through when no preset key is present', () => {
    const env = { USE_AIKAR_FLAGS: 'true', JVM_OPTS: '-XX:+UseZGC' };
    expect(applyGcPreset(env)).toEqual(env);
  });

  it('maps flag-set presets to the image toggle and clears the other', () => {
    expect(
      applyGcPreset({ GC_PRESET: 'meowice', USE_AIKAR_FLAGS: 'true' }),
    ).toEqual({ USE_MEOWICE_FLAGS: 'true' });
  });

  it('appends a collector flag, replacing any existing collector', () => {
    expect(
      applyGcPreset({
        GC_PRESET: 'zgc',
        JVM_OPTS: '-Dfoo=bar -XX:+UseG1GC',
        JVM_XX_OPTS: '-XX:+UseParallelGC -XX:MaxGCPauseMillis=50',
      }),
    ).toEqual({
      JVM_OPTS: '-Dfoo=bar',
      JVM_XX_OPTS: '-XX:MaxGCPauseMillis=50 -XX:+UseZGC',
    });
  });

  it('keeps the GraalVM add-on only for MeowIce', () => {
    const env = { USE_MEOWICE_GRAALVM_FLAGS: 'true' };
    expect(applyGcPreset({ ...env, GC_PRESET: 'meowice' })).toEqual({
      USE_MEOWICE_FLAGS: 'true',
      USE_MEOWICE_GRAALVM_FLAGS: 'true',
    });
    expect(applyGcPreset({ ...env, GC_PRESET: 'aikar' })).toEqual({
      USE_AIKAR_FLAGS: 'true',
    });
  });

  it('default clears legacy toggles but keeps user JVM_OPTS', () => {
    expect(
      applyGcPreset({
        GC_PRESET: 'default',
        USE_AIKAR_FLAGS: 'true',
        JVM_OPTS: '-XX:+UseG1GC',
      }),
    ).toEqual({ JVM_OPTS: '-XX:+UseG1GC' });
  });

  it('never leaks GC_PRESET into the container env', () => {
    expect('GC_PRESET' in applyGcPreset({ GC_PRESET: 'serial' })).toBe(false);
  });
});
