import { BadRequestException } from '@nestjs/common';
import { PackPinGuardService } from './pack-pin-guard.service';

describe('PackPinGuardService', () => {
  const guard = new PackPinGuardService();

  it('passes pinned envs for every platform', () => {
    expect(
      guard.unpinnedSelectors('AUTO_CURSEFORGE', {
        CF_SLUG: 'all-the-mods-10',
        CF_FILE_ID: '5891234',
      }),
    ).toEqual([]);
    expect(
      guard.unpinnedSelectors('MODRINTH', {
        MODRINTH_MODPACK: 'cobblemon',
        MODRINTH_VERSION: 'AbCd1234',
      }),
    ).toEqual([]);
    expect(
      guard.unpinnedSelectors('FTBA', {
        FTB_MODPACK_ID: '126',
        FTB_MODPACK_VERSION_ID: '11929',
      }),
    ).toEqual([]);
    expect(
      guard.unpinnedSelectors('GTNH', { GTNH_PACK_VERSION: '2.8.4' }),
    ).toEqual([]);
    expect(() =>
      guard.assertPinned('AUTO_CURSEFORGE', {
        CF_SLUG: 'atm10',
        CF_FILE_ID: '1',
      }),
    ).not.toThrow();
  });

  it('detects an unpinned selector per platform', () => {
    expect(
      guard.unpinnedSelectors('AUTO_CURSEFORGE', {
        CF_SLUG: 'all-the-mods-10',
      })[0].pinKey,
    ).toBe('CF_FILE_ID');
    expect(
      guard.unpinnedSelectors('AUTO_CURSEFORGE', {
        CF_PAGE_URL: 'https://www.curseforge.com/minecraft/modpacks/atm10',
      })[0].pinKey,
    ).toBe('CF_FILE_ID');
    expect(
      guard.unpinnedSelectors('MODRINTH', { MODRINTH_MODPACK: 'cobblemon' })[0]
        .pinKey,
    ).toBe('MODRINTH_VERSION');
    expect(
      guard.unpinnedSelectors('FTBA', { FTB_MODPACK_ID: '126' })[0].pinKey,
    ).toBe('FTB_MODPACK_VERSION_ID');
    expect(guard.unpinnedSelectors('GTNH', {})[0].pinKey).toBe(
      'GTNH_PACK_VERSION',
    );
  });

  it('extracts a lowercased projectRef for cross-checking against server_packs', () => {
    expect(
      guard.unpinnedSelectors('AUTO_CURSEFORGE', { CF_SLUG: 'ATM-10' })[0]
        .projectRef,
    ).toBe('atm-10');
    expect(
      guard.unpinnedSelectors('AUTO_CURSEFORGE', {
        CF_PAGE_URL:
          'https://www.curseforge.com/minecraft/modpacks/All-The-Mods-10',
      })[0].projectRef,
    ).toBe('all-the-mods-10');
    expect(
      guard.unpinnedSelectors('MODRINTH', { MODRINTH_MODPACK: 'Cobblemon' })[0]
        .projectRef,
    ).toBe('cobblemon');
    expect(guard.unpinnedSelectors('GTNH', {})[0].projectRef).toBe('gtnh');
  });

  it('treats a URL-embedded pin and a fixed local zip as pinned', () => {
    expect(
      guard.unpinnedSelectors('AUTO_CURSEFORGE', {
        CF_PAGE_URL:
          'https://www.curseforge.com/minecraft/modpacks/atm10/files/5891234',
      }),
    ).toEqual([]);
    expect(
      guard.unpinnedSelectors('MODRINTH', {
        MODRINTH_MODPACK:
          'https://modrinth.com/modpack/cobblemon/version/1.6.1',
      }),
    ).toEqual([]);
    expect(
      guard.unpinnedSelectors('AUTO_CURSEFORGE', {
        CF_SLUG: 'atm10',
        CF_MODPACK_ZIP: '/packs/mine.zip',
      }),
    ).toEqual([]);
  });

  it('treats an empty-string pin as not pinned', () => {
    expect(
      guard.unpinnedSelectors('AUTO_CURSEFORGE', {
        CF_SLUG: 'atm10',
        CF_FILE_ID: '   ',
      }),
    ).toHaveLength(1);
  });

  it('leaves non-pack servers and selector-less pack types alone', () => {
    expect(guard.unpinnedSelectors('PAPER', { MEMORY: '4G' })).toEqual([]);
    // AUTO_CURSEFORGE with no selector at all can't auto-update anything —
    // the container's own "no modpack given" failure is not this guard's job.
    expect(guard.unpinnedSelectors('AUTO_CURSEFORGE', {})).toEqual([]);
  });

  it('assertPinned throws a 400 naming the missing pin', () => {
    expect(() =>
      guard.assertPinned('AUTO_CURSEFORGE', { CF_SLUG: 'all-the-mods-10' }),
    ).toThrow(BadRequestException);
    try {
      guard.assertPinned('AUTO_CURSEFORGE', { CF_SLUG: 'all-the-mods-10' });
      fail('expected a throw');
    } catch (err) {
      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as BadRequestException).message).toMatch(/CF_FILE_ID/);
      expect((err as BadRequestException).message).toMatch(/every start/);
    }
  });
});
