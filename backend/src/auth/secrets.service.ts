import { Injectable } from '@nestjs/common';
import * as crypto from 'node:crypto';
import { ConfigService } from '../config/config.service';

// At-rest encryption for RCON passwords and API keys: AES-256-GCM with a key
// derived from SESSION_SECRET. Ciphertext format: base64(iv).base64(tag).base64(data)

export class SecretKeyMismatchError extends Error {
  readonly status = 409;
  readonly code = 'SECRET_KEY_MISMATCH';
  constructor() {
    super(
      'A stored secret could not be decrypted — SESSION_SECRET has changed since it was saved. ' +
        'Re-enter the affected credential (API key / RCON password), or restore the old SESSION_SECRET in .env.'
    );
  }
}

@Injectable()
export class SecretsService {
  private readonly key: Buffer;

  constructor(private readonly config: ConfigService) {
    this.key = crypto.scryptSync(this.config.sessionSecret, 'msm.secrets.v1', 32);
  }

  encrypt(plaintext: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64')).join('.');
  }

  decrypt(ciphertext: string): string {
    try {
      const [iv, tag, data] = ciphertext.split('.').map((s) => Buffer.from(s, 'base64'));
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, iv!);
      decipher.setAuthTag(tag!);
      return Buffer.concat([decipher.update(data!), decipher.final()]).toString('utf8');
    } catch {
      // Almost always: SESSION_SECRET changed since this value was stored.
      throw new SecretKeyMismatchError();
    }
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
