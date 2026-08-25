import { BadRequestException } from '@nestjs/common';
import { z, ZodError } from 'zod';

/** Parses `value` against `schema`, throwing a 400 with Zod's first issue message on failure. */
export function parseBody<T extends z.ZodType>(
  schema: T,
  value: unknown,
): z.infer<T> {
  try {
    return schema.parse(value);
  } catch (err) {
    if (err instanceof ZodError)
      throw new BadRequestException(
        err.issues[0]?.message || 'Invalid request',
      );
    throw err;
  }
}
