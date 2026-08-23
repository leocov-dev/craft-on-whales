export type CleanupAction = 'tmp' | 'orphans' | 'old-logs' | 'old-crashes';

export interface StorageCategory {
  name: string;
  path: string;
  link: string;
  size: number;
}

export interface StorageBreakdownSegment {
  label: string;
  color: string;
  size: number;
  width: number;
}

export interface CleanupPreview {
  key: CleanupAction;
  action: string;
  frees: number;
  count: number;
  days: number | null;
}

export interface LargestFile {
  path: string;
  size: number;
  link: string;
}

/** `GET /api/storage`'s `storage` field. */
export interface StorageData {
  totalUsed: number;
  diskFree: number;
  diskTotal: number;
  lastScan: string | null;
  categories: StorageCategory[];
  breakdown: StorageBreakdownSegment[];
  largestFiles: LargestFile[];
  cleanup: CleanupPreview[];
  trend: number[];
}
