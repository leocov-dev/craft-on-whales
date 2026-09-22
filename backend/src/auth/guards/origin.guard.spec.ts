import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { OriginGuard } from './origin.guard';
import type {
  ConfigService,
  CookieSameSite,
} from '../../config/config.service';

function contextFor(req: {
  method: string;
  headers: Record<string, string | undefined>;
}): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
}

function configWith(sameSite: CookieSameSite): ConfigService {
  return { cookieSameSite: sameSite } as unknown as ConfigService;
}

/** A Reflector stub — `skip: true` mimics a route carrying `@SkipOriginCheck()`. */
function reflectorReturning(skip: boolean): Reflector {
  return { getAllAndOverride: () => skip } as unknown as Reflector;
}

describe('OriginGuard', () => {
  it('passes GET/HEAD/OPTIONS through unconditionally, even cross-origin', () => {
    const guard = new OriginGuard(configWith('lax'), reflectorReturning(false));
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      expect(
        guard.canActivate(
          contextFor({
            method,
            headers: { origin: 'https://evil.example', host: 'panel.local' },
          }),
        ),
      ).toBe(true);
    }
  });

  it('allows a same-origin POST via Origin', () => {
    const guard = new OriginGuard(configWith('lax'), reflectorReturning(false));
    expect(
      guard.canActivate(
        contextFor({
          method: 'POST',
          headers: { origin: 'https://panel.local', host: 'panel.local' },
        }),
      ),
    ).toBe(true);
  });

  it('falls back to Referer when Origin is absent', () => {
    const guard = new OriginGuard(configWith('lax'), reflectorReturning(false));
    expect(
      guard.canActivate(
        contextFor({
          method: 'POST',
          headers: {
            referer: 'https://panel.local/servers/1',
            host: 'panel.local',
          },
        }),
      ),
    ).toBe(true);
  });

  it('rejects a cross-origin POST', () => {
    const guard = new OriginGuard(configWith('lax'), reflectorReturning(false));
    expect(() =>
      guard.canActivate(
        contextFor({
          method: 'POST',
          headers: { origin: 'https://evil.example', host: 'panel.local' },
        }),
      ),
    ).toThrow(/Cross-origin/);
  });

  it('rejects a malformed Origin header', () => {
    const guard = new OriginGuard(configWith('lax'), reflectorReturning(false));
    expect(() =>
      guard.canActivate(
        contextFor({
          method: 'POST',
          headers: { origin: 'not a url', host: 'panel.local' },
        }),
      ),
    ).toThrow(/Cross-origin/);
  });

  it.each(['lax', 'strict'] as const)(
    'allows a %s-mode POST with neither Origin nor Referer',
    (sameSite) => {
      const guard = new OriginGuard(
        configWith(sameSite),
        reflectorReturning(false),
      );
      expect(
        guard.canActivate(
          contextFor({ method: 'POST', headers: { host: 'panel.local' } }),
        ),
      ).toBe(true);
    },
  );

  it('rejects a none-mode POST with neither Origin nor Referer', () => {
    const guard = new OriginGuard(
      configWith('none'),
      reflectorReturning(false),
    );
    expect(() =>
      guard.canActivate(
        contextFor({ method: 'POST', headers: { host: 'panel.local' } }),
      ),
    ).toThrow(/Cross-origin/);
  });

  it('still allows a same-origin POST under none mode', () => {
    const guard = new OriginGuard(
      configWith('none'),
      reflectorReturning(false),
    );
    expect(
      guard.canActivate(
        contextFor({
          method: 'POST',
          headers: { origin: 'https://panel.local', host: 'panel.local' },
        }),
      ),
    ).toBe(true);
  });

  it('allows a cross-origin POST when @SkipOriginCheck() metadata is set', () => {
    const guard = new OriginGuard(configWith('lax'), reflectorReturning(true));
    expect(
      guard.canActivate(
        contextFor({
          method: 'POST',
          headers: { origin: 'https://evil.example', host: 'panel.local' },
        }),
      ),
    ).toBe(true);
  });
});
