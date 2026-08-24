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
