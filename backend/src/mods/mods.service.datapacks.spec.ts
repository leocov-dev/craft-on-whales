import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ConfigService } from '../config/config.service';
import { PathGuardService } from '../storage/path-guard.service';
import { DatapacksService } from './datapacks.service';
import { ModsService } from './mods.service';

// ModsService's datapack seams: delegation, the content dir, and overlay
// re-apply, against a real PathGuard + DatapacksService on a scratch dir.

const SERVER = 'srv1';

interface Row {
  id: string;
  serverId: string;
  libraryId: string | null;
  kind: string;
  managedBy: string;
  name: string;
  filename: string;
  enabled: boolean;
}

const row = (over: Partial<Row>): Row => ({
  id: 'sc_1',
  serverId: SERVER,
  libraryId: 'lib1',
  kind: 'datapack',
  managedBy: 'overlay',
  name: 'Pack',
  filename: 'p.zip',
  enabled: true,
  ...over,
});

describe('ModsService datapack handling', () => {
  let root: string;
  let rows: Row[];
  let env: Record<string, string>;
  let installs: { dest: string; filename?: string }[];
  let datapacks: DatapacksService;
  let mods: ModsService;

  const server = () => ({ id: SERVER, type: 'VANILLA', env });
  const serverDir = () => path.join(root, 'servers', SERVER);
  const put = (rel: string) => {
    const abs = path.join(serverDir(), rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, 'x');
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mods-datapacks-'));
    fs.mkdirSync(serverDir(), { recursive: true });
    rows = [];
    env = {};
    installs = [];
    const pathGuard = new PathGuardService({ dataDir: root } as ConfigService);
    const query = {
      getServer: () => Promise.resolve(server()),
      mustGet: () => Promise.resolve(server()),
    };
    datapacks = new DatapacksService(
      {} as never,
      pathGuard,
      { get: () => undefined } as never,
      query as never,
      {} as never,
      {} as never,
    );
    const select = () => ({
      from: () => ({
        where: () =>
          Object.assign(Promise.resolve(rows), {
            limit: () => Promise.resolve(rows.slice(0, 1)),
          }),
      }),
    });
    const library = {
      installToServer: (
        _id: string,
        _server: string,
        dest: string,
        opts?: { filename?: string },
      ) => {
        installs.push({ dest, filename: opts?.filename });
        return Promise.resolve({ installedPath: '', filename: 'x' });
      },
    };
    mods = new ModsService(
      { db: { select } } as never,
      pathGuard,
      {} as never,
      { recordEvent: () => undefined } as never,
      library as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      query as never,
      {} as never,
      {} as never,
      {} as never,
      datapacks,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('contentDir puts datapacks in the active world', () => {
    expect(mods.contentDir(server(), 'datapack')).toBe('world/datapacks');
    env.LEVEL = 'survival';
    expect(mods.contentDir(server(), 'datapack')).toBe('survival/datapacks');
    expect(mods.contentDir(server(), 'resourcepack')).toBe('resourcepacks');
  });

  it('setEnabled delegates datapack rows to DatapacksService', async () => {
    rows.push(row({}));
    const spy = jest
      .spyOn(datapacks, 'setEnabled')
      .mockResolvedValue({ applied: 'on-restart' });
    await expect(
      mods.setEnabled(SERVER, 'p.zip', false, { actor: 'me' }),
    ).resolves.toEqual({ applied: 'on-restart' });
    expect(spy).toHaveBeenCalledWith(SERVER, 'p.zip', false, { actor: 'me' });
  });

  it('removeContent delegates datapack rows to DatapacksService', async () => {
    rows.push(row({}));
    const spy = jest
      .spyOn(datapacks, 'removeDatapack')
      .mockResolvedValue({ freedBytes: 7 });
    await expect(
      mods.removeContent(SERVER, 'p.zip', { actor: 'me' }),
    ).resolves.toEqual({ freedBytes: 7 });
    expect(spy).toHaveBeenCalledWith(SERVER, 'p.zip', { actor: 'me' });
  });

  describe('reapplyOverlay', () => {
    it('restores a missing enabled datapack into datapacks/', async () => {
      rows.push(row({}));
      await expect(mods.reapplyOverlay(SERVER)).resolves.toEqual({
        restored: 1,
      });
      expect(installs).toEqual([
        { dest: 'world/datapacks', filename: 'p.zip' },
      ]);
    });

    it('restores a missing disabled datapack into datapacks.disabled/', async () => {
      rows.push(row({ enabled: false }));
      await mods.reapplyOverlay(SERVER);
      expect(installs).toEqual([
        { dest: 'world/datapacks.disabled', filename: 'p.zip' },
      ]);
    });

    it('leaves a pack alone when present in either dir', async () => {
      put('world/datapacks/p.zip');
      put('world/datapacks.disabled/q.zip');
      rows.push(
        row({}),
        row({ id: 'sc_2', filename: 'q.zip', enabled: false }),
      );
      await expect(mods.reapplyOverlay(SERVER)).resolves.toEqual({
        restored: 0,
      });
      expect(installs).toEqual([]);
    });

    it('does not duplicate a legacy x.zip.disabled into datapacks.disabled/', async () => {
      put('world/datapacks/p.zip.disabled');
      rows.push(row({ enabled: false }));
      await expect(mods.reapplyOverlay(SERVER)).resolves.toEqual({
        restored: 0,
      });
      expect(installs).toEqual([]);
    });

    it('a hostile level name skips the datapack rows but still restores mods', async () => {
      env.LEVEL = '../escape';
      rows.push(
        row({}),
        row({
          id: 'sc_2',
          kind: 'mod',
          filename: 'm.jar',
          libraryId: 'lib2',
        }),
      );
      await expect(mods.reapplyOverlay(SERVER)).resolves.toEqual({
        restored: 1,
      });
      expect(installs).toEqual([{ dest: 'mods', filename: 'm.jar' }]);
    });
  });
});
