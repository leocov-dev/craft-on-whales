import * as crypto from 'node:crypto';
import { SecretKeyProvider } from './secret-key.provider';

describe('SecretKeyProvider.decode (validation)', () => {
  it('accepts a well-formed 32-byte hex key', () => {
    const hex = crypto.randomBytes(32).toString('hex');
    const buf = SecretKeyProvider.decode(hex);
    expect(buf.length).toBe(32);
    expect(buf.toString('hex')).toBe(hex);
  });

  it('accepts a well-formed 32-byte base64 key', () => {
    const raw = crypto.randomBytes(32);
    const b64 = raw.toString('base64');
    const buf = SecretKeyProvider.decode(b64);
    expect(buf.length).toBe(32);
    expect(buf.equals(raw)).toBe(true);
  });

  it('accepts a well-formed 32-byte base64url key', () => {
    const raw = crypto.randomBytes(32);
    const b64url = raw.toString('base64url');
    const buf = SecretKeyProvider.decode(b64url);
    expect(buf.length).toBe(32);
    expect(buf.equals(raw)).toBe(true);
  });

  it('tolerates surrounding whitespace', () => {
    const hex = crypto.randomBytes(32).toString('hex');
    expect(SecretKeyProvider.decode(`  ${hex}\n`).length).toBe(32);
  });

  it('rejects hex of the wrong length', () => {
    const shortHex = crypto.randomBytes(16).toString('hex'); // 32 chars, not 64
    expect(() => SecretKeyProvider.decode(shortHex)).toThrow(/32 bytes/i);
  });

  it('rejects base64 that decodes to the wrong length', () => {
    const wrongLength = crypto.randomBytes(16).toString('base64');
    expect(() => SecretKeyProvider.decode(wrongLength)).toThrow(/32 bytes/i);
  });

  it('rejects garbage with invalid characters', () => {
    expect(() => SecretKeyProvider.decode('not*a*valid*key!!')).toThrow(
      /base64|hex/i,
    );
  });

  it('rejects an empty string', () => {
    expect(() => SecretKeyProvider.decode('')).toThrow();
  });

  it('never truncates or pads — a too-long key is rejected, not sliced', () => {
    const tooLong = crypto.randomBytes(48).toString('hex');
    expect(() => SecretKeyProvider.decode(tooLong)).toThrow(/32 bytes/i);
  });
});

describe('SecretKeyProvider.resolve (boot behavior)', () => {
  const ORIGINAL_ENV = process.env.SECRET_KEY;

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.SECRET_KEY;
    else process.env.SECRET_KEY = ORIGINAL_ENV;
  });

  it('returns null and warns when SECRET_KEY is absent', () => {
    delete process.env.SECRET_KEY;
    const provider = new SecretKeyProvider();
    const warnSpy = jest.spyOn(provider['logger'], 'warn').mockImplementation();
    expect(provider.resolve()).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
    expect(warnSpy.mock.calls[0]?.[0]).toMatch(/SECRET_KEY/);
  });

  it('returns null and warns when SECRET_KEY is blank', () => {
    process.env.SECRET_KEY = '   ';
    const provider = new SecretKeyProvider();
    jest.spyOn(provider['logger'], 'warn').mockImplementation();
    expect(provider.resolve()).toBeNull();
  });

  it('returns the decoded key when SECRET_KEY is valid', () => {
    process.env.SECRET_KEY = crypto.randomBytes(32).toString('hex');
    const provider = new SecretKeyProvider();
    const key = provider.resolve();
    expect(key).not.toBeNull();
    expect(key?.length).toBe(32);
  });

  it('throws (hard boot error) when SECRET_KEY is malformed', () => {
    process.env.SECRET_KEY = 'too-short';
    const provider = new SecretKeyProvider();
    expect(() => provider.resolve()).toThrow();
  });

  it('throws (hard boot error) when SECRET_KEY is the wrong length', () => {
    process.env.SECRET_KEY = crypto.randomBytes(16).toString('hex');
    const provider = new SecretKeyProvider();
    expect(() => provider.resolve()).toThrow(/32 bytes/i);
  });
});
