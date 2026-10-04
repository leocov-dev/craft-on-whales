import {
  acceptedLoaders,
  loaderAccepts,
  preferOwnLoader,
} from './loader-compat';

describe('loader-compat', () => {
  it('lists the own loader first, then its fallbacks', () => {
    expect(acceptedLoaders('quilt')).toEqual(['quilt', 'fabric']);
    expect(acceptedLoaders('Quilt')).toEqual(['quilt', 'fabric']);
  });

  it('gives every other loader no fallback (Fabric does not run Quilt mods)', () => {
    expect(acceptedLoaders('fabric')).toEqual(['fabric']);
    expect(acceptedLoaders('forge')).toEqual(['forge']);
    expect(acceptedLoaders('neoforge')).toEqual(['neoforge']);
  });

  it('accepts fabric tags on quilt, not the reverse', () => {
    expect(loaderAccepts('quilt', ['fabric'])).toBe(true);
    expect(loaderAccepts('quilt', ['forge'])).toBe(false);
    expect(loaderAccepts('fabric', ['quilt'])).toBe(false);
    expect(loaderAccepts('quilt', ['Fabric'])).toBe(true);
  });

  describe('preferOwnLoader', () => {
    const builds = [
      { id: 'newest-fabric', loaders: ['fabric'] },
      { id: 'quilt-a', loaders: ['quilt', 'fabric'] },
      { id: 'older-fabric', loaders: ['fabric'] },
      { id: 'quilt-b', loaders: ['quilt'] },
    ];
    const ids = (list: typeof builds) => list.map((b) => b.id);

    it('puts own-loader builds first and keeps order within each group', () => {
      expect(ids(preferOwnLoader(builds, 'quilt', (b) => b.loaders))).toEqual([
        'quilt-a',
        'quilt-b',
        'newest-fabric',
        'older-fabric',
      ]);
    });

    it('leaves the order alone with no loader or no fallback tags', () => {
      expect(ids(preferOwnLoader(builds, undefined, (b) => b.loaders))).toEqual(
        ids(builds),
      );
      expect(ids(preferOwnLoader(builds, 'forge', (b) => b.loaders))).toEqual(
        ids(builds),
      );
    });

    it('treats untagged builds as not own', () => {
      expect(
        preferOwnLoader(['a', 'b'], 'quilt', (x) =>
          x === 'b' ? ['quilt'] : undefined,
        ),
      ).toEqual(['b', 'a']);
    });
  });
});
