import type { ExecutionContext } from '@nestjs/common';
import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from './roles.guard';
import type { Role } from '../auth.service';
import { EventsController } from '../../api/events.controller';
import { BlueprintsController } from '../../blueprints/blueprints.controller';
import { CrashesController } from '../../crashes/crashes.controller';
import {
  WorldsController,
  ServerWorldsController,
} from '../../worlds/worlds.controller';
import { IntegrationsController } from '../../integrations/integrations.controller';

/**
 * Upstream-parity item 2.15: side-effecting GETs (bulk data exports and
 * on-the-fly archive generation) are gated to admin/operator, the same way
 * `UPSTREAM_PARITY.md` records for events/world/`.mrpack` downloads. This
 * exercises `RolesGuard` against the *actual* decorated route handlers
 * (real `getHandler()`/`getClass()` values, so it reads the real
 * `@Roles()` metadata rather than a hand-rolled stand-in) for every route
 * this PR newly gated.
 */
function contextFor(
  handler: (...args: never[]) => unknown,
  cls: new (...args: never[]) => unknown,
  role: Role | undefined,
): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => cls,
    switchToHttp: () => ({
      getRequest: () => ({
        user: role ? { id: 'usr_1', username: 'u', role } : undefined,
      }),
    }),
  } as unknown as ExecutionContext;
}

describe('RolesGuard — side-effecting GET routes gated to admin/operator', () => {
  const guard = new RolesGuard(new Reflector());

  // These are identity references only (handed to `getHandler()` so the
  // guard can look up its `@Roles()` metadata) — never invoked as unbound
  // methods, so the lint rule guarding against that doesn't apply here.
  /* eslint-disable @typescript-eslint/unbound-method */
  const cases: Array<
    [string, (...args: never[]) => unknown, new (...args: never[]) => unknown]
  > = [
    [
      'GET /api/events/export',
      EventsController.prototype.export,
      EventsController,
    ],
    [
      'GET /api/servers/:id/events/export',
      EventsController.prototype.exportForServer,
      EventsController,
    ],
    [
      'GET /api/blueprints/:id/download',
      BlueprintsController.prototype.download,
      BlueprintsController,
    ],
    [
      'GET /api/servers/:id/crashes/export.zip',
      CrashesController.prototype.exportZip,
      CrashesController,
    ],
    [
      'GET /api/worlds/:id/download',
      WorldsController.prototype.download,
      WorldsController,
    ],
    [
      'GET /api/servers/:id/worlds/:world/download',
      ServerWorldsController.prototype.download,
      ServerWorldsController,
    ],
    [
      'GET /api/servers/:id/integrations/invite/modpack.mrpack',
      IntegrationsController.prototype.mrpack,
      IntegrationsController,
    ],
  ];
  /* eslint-enable @typescript-eslint/unbound-method */

  it.each(cases)(
    '%s rejects an unauthenticated caller',
    (_name, handler, cls) => {
      expect(() =>
        guard.canActivate(contextFor(handler, cls, undefined)),
      ).toThrow(ForbiddenException);
    },
  );

  it.each(cases)('%s rejects a viewer', (_name, handler, cls) => {
    expect(() => guard.canActivate(contextFor(handler, cls, 'viewer'))).toThrow(
      ForbiddenException,
    );
  });

  it.each(cases)('%s allows an operator', (_name, handler, cls) => {
    expect(guard.canActivate(contextFor(handler, cls, 'operator'))).toBe(true);
  });

  it.each(cases)('%s allows an admin', (_name, handler, cls) => {
    expect(guard.canActivate(contextFor(handler, cls, 'admin'))).toBe(true);
  });
});
