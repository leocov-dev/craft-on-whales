import * as crypto from 'node:crypto';
import { SecretsService, SecretKeyMismatchError } from './secrets.service';
import type { ConfigService } from '../config/config.service';

function fakeConfig(
  sessionSecret: string,
  secretKey: Buffer | null,
): ConfigService {
  return { sessionSecret, secretKey } as ConfigService;
}

describe('SecretsService', () => {
  describe('without SECRET_KEY (legacy behavior, unchanged)', () => {
    const secrets = new SecretsService(
      fakeConfig('a-session-secret-1234', null),
    );

    it('round-trips encrypt/decrypt', () => {
      const cipher = secrets.encrypt('super-secret-value');
      expect(secrets.decrypt(cipher)).toBe('super-secret-value');
    });

    it('tryDecrypt returns null instead of throwing on garbage', () => {
      expect(secrets.tryDecrypt('not.a.cipher')).toBeNull();
    });

    it('fails to decrypt a value encrypted under a different SESSION_SECRET', () => {
      const other = new SecretsService(
        fakeConfig('a-different-session-secret', null),
      );
      const cipher = other.encrypt('value');
      expect(() => secrets.decrypt(cipher)).toThrow(SecretKeyMismatchError);
    });
  });

  describe('with SECRET_KEY set', () => {
    const sessionSecret = 'a-session-secret-1234';
    const secretKey = crypto.randomBytes(32);

    it('encrypts new values under SECRET_KEY', () => {
      const secrets = new SecretsService(fakeConfig(sessionSecret, secretKey));
      const cipher = secrets.encrypt('value-under-new-key');
      expect(secrets.decrypt(cipher)).toBe('value-under-new-key');

      // A SecretsService with no SECRET_KEY (pure legacy key) must NOT be
      // able to decrypt something encrypted under SECRET_KEY.
      const legacyOnly = new SecretsService(fakeConfig(sessionSecret, null));
      expect(() => legacyOnly.decrypt(cipher)).toThrow(SecretKeyMismatchError);
    });

    it('decrypt-fallback: still decrypts a value encrypted under the legacy SESSION_SECRET-derived key', () => {
      // Simulates an existing install's stored value, encrypted before
      // SECRET_KEY was adopted.
      const legacyOnly = new SecretsService(fakeConfig(sessionSecret, null));
      const legacyCipher = legacyOnly.encrypt('pre-existing-value');

      const withSecretKey = new SecretsService(
        fakeConfig(sessionSecret, secretKey),
      );
      expect(withSecretKey.decrypt(legacyCipher)).toBe('pre-existing-value');
    });

    it('re-encrypt round trip: a legacy value, once decrypted and re-encrypted, is under SECRET_KEY and no longer needs the fallback', () => {
      const legacyOnly = new SecretsService(fakeConfig(sessionSecret, null));
      const legacyCipher = legacyOnly.encrypt('rotate-me');

      const withSecretKey = new SecretsService(
        fakeConfig(sessionSecret, secretKey),
      );
      const plaintext = withSecretKey.decrypt(legacyCipher);
      const reencrypted = withSecretKey.encrypt(plaintext);

      // The re-encrypted value must differ from the legacy ciphertext...
      expect(reencrypted).not.toBe(legacyCipher);
      // ...decrypt fine under SECRET_KEY...
      expect(withSecretKey.decrypt(reencrypted)).toBe('rotate-me');
      // ...and no longer be decryptable by a legacy-only instance (proves
      // it's actually under the new key now, not still the old one).
      const legacyAfterRotation = new SecretsService(
        fakeConfig(sessionSecret, null),
      );
      expect(() => legacyAfterRotation.decrypt(reencrypted)).toThrow(
        SecretKeyMismatchError,
      );
    });

    it('throws SecretKeyMismatchError when neither key decrypts', () => {
      const withSecretKey = new SecretsService(
        fakeConfig(sessionSecret, secretKey),
      );
      const somebodyElsesCipher = new SecretsService(
        fakeConfig('totally-unrelated-secret', crypto.randomBytes(32)),
      ).encrypt('value');
      expect(() => withSecretKey.decrypt(somebodyElsesCipher)).toThrow(
        SecretKeyMismatchError,
      );
    });
  });
});
