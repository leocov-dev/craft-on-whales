import { Injectable, HttpException, HttpStatus } from '@nestjs/common';

interface LoginAttemptEntry {
  count: number;
  until: number;
}

const MAX_ATTEMPTS = 8;
const LOCK_MS = 10 * 60 * 1000;
const MAX_TRACKED = 5000;

/**
 * In-memory login-lockout tracker, "username|ip" -> {count, until}. Keyed by
 * IP too so one attacker cannot lock a victim's account out from anywhere,
 * and bounded so a flood of unique keys can't grow it without limit.
 */
@Injectable()
export class LoginRateLimitService {
  private readonly attempts = new Map<string, LoginAttemptEntry>();

  private key(
    username: string | undefined | null,
    ip: string | undefined | null,
  ): string {
    return `${(username || '').toLowerCase()}|${ip || ''}`;
  }

  checkLoginAllowed(
    username: string | undefined | null,
    ip: string | undefined | null,
  ): void {
    const entry = this.attempts.get(this.key(username, ip));
    if (entry && entry.count >= MAX_ATTEMPTS && Date.now() < entry.until) {
      const mins = Math.ceil((entry.until - Date.now()) / 60000);
      throw new HttpException(
        `Too many failed attempts — try again in ${mins} min`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  recordLoginFailure(
    username: string | undefined | null,
    ip: string | undefined | null,
  ): void {
    // Bound memory: evict the oldest quarter if the map grows past the cap.
    if (this.attempts.size >= MAX_TRACKED) {
      let toEvict = Math.floor(MAX_TRACKED / 4);
      for (const k of this.attempts.keys()) {
        this.attempts.delete(k);
        if (--toEvict <= 0) break;
      }
    }
    const key = this.key(username, ip);
    const entry = this.attempts.get(key) || { count: 0, until: 0 };
    entry.count += 1;
    // Do NOT extend an already-active lock — otherwise repeated attempts keep
    // a valid account locked forever (targeted-lockout DoS).
    if (Date.now() >= entry.until) entry.until = Date.now() + LOCK_MS;
    this.attempts.set(key, entry);
  }

  clearLoginFailures(
    username: string | undefined | null,
    ip: string | undefined | null,
  ): void {
    this.attempts.delete(this.key(username, ip));
  }
}
