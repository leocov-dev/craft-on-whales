// Ambient type augmentations for JS patterns that `tsc --checkJs` can't infer
// on its own. These describe real shapes the code relies on — not suppressions.
//
// This file has a top-level `export {}` at the bottom, making it a module —
// required so the `declare module 'express-session'` block below AUGMENTS
// (rather than shadows) the real express-session types. Everything meant for
// the global scope is explicitly wrapped in `declare global { ... }`.

declare global {
  // The panel attaches an HTTP status (and sometimes a code) to Error objects
  // throughout: see src/utils/httpError.js and the `Object.assign(new Error(), {
  // status })` / `err.status = 4xx` pattern used by services and route guards.
  interface Error {
    status?: number;
    code?: string;
    // src/updates/upgrade.js's version-change confirmation gate and rollback
    // signal — read back by src/services/tasks.js and src/web/routes/api.js.
    requiresVersionConfirm?: boolean;
    fromMcVersion?: string;
    toMcVersion?: string;
    rollbackAvailable?: boolean;
  }

  // requireAuth (src/web/middleware/auth.ts) attaches the signed-in user to
  // every authenticated request; res.locals.user mirrors it for templates. The
  // shape matches services/auth.ts's PublicUser (not exported — see that
  // file's note on type-only exports alongside `export =`), duplicated here
  // since Express.Request augmentation must live in a global-scope .d.ts.
  namespace Express {
    interface AuthUser {
      id: string;
      username: string;
      role: 'admin' | 'operator' | 'viewer';
      createdAt: string;
      totpEnabled: boolean;
    }

    interface Request {
      user?: AuthUser;
    }

    interface Locals {
      user?: AuthUser;
    }
  }
}

// express-session's SessionData is an empty interface meant for consumers to
// augment (see its own doc comment). src/web/routes/auth.js's login/2FA flow
// stores the signed-in user id here, plus the pending-2FA state between the
// password step and the TOTP-code step.
declare module 'express-session' {
  interface SessionData {
    userId?: string;
    pendingTotpUserId?: string;
    pendingTotpUsername?: string;
    pendingTotpNext?: string;
  }
}

export {};
