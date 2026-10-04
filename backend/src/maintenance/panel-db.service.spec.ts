import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Logger } from '@nestjs/common';
import { DbService } from '../db/db.service';
import { runMigrations } from '../db/migrate';
import type { ConfigService } from '../config/config.service';
import type { PathGuardService } from '../storage/path-guard.service';
import { PANEL_DB_SNAPSHOTS_KEEP, PanelDbService } from './panel-db.service';

describe('PanelDbService', () => {
  let dataDir: string;
  let dbService: DbService;
  let service: PanelDbService;
  const snapshotDir = () => path.join(dataDir, 'backups', '_panel');

  const open = (): DbService =>
    new DbService({ dbDriver: 'sqlite', dataDir } as unknown as ConfigService);

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paneldb-'));
    dbService = open();
    await runMigrations(dbService);
    service = new PanelDbService(dbService, {
      dataPath: (...p: string[]) => path.join(dataDir, ...p),
    } as unknown as PathGuardService);
  });
  afterEach(async () => {
    await dbService.onModuleDestroy();
    fs.rmSync(dataDir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  it('writes a consistent, private snapshot of the live database', async () => {
    // A committed row that may still sit in the WAL, not the main file.
    dbService['sqlite']!.exec(
      `INSERT INTO settings (key, value_json) VALUES ('marker', '"hello"')`,
    );

    const result = await service.snapshot();

    expect(result).toMatchObject({ pruned: 0 });
    expect(result!.file).toMatch(/^panel-\d{4}(-\d{2}){5}\.db$/);
    const file = path.join(snapshotDir(), result!.file);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const copy = new DatabaseSync(file, { readOnly: true });
    expect(
      copy
        .prepare(`SELECT value_json FROM settings WHERE key = 'marker'`)
        .get(),
    ).toMatchObject({ value_json: '"hello"' });
    copy.close();
    // No half-written leftovers.
    expect(
      fs.readdirSync(snapshotDir()).filter((f) => f.endsWith('.partial')),
    ).toEqual([]);
  });

  it('keeps only the newest snapshots and ignores unrelated files', async () => {
    fs.mkdirSync(snapshotDir(), { recursive: true });
    const old = Array.from(
      { length: PANEL_DB_SNAPSHOTS_KEEP + 2 },
      (_, i) => `panel-2020-01-${String(i + 1).padStart(2, '0')}-00-00-00.db`,
    );
    for (const f of old) fs.writeFileSync(path.join(snapshotDir(), f), 'x');
    fs.writeFileSync(path.join(snapshotDir(), 'notes.txt'), 'keep me');

    const result = await service.snapshot();

    expect(result!.pruned).toBe(3); // 16 old + 1 new = 17 -> keep 14
    const left = fs.readdirSync(snapshotDir()).sort();
    expect(left).toContain('notes.txt');
    expect(left).toContain(result!.file);
    expect(left).not.toContain(old[0]);
    expect(left.filter((f) => f.startsWith('panel-'))).toHaveLength(
      PANEL_DB_SNAPSHOTS_KEEP,
    );
  });

  it('fails cleanly, leaving no partial file, when the source is gone', async () => {
    fs.rmSync(path.join(dataDir, 'panel.db'));
    await expect(service.snapshot()).rejects.toThrow();
    const files = fs.existsSync(snapshotDir())
      ? fs.readdirSync(snapshotDir())
      : [];
    expect(files).toEqual([]);
  });

  it('does nothing under Postgres', async () => {
    const pg = new PanelDbService(
      { driver: 'postgres', sqliteFile: null } as unknown as DbService,
      {} as PathGuardService,
    );
    expect(await pg.snapshot()).toBeNull();
    expect(() => pg.onApplicationBootstrap()).not.toThrow();
  });

  describe('boot integrity check', () => {
    it('is silent for a healthy database', () => {
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
      service.onApplicationBootstrap();
      expect(error).not.toHaveBeenCalled();
    });

    it('says so loudly when the check fails, and points at the snapshots', () => {
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
      jest
        .spyOn(dbService, 'quickCheck')
        .mockReturnValue(['row 3 missing from index x']);
      service.onApplicationBootstrap();
      expect(error).toHaveBeenCalledTimes(2);
      expect(String(error.mock.calls[0]?.[0])).toMatch(/did not pass.*row 3/);
      expect(String(error.mock.calls[1]?.[0])).toMatch(/backups\/_panel/);
    });

    it('never throws if the check itself blows up', () => {
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
      jest.spyOn(dbService, 'quickCheck').mockImplementation(() => {
        throw new Error('database disk image is malformed');
      });
      expect(() => service.onApplicationBootstrap()).not.toThrow();
      expect(String(error.mock.calls[0]?.[0])).toMatch(
        /could not run.*malformed/,
      );
    });
  });
});
