import { ForbiddenException } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';

/**
 * The 4 advanced-Docker-settings override fields, shared by `createSchema`/
 * `patchSchema` (`servers.controller.ts`) and `previewSchema`
 * (`docker-admin.controller.ts`). Split into its own module so both
 * controllers can spread it without re-declaring it.
 */
export const dockerOverridesSchema = {
  containerName: z
    .union([
      z.literal(''),
      z
        .string()
        .trim()
        .max(63)
        .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/),
    ])
    .optional(),
  networkName: z.string().trim().max(128).optional(),
  extraPorts: z
    .array(
      z.object({
        hostPort: z.coerce.number().int().min(1024).max(65535),
        containerPort: z.coerce.number().int().min(1).max(65535),
        protocol: z.enum(['tcp', 'udp']),
        label: z.string().trim().max(40).optional(),
      }),
    )
    .max(20)
    .optional(),
  extraBinds: z
    .array(
      z.object({
        hostPath: z.string().trim().min(1).max(500),
        containerPath: z.string().trim().min(1).max(300),
        mode: z.enum(['rw', 'ro']).optional(),
      }),
    )
    .max(20)
    .optional(),
};

export interface OverridesInput {
  containerName?: string;
  networkName?: string;
  extraPorts?: unknown;
  extraBinds?: unknown;
}

export function overridesPresent(input: OverridesInput): boolean {
  return (
    input.containerName !== undefined ||
    input.networkName !== undefined ||
    input.extraPorts !== undefined ||
    input.extraBinds !== undefined
  );
}

/**
 * Hand-rolled admin gate for the docker-override fields embedded in
 * create/patch payloads. NOT replaced with a route-level `@Roles('admin')`
 * guard: create/patch are used by non-admins too whenever the payload
 * doesn't touch containerName/networkName/extraPorts/extraBinds — the
 * guard would have to be conditional on which fields are *present in this
 * particular request body*, which `@Roles()` can't express. See
 * `.plan/reviews/02-api-servers.md` finding #2. Shared by
 * `servers.controller.ts`, `blueprints.controller.ts`, and
 * `mods.controller.ts` — all three embed these same override fields.
 */
export function requireAdminForOverrides(
  req: Request,
  input: OverridesInput,
): void {
  if (overridesPresent(input) && req.user?.role !== 'admin') {
    throw new ForbiddenException(
      'Advanced Docker settings (container name, network, extra ports/binds) require the admin role.',
    );
  }
}
