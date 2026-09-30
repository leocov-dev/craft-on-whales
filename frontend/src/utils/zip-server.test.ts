import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeZipTarget, serverNameFromArchive } from './zip-server.ts';

void test('serverNameFromArchive drops the extension and tidies separators', () => {
  assert.equal(serverNameFromArchive('Cozy Pack 1.2.mrpack'), 'Cozy Pack 1.2');
  assert.equal(serverNameFromArchive('my_mods+configs.ZIP'), 'my mods configs');
  assert.equal(serverNameFromArchive('  spaced   out .zip'), 'spaced out');
  assert.equal(serverNameFromArchive('pack.tar'), 'pack.tar');
  assert.equal(serverNameFromArchive(`${'a'.repeat(100)}.zip`).length, 80);
});

void test('describeZipTarget names the loader build only when there is one', () => {
  assert.equal(
    describeZipTarget({ loader: 'fabric', mcVersion: '1.21.1', loaderVersion: '0.16.5' }),
    'Fabric 0.16.5 · Minecraft 1.21.1',
  );
  assert.equal(
    describeZipTarget({ loader: 'paper', mcVersion: 'LATEST', loaderVersion: null }),
    'Paper · Minecraft LATEST',
  );
});
