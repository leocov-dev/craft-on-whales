import { ConfigService } from './config.service';
import type { SessionSecretProvider } from './session-secret.provider';
import type { SecretKeyProvider } from './secret-key.provider';
import type { ResourceDefaultsResolver } from './resource-defaults.resolver';

// SessionSecretProvider/SecretKeyProvider/ResourceDefaultsResolver each own
// real filesystem / host-memory / env side effects — faked here so this spec
// only exercises ConfigService's own env-var resolution and boot-time
// validation.
const fakeSecretProvider = {
  resolve: () => 'x'.repeat(48),
} as unknown as SessionSecretProvider;
const fakeSecretKeyProvider = {
  resolve: () => null,
} as unknown as SecretKeyProvider;
const fakeDefaultsResolver = {
  resolve: () => ({
    heapMb: 1024,
    containerMemoryMb: 1536,
    cpus: 0,
    diskQuotaGb: 25,
    quotaWarnPct: 80,
    quotaCriticalPct: 95,
  }),
} as unknown as ResourceDefaultsResolver;

describe('ConfigService — COOKIE_SAMESITE / COOKIE_SECURE', () => {
  const ENV_KEYS = [
    'COOKIE_SAMESITE',
    'COOKIE_SECURE',
    'DATA_DIR',
    'DB_DRIVER',
    'DATABASE_URL',
  ] as const;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  function build(): ConfigService {
    return new ConfigService(
      fakeSecretProvider,
      fakeSecretKeyProvider,
      fakeDefaultsResolver,
    );
  }

  it('defaults COOKIE_SAMESITE to lax', () => {
    const config = build();
    expect(config.cookieSameSite).toBe('lax');
    expect(config.cookieSecure).toBe(false);
  });

  it('accepts strict and none (case-insensitively) when paired with Secure', () => {
    process.env.COOKIE_SAMESITE = 'Strict';
    expect(build().cookieSameSite).toBe('strict');

    process.env.COOKIE_SAMESITE = 'NONE';
    process.env.COOKIE_SECURE = 'true';
    expect(build().cookieSameSite).toBe('none');
  });

  it('rejects an unrecognized COOKIE_SAMESITE value', () => {
    process.env.COOKIE_SAMESITE = 'lax; Secure';
    expect(() => build()).toThrow(/COOKIE_SAMESITE must be/);
  });

  it('rejects SameSite=none without Secure', () => {
    process.env.COOKIE_SAMESITE = 'none';
    expect(() => build()).toThrow(/requires COOKIE_SECURE=true/);
  });

  it('accepts SameSite=none with COOKIE_SECURE=auto', () => {
    process.env.COOKIE_SAMESITE = 'none';
    process.env.COOKIE_SECURE = 'auto';
    const config = build();
    expect(config.cookieSameSite).toBe('none');
    expect(config.cookieSecure).toBe('auto');
  });
});
