// Ambient type augmentations, mirroring the legacy app's types/globals.d.ts.
// This file has a top-level `export {}`, making it a module — required so
// `declare module 'express-session'` AUGMENTS (rather than shadows) the real
// express-session types.

import type { PublicUser } from '../auth/auth.service';

declare global {
  namespace Express {
    interface Request {
      user?: PublicUser;
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
