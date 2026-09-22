import { ConfigService } from './config.service';
import { SessionSecretProvider } from './session-secret.provider';
import { ResourceDefaultsResolver } from './resource-defaults.resolver';

/**
 * TRUST_PROXY resolution — see AUTH_NOTES.md's "TRUST_PROXY: refusing a bare
 * boolean" section. A bare `true` must be a hard config error (it trusts
 * X-Forwarded-For from any connecting client); hop counts, IP/CIDR lists, and
 * `false`/unset must keep working exactly as before.
 */
describe('ConfigService — TRUST_PROXY resolution', () => {
  const originalEnv = { ...process.env };
  const sessionSecretProvider = {
    resolve: () => 'a'.repeat(32),
  } as unknown as SessionSecretProvider;
  const resourceDefaultsResolver = {
    resolve: () => ({
      heapMb: 1024,
      containerMemoryMb: 2048,
      cpus: 1,
      diskQuotaGb: 10,
      quotaWarnPct: 80,
      quotaCriticalPct: 95,
    }),
  } as unknown as ResourceDefaultsResolver;

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  function build(trustProxy: string | undefined): ConfigService {
    process.env = { ...originalEnv };
    if (trustProxy === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = trustProxy;
    return new ConfigService(sessionSecretProvider, resourceDefaultsResolver);
  }

  it('defaults to false when unset', () => {
    expect(build(undefined).trustProxy).toBe(false);
  });

  it('rejects a bare "true" with a clear config error', () => {
    expect(() => build('true')).toThrow(
      /TRUST_PROXY=true is no longer accepted/,
    );
  });

  it('rejects "TRUE" case-insensitively', () => {
    expect(() => build('TRUE')).toThrow(
      /TRUST_PROXY=true is no longer accepted/,
    );
  });

  it('accepts an explicit "false"', () => {
    expect(build('false').trustProxy).toBe(false);
  });

  it('accepts a hop count', () => {
    expect(build('1').trustProxy).toBe(1);
    expect(build('2').trustProxy).toBe(2);
  });

  it('accepts a CIDR/IP list string', () => {
    expect(build('127.0.0.1').trustProxy).toBe('127.0.0.1');
    expect(build('10.0.0.0/8,192.168.0.0/16').trustProxy).toBe(
      '10.0.0.0/8,192.168.0.0/16',
    );
  });

  it('accepts the "loopback" keyword', () => {
    expect(build('loopback').trustProxy).toBe('loopback');
  });
});
