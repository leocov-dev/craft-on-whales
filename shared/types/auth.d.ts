export type Role = 'admin' | 'operator' | 'viewer';

/** `GET /api/session`'s user shape. */
export interface SessionUser {
  id: string;
  username: string;
  role: Role;
  totpEnabled: boolean;
}

/** `GET /auth/status`'s response body. */
export interface AuthStatus {
  firstRunNeeded: boolean;
}

export type SetupCheckLevel = 'pass' | 'warn' | 'fail';

/** `GET /setup/checks`'s response body's `checks` field. */
export interface SetupChecks {
  // Host-fingerprinting fields (os/ncpu/memTotal/installed/isDockerDesktop)
  // were dropped: this endpoint is @Public() and reachable pre-first-run on
  // any bind, and the frontend never read them — only level/available/
  // version/error are shown in the setup wizard.
  docker: {
    level: SetupCheckLevel;
    available: boolean;
    version: string | null;
    error: string | null;
  };
  node: { level: SetupCheckLevel; version: string; required: string };
  dataDir: { level: SetupCheckLevel; path: string };
  sessionSecret: { level: SetupCheckLevel; set: boolean; weak: boolean };
}
