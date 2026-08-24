// Wraps GET/POST /api/keys, /api/settings, /api/settings/localization, and
// the /api/users CRUD routes in src/web/routes/api.ts.

import { http } from './http';
import type { Role } from './auth';
import type {
  ResourceDefaults,
  SettingsResponseData,
  Localization,
  PublicUser,
} from '../../../shared/types/settings';

export type { ResourceDefaults, SettingsResponseData, Localization, PublicUser };
/** @deprecated use {@link PublicUser} — kept as an alias so existing imports don't break. */
export type PanelUser = PublicUser;

interface KeysResponse {
  ok: true;
  curseforge: { masked: string | null };
}

interface LocalizationResponse {
  ok: true;
  localization: Localization;
}

interface UsersResponse {
  ok: true;
  users: PanelUser[];
}

export const settingsApi = {
  keys: () => http.get<KeysResponse>('/api/keys'),
  saveCurseforgeKey: (key: string) => http.post<{ ok: true }>('/api/keys/curseforge', { key }),
  testCurseforgeKey: () => http.post<{ ok: boolean; error?: string }>('/api/keys/curseforge/test'),
  get: () => http.get<SettingsResponseData>('/api/settings'),
  savePublicHost: (publicHost: string) =>
    http.post<{ ok: true; publicHost: string }>('/api/settings', { publicHost }),
  localization: () => http.get<LocalizationResponse>('/api/settings/localization'),
  saveLocalization: (input: Partial<Localization>) =>
    http.post<LocalizationResponse>('/api/settings/localization', input),

  users: () => http.get<UsersResponse>('/api/users'),
  createUser: (username: string, password: string, role: Role) =>
    http.post<{ ok: true; user: PanelUser }>('/api/users', { username, password, role }),
  setUserRole: (id: string, role: Role) =>
    http.post<{ ok: true }>(`/api/users/${id}/role`, { role }),
  setUserPassword: (id: string, password: string) =>
    http.post<{ ok: true }>(`/api/users/${id}/password`, { password }),
  deleteUser: (id: string) => http.delete<{ ok: true }>(`/api/users/${id}`),
  resetUserTotp: (id: string) => http.post<{ ok: true }>(`/api/users/${id}/totp/disable`),
};
