import { buildZipFixture } from '../utils/zip-fixture.test-helpers';
import { readJarMetadata } from './jar-metadata-reader';

const jar = (files: Record<string, string>): Buffer =>
  buildZipFixture(
    Object.entries(files).map(([name, content]) => ({ name, content })),
  );

describe('readJarMetadata', () => {
  it('reads fabric.mod.json', async () => {
    const meta = await readJarMetadata(
      jar({
        'fabric.mod.json': JSON.stringify({
          schemaVersion: 1,
          id: 'sodium',
          name: 'Sodium',
          version: '0.5.8+mc1.20.1',
          depends: { minecraft: ['1.20', '1.20.1'], fabricloader: '>=0.12' },
        }),
        'net/caffeinemc/Sodium.class': 'x',
      }),
    );
    expect(meta).toEqual({
      manifest: 'fabric.mod.json',
      kind: 'mod',
      loaders: ['fabric'],
      modId: 'sodium',
      name: 'Sodium',
      version: '0.5.8+mc1.20.1',
      mcConstraint: '1.20 || 1.20.1',
    });
  });

  it('reads quilt.mod.json', async () => {
    const meta = await readJarMetadata(
      jar({
        'quilt.mod.json': JSON.stringify({
          quilt_loader: {
            id: 'qsl',
            version: '7.0.0',
            metadata: { name: 'Quilt Standard Libraries' },
            depends: ['quilt_loader', { id: 'minecraft', versions: '>=1.20' }],
          },
        }),
      }),
    );
    expect(meta).toMatchObject({
      manifest: 'quilt.mod.json',
      loaders: ['quilt'],
      modId: 'qsl',
      name: 'Quilt Standard Libraries',
      version: '7.0.0',
      mcConstraint: '>=1.20',
    });
  });

  it('reads META-INF/mods.toml, falling back to MANIFEST.MF for ${file.jarVersion}', async () => {
    const toml = [
      'modLoader="javafml"',
      'loaderVersion="[47,)"',
      '[[mods]]',
      'modId="jei"',
      'version="${file.jarVersion}"',
      'displayName="Just Enough Items"',
      '[[dependencies.jei]]',
      'modId="forge"',
      'versionRange="[47,)"',
      '[[dependencies.jei]]',
      'modId="minecraft"',
      'versionRange="[1.20.1,1.20.2)"',
    ].join('\n');
    const meta = await readJarMetadata(
      jar({
        'META-INF/MANIFEST.MF':
          'Manifest-Version: 1.0\r\nImplementation-Version: 15.2.0.27\r\n',
        'META-INF/mods.toml': toml,
      }),
    );
    expect(meta).toEqual({
      manifest: 'META-INF/mods.toml',
      kind: 'mod',
      loaders: ['forge'],
      modId: 'jei',
      name: 'Just Enough Items',
      version: '15.2.0.27',
      mcConstraint: '[1.20.1,1.20.2)',
    });
  });

  it('prefers neoforge.mods.toml over mods.toml, and lists both loaders', async () => {
    const meta = await readJarMetadata(
      jar({
        'META-INF/mods.toml': '[[mods]]\nmodId="create"\nversion="5.0"\n',
        'META-INF/neoforge.mods.toml':
          '[[mods]]\nmodId="create"\ndisplayName="Create"\nversion="6.0"\n',
      }),
    );
    expect(meta).toMatchObject({
      manifest: 'META-INF/neoforge.mods.toml',
      loaders: ['neoforge', 'forge'],
      name: 'Create',
      version: '6.0',
    });
  });

  it('leaves version null for a placeholder with no MANIFEST.MF to fall back on', async () => {
    const meta = await readJarMetadata(
      jar({
        'META-INF/mods.toml':
          '[[mods]]\nmodId="thing"\nversion="${file.jarVersion}"\n',
      }),
    );
    expect(meta).toMatchObject({
      modId: 'thing',
      name: 'thing',
      version: null,
    });
  });

  it('reads legacy Forge mcmod.info, as a list and as modList v2', async () => {
    const v1 = await readJarMetadata(
      jar({
        'mcmod.info': JSON.stringify([
          {
            modid: 'jei',
            name: 'Just Enough Items',
            version: '4.16.1.301',
            mcversion: '1.12.2',
          },
        ]),
      }),
    );
    expect(v1).toEqual({
      manifest: 'mcmod.info',
      kind: 'mod',
      loaders: ['forge'],
      modId: 'jei',
      name: 'Just Enough Items',
      version: '4.16.1.301',
      mcConstraint: '1.12.2',
    });

    const v2 = await readJarMetadata(
      jar({
        'mcmod.info': JSON.stringify({
          modListVersion: 2,
          modList: [
            { modid: 'ic2', name: 'IndustrialCraft 2', version: '${version}' },
          ],
        }),
      }),
    );
    expect(v2).toMatchObject({
      modId: 'ic2',
      name: 'IndustrialCraft 2',
      version: null,
    });
  });

  it('reads plugin.yml, keeping version strings exactly as written', async () => {
    const meta = await readJarMetadata(
      jar({
        'plugin.yml': [
          'name: LuckPerms',
          'version: 5.10',
          'main: me.lucko.luckperms.bukkit.loader.BukkitLoaderPlugin',
          'api-version: 1.20',
        ].join('\n'),
      }),
    );
    expect(meta).toEqual({
      manifest: 'plugin.yml',
      kind: 'plugin',
      loaders: ['bukkit'],
      modId: 'LuckPerms',
      name: 'LuckPerms',
      version: '5.10',
      mcConstraint: '1.20',
    });
  });

  it('prefers paper-plugin.yml over plugin.yml', async () => {
    const meta = await readJarMetadata(
      jar({
        'plugin.yml': 'name: Old\nversion: 1\n',
        'paper-plugin.yml': 'name: New\nversion: 2\napi-version: "1.21"\n',
      }),
    );
    expect(meta).toMatchObject({
      manifest: 'paper-plugin.yml',
      kind: 'plugin',
      loaders: ['paper', 'bukkit'],
      name: 'New',
      version: '2',
    });
  });

  it('falls through a malformed manifest to the next one', async () => {
    const meta = await readJarMetadata(
      jar({
        'fabric.mod.json': '{ not json',
        'META-INF/mods.toml': '[[mods]]\nmodId="x"\nversion="1.0"\n',
      }),
    );
    expect(meta).toMatchObject({
      manifest: 'META-INF/mods.toml',
      loaders: ['forge', 'fabric'],
      modId: 'x',
    });
  });

  it('tolerates a UTF-8 BOM', async () => {
    const meta = await readJarMetadata(
      jar({ 'fabric.mod.json': '\uFEFF{"id":"bom","version":"1"}' }),
    );
    expect(meta).toMatchObject({ modId: 'bom', name: 'bom', version: '1' });
  });

  it('only reads manifests at the jar root, not nested or look-alike paths', async () => {
    const meta = await readJarMetadata(
      jar({
        'META-INF/jars/fabric.mod.json': '{"id":"nested"}',
        'data/plugin.yml': 'name: Nope\n',
      }),
    );
    expect(meta).toBeNull();
  });

  it('returns null for a jar with no manifest, or bytes that are not a zip', async () => {
    expect(await readJarMetadata(jar({ 'a/B.class': 'x' }))).toBeNull();
    expect(await readJarMetadata(Buffer.from('not a zip at all'))).toBeNull();
    expect(await readJarMetadata(Buffer.alloc(0))).toBeNull();
  });
});
