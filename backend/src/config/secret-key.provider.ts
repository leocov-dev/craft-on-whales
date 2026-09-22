import { Injectable, Logger } from '@nestjs/common';

/**
 * Resolves + validates the optional dedicated at-rest encryption key
 * (`SECRET_KEY`), split out of `ConfigService` for isolated testability —
 * same rationale as `SessionSecretProvider`.
 *
 * Unlike `SessionSecretProvider`, this key is NEVER generated and NEVER
 * written to disk: it's operator-supplied only. See
 * `backend/src/auth/SECRETS_NOTES.md` for the full key-precedence reasoning.
 */
@Injectable()
export class SecretKeyProvider {
  private readonly logger = new Logger(SecretKeyProvider.name);

  /**
   * Returns the decoded 32-byte key if `SECRET_KEY` is set, or `null` if
   * it's absent (after logging a loud deprecation warning). Throws if it's
   * present but malformed or the wrong decoded length — this is a hard boot
   * error, never silently ignored/truncated/padded.
   */
  resolve(): Buffer | null {
    const raw = process.env.SECRET_KEY;
    if (raw === undefined || raw.trim() === '') {
      this.logger.warn(
        '=============================================================\n' +
          'SECRET_KEY is not set. Falling back to a key derived from ' +
          'SESSION_SECRET for at-rest encryption (API keys, RCON passwords, ' +
          '2FA secrets, webhook URLs). This fallback is DEPRECATED: set a ' +
          'dedicated SECRET_KEY (e.g. `openssl rand -hex 32`) so the ' +
          'encryption key is independent of the session-cookie signing key.\n' +
          '=============================================================',
      );
      return null;
    }
    return SecretKeyProvider.decode(raw);
  }

  /** Exposed static so validation logic is unit-testable without a Logger. */
  static decode(raw: string): Buffer {
    const s = raw.trim();

    // Pure hex charset: require exactly 64 chars (32 bytes). Checked first
    // since a hex string is also a valid base64 charset subset.
    if (/^[0-9a-fA-F]+$/.test(s)) {
      if (s.length !== 64) {
        throw new Error(
          `SECRET_KEY looks like hex but is ${s.length} chars (${Math.ceil(s.length / 2)} bytes) — ` +
            'needs to be exactly 64 hex chars (32 bytes) for AES-256-GCM. ' +
            'Generate one with `openssl rand -hex 32`.',
        );
      }
      return Buffer.from(s, 'hex');
    }

    // Otherwise must be valid base64 or base64url.
    if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(s)) {
      throw new Error(
        'SECRET_KEY must be base64, base64url, or hex encoded — got a value ' +
          'with characters that are none of those. Generate one with ' +
          '`openssl rand -base64 32` or `openssl rand -hex 32`.',
      );
    }
    const buf = Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    if (buf.length !== 32) {
      throw new Error(
        `SECRET_KEY decodes to ${buf.length} bytes — needs to decode to exactly ` +
          '32 bytes for AES-256-GCM. Generate one with `openssl rand -base64 32` ' +
          'or `openssl rand -hex 32`.',
      );
    }
    return buf;
  }
}
