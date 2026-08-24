// Wraps GET /api/storage (breakdown), POST /api/storage/scan (re-scan), and
// POST /api/storage/cleanup (dry-run preview + real execution).

import { http } from './http';
import type {
  CleanupAction,
  StorageCategory,
  StorageBreakdownSegment,
  CleanupPreview,
  LargestFile,
  StorageData,
} from '../../../shared/types/storage';

export type {
  CleanupAction,
  StorageCategory,
  StorageBreakdownSegment,
  CleanupPreview,
  LargestFile,
  StorageData,
};

interface StorageResponse {
  ok: true;
  storage: StorageData;
}

interface CleanupResult {
  ok: true;
  dryRun: boolean;
  removed: number;
  freedBytes: number;
}

export const storageApi = {
  get: () => http.get<StorageResponse>('/api/storage'),
  scan: () => http.post<{ ok: true }>('/api/storage/scan'),
  cleanup: (action: CleanupAction, olderThanDays: number | undefined, dryRun: boolean) =>
    http.post<CleanupResult>('/api/storage/cleanup', { action, olderThanDays, dryRun }),
};
