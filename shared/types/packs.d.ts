/** `GET /api/packs/search` row shape. */
export interface PackSearchResult {
  platform: 'modrinth' | 'curseforge';
  ref: string;
  name: string;
  iconUrl: string | null;
  downloads: number;
  description: string;
}
