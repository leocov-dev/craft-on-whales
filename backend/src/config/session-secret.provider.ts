import { Injectable } from '@nestjs/common';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';

/**
 * Resolves + persists session secret, split out of `ConfigService` for
 * isolated testability (SRP finding, `.plan/reviews/01-core-infra.md`).
 * Constructed per-panel-run — `dataDir` passed in since ConfigService owns
 * that resolution and this provider only needs the final value.
 */
@Injectable()
export class SessionSecretProvider {
  resolve(dataDir: string): string {
    const fromEnv = process.env.SESSION_SECRET;
    if (fromEnv && fromEnv.trim().length > 0) {
      if (fromEnv.trim().length < 16) {
        throw new Error(
          'SESSION_SECRET is set but too short — use at least 16 characters (e.g. `openssl rand -base64 48`).',
        );
      }
      return fromEnv.trim();
    }
    const secretFile = path.join(dataDir, '.session-secret');
    try {
      const existing = fs.readFileSync(secretFile, 'utf8').trim();
      if (existing.length >= 16) return existing;
    } catch {
      /* not created yet — fall through and generate */
    }
    const generated = crypto.randomBytes(48).toString('base64url');
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(secretFile, generated, { mode: 0o600 });

      console.log(
        `No SESSION_SECRET set — generated one and saved it to ${secretFile} (keep it private; delete it to rotate).`,
      );
    } catch (err) {
      throw new Error(
        `Could not persist a generated session secret to ${secretFile}: ${(err as Error).message}`,
      );
    }
    return generated;
  }
}
