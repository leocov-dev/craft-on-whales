import { Injectable } from '@nestjs/common';
import * as crypto from 'node:crypto';
import { ConfigService } from '../config/config.service';

// At-rest encryption for RCON passwords, API keys, 2FA secrets, and webhook
// URLs: AES-256-GCM. Ciphertext format: base64(iv).base64(tag).base64(data)
//
// Key precedence (see backend/src/auth/SECRETS_NOTES.md for the full
// reasoning): SECRET_KEY when set, else a key derived from SESSION_SECRET
// (legacy behavior, kept for existing installs). When SECRET_KEY is set, the
// SESSION_SECRET-derived key becomes a decrypt-only fallback so values
// encrypted before SECRET_KEY was adopted keep decrypting; every value
// re-encrypts under SECRET_KEY the next time it's written (encrypt() always
// uses the primary key).

export class SecretKeyMismatchError extends Error {
  readonly status = 409;
  readonly code = 'SECRET_KEY_MISMATCH';
  constructor() {
    super(
      'A stored secret could not be decrypted — the configured encryption key(s) ' +
        "don't match what was used to encrypt it (SECRET_KEY and/or SESSION_SECRET " +
        'changed since it was saved). Re-enter the affected credential (API key / ' +
        'RCON password / webhook URL), or restore the previous key in .env.',
    );
  }
}

@Injectable()
export class SecretsService {
  /** Primary key: SECRET_KEY if set, else the SESSION_SECRET-derived key. */
  private readonly key: Buffer;
  /**
   * Always the SESSION_SECRET-derived key, kept around as a decrypt-only
   * fallback for values encrypted before SECRET_KEY was set. Equal to `key`
   * when SECRET_KEY is unset (fallback is then a same-key no-op retry).
   */
  private readonly legacyKey: Buffer;

  constructor(private readonly config: ConfigService) {
    this.legacyKey = crypto.scryptSync(
      this.config.sessionSecret,
      'msm.secrets.v1',
      32,
    );
    this.key = this.config.secretKey ?? this.legacyKey;
  }

  encrypt(plaintext: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([
      cipher.update(String(plaintext), 'utf8'),
      cipher.final(),
    ]);
    return [iv, cipher.getAuthTag(), data]
      .map((b) => b.toString('base64'))
      .join('.');
  }

  decrypt(ciphertext: string): string {
    try {
      return this.decryptWith(ciphertext, this.key);
    } catch {
      if (this.key !== this.legacyKey) {
        try {
          return this.decryptWith(ciphertext, this.legacyKey);
        } catch {
          /* fall through to the mismatch error below */
        }
      }
      throw new SecretKeyMismatchError();
    }
  }

  private decryptWith(ciphertext: string, key: Buffer): string {
    const [iv, tag, data] = ciphertext
      .split('.')
      .map((s) => Buffer.from(s, 'base64'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv!);
    decipher.setAuthTag(tag!);
    return Buffer.concat([decipher.update(data!), decipher.final()]).toString(
      'utf8',
    );
  }

  /** decrypt() that returns null instead of throwing — for callers with a fallback. */
  tryDecrypt(ciphertext: string): string | null {
    try {
      return this.decrypt(ciphertext);
    } catch {
      return null;
    }
  }

  generatePassword(bytes = 18): string {
    return crypto.randomBytes(bytes).toString('base64url');
  }
}
