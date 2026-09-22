import { Injectable, HttpException, HttpStatus } from '@nestjs/common';

interface Window {
  count: number;
  resetAt: number;
}

const WINDOW_MS = 60 * 1000;
const MAX_PER_WINDOW = 60; // per key, per minute — generous for a dashboard poller, tight against a scrape burst
const MAX_TRACKED = 5000;

/**
 * Fixed-window request-rate limiter for `/api/v1/*`, one instance keyed
 * per-token and a second keyed per-IP (see `BearerAuthGuard`) — same
 * bounded-`Map`/evict-oldest-quarter shape as `LoginRateLimitService`,
 * mirrored per AGENTS.md/API_TOKENS_NOTES.md rather than building a new
 * primitive. Unlike the login limiter (which locks out on repeated
 * *failures*), this counts every request and resets on a rolling window,
 * since it's throttling volume, not guessing.
 */
@Injectable()
export class ApiRateLimitService {
  private readonly windows = new Map<string, Window>();

  check(key: string): void {
    const now = Date.now();
    let w = this.windows.get(key);
    if (!w || now >= w.resetAt) {
      w = { count: 0, resetAt: now + WINDOW_MS };
      if (this.windows.size >= MAX_TRACKED) {
        let toEvict = Math.floor(MAX_TRACKED / 4);
        for (const k of this.windows.keys()) {
          this.windows.delete(k);
          if (--toEvict <= 0) break;
        }
      }
      this.windows.set(key, w);
    }
    w.count += 1;
    if (w.count > MAX_PER_WINDOW) {
      const secs = Math.ceil((w.resetAt - now) / 1000);
      throw new HttpException(
        `Rate limit exceeded — try again in ${secs}s`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }
}
