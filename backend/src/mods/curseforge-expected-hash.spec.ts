import { curseforgeExpectedHash } from './curseforge-api.service';
import type { CurseforgeFile } from './mods.types';

const baseFile: CurseforgeFile = {
  fileId: 1,
  name: 'Some Mod 1.0.0',
  fileName: 'somemod-1.0.0.jar',
  downloadUrl: 'https://edge.forgecdn.net/files/1/2/somemod-1.0.0.jar',
  gameVersions: ['1.21'],
  releaseType: 'release',
  fileDate: '2026-01-01T00:00:00Z',
  fileLength: 1024,
  hashes: [],
  serverPackFileId: null,
  dependencies: [],
};

describe('curseforgeExpectedHash', () => {
  it('picks sha1 (algo 1) when present', () => {
    const file: CurseforgeFile = {
      ...baseFile,
      hashes: [
        { value: 'deadbeef', algo: 1 },
        { value: 'cafef00d', algo: 2 },
      ],
    };
    expect(curseforgeExpectedHash(file)).toEqual({
      algorithm: 'sha1',
      hex: 'deadbeef',
    });
  });

  it('falls back to md5 (algo 2) when sha1 is absent', () => {
    const file: CurseforgeFile = {
      ...baseFile,
      hashes: [{ value: 'cafef00d', algo: 2 }],
    };
    expect(curseforgeExpectedHash(file)).toEqual({
      algorithm: 'md5',
      hex: 'cafef00d',
    });
  });

  it('returns null when the file has no hashes at all', () => {
    expect(curseforgeExpectedHash({ ...baseFile, hashes: [] })).toBeNull();
  });
});
