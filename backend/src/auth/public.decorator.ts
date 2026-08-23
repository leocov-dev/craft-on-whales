import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/** Exempts a route from SessionAuthGuard — matches legacy's PUBLIC_PATHS/PUBLIC_PREFIXES allowlist. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
