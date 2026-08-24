// Wraps the JSON auth endpoints in src/web/routes/auth.ts and the
// GET /api/session endpoint in src/web/routes/api.ts.

import { http } from './http';
import type {
  AuthStatus,
  Role,
  SessionUser,
  SetupCheckLevel,
  SetupChecks,
} from '../../../shared/types/auth';

export type { AuthStatus, Role, SessionUser, SetupCheckLevel, SetupChecks };

interface AuthStatusResponse {
  ok: true;
  status: AuthStatus;
}

interface SessionResponse {
  ok: true;
  user: SessionUser;
}

interface LoginResponse {
  ok: true;
  totpRequired: boolean;
}

interface TotpLoginResponse {
  ok: true;
}

interface LogoutResponse {
  ok: true;
}

interface SetupResponse {
  ok: true;
  user: { username: string };
}

interface SetupChecksResponse {
  ok: true;
  checks: SetupChecks;
}

export const authApi = {
  status: () => http.get<AuthStatusResponse>('/auth/status'),
  session: () => http.get<SessionResponse>('/api/session'),
  login: (username: string, password: string, next?: string) =>
    http.post<LoginResponse>('/login', { username, password, next }),
  loginTotp: (code: string) => http.post<TotpLoginResponse>('/login/2fa', { code }),
  logout: () => http.post<LogoutResponse>('/logout'),
  setup: (username: string, password: string) =>
    http.post<SetupResponse>('/setup', { username, password }),
  setupChecks: () => http.get<SetupChecksResponse>('/setup/checks'),
};
