// Ambient type augmentations, mirroring the legacy app's types/globals.d.ts.
// This file has a top-level `export {}`, making it a module — required so
// `declare module 'express-session'` AUGMENTS (rather than shadows) the real
// express-session types.

import type { PublicUser } from '../auth/auth.service';

declare global {
  namespace Express {
    interface Request {
      user?: PublicUser;
      /**
       * Populated by `BearerAuthGuard` for `/api/v1/*` public-API requests
       * (`backend/src/api-tokens/`) — the resolved token's scope, never set
       * on a cookie-session request. `serverIds: null` means "every server."
       */
      apiToken?: { id: string; label: string; serverIds: string[] | null };
    }
  }
}

declare module 'express-session' {
  interface SessionData {
    userId?: string;
    pendingTotpUserId?: string;
    pendingTotpUsername?: string;
    pendingTotpNext?: string;
  }
}

export {};
