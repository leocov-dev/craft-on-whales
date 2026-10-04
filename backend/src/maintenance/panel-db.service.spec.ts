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
import { fakePgTools } from './pg-dump.test-helpers';

describe('PanelDbService', () => {
  let dataDir: string;
  let dbService: DbService;
  let service: PanelDbService;
  const snapshotDir = () => path.join(dataDir, 'backups', '_panel');

  const pathGuard = () =>
    ({
      dataPath: (...p: string[]) => path.join(dataDir, ...p),
    }) as unknown as PathGuardService;

  const open = (): DbService =>
    new DbService({ dbDriver: 'sqlite', dataDir } as unknown as ConfigService);

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paneldb-'));
    dbService = open();
    await runMigrations(dbService);
    service = new PanelDbService(dbService, pathGuard(), {} as ConfigService);
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

  describe('under Postgres', () => {
    let tools: ReturnType<typeof fakePgTools>;
    let pg: PanelDbService;

    beforeEach(() => {
      tools = fakePgTools(dataDir);
      pg = new PanelDbService(
        { driver: 'postgres', sqliteFile: null } as unknown as DbService,
        pathGuard(),
        { databaseUrl: 'postgres://u:pw@db:5432/panel' } as ConfigService,
      );
      (pg as unknown as { pgTools: typeof tools }).pgTools = tools;
    });

    it('writes a private pg_dump archive and keeps the newest snapshots of either kind', async () => {
      fs.mkdirSync(snapshotDir(), { recursive: true });
      for (let i = 1; i <= PANEL_DB_SNAPSHOTS_KEEP; i++) {
        const ext = i % 2 ? 'db' : 'dump';
        fs.writeFileSync(
          path.join(
            snapshotDir(),
            `panel-2020-01-${String(i).padStart(2, '0')}-00-00-00.${ext}`,
          ),
          'x',
        );
      }

      const result = await pg.snapshot();

      expect(result!.file).toMatch(/^panel-\d{4}(-\d{2}){5}\.dump$/);
      expect(result!.pruned).toBe(1);
      const file = path.join(snapshotDir(), result!.file);
      expect(fs.readFileSync(file, 'utf8')).toBe('PGDUMP');
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      expect(fs.readFileSync(tools.log, 'utf8')).toContain('PGHOST=db');
    });

    it('leaves nothing behind when pg_dump fails', async () => {
      (pg as unknown as { pgTools: unknown }).pgTools = fakePgTools(dataDir, {
        dumpFails: true,
      });
      await expect(pg.snapshot()).rejects.toThrow(/connection refused/);
      expect(fs.readdirSync(snapshotDir())).toEqual([]);
    });

    it('is a no-op without a DATABASE_URL', async () => {
      const bare = new PanelDbService(
        { driver: 'postgres', sqliteFile: null } as unknown as DbService,
        pathGuard(),
        {} as ConfigService,
      );
      expect(await bare.snapshot()).toBeNull();
    });

    it('logs the pg_dump version at boot, or warns at boot when it is missing', async () => {
      const log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      await pg.onApplicationBootstrap();
      expect(String(log.mock.calls[0]?.[0])).toMatch(
        /pg_dump \(PostgreSQL\) 17/,
      );
      expect(warn).not.toHaveBeenCalled();

      (pg as unknown as { pgTools: unknown }).pgTools = {
        dump: path.join(dataDir, 'missing'),
        restore: 'x',
      };
      await pg.onApplicationBootstrap();
      expect(String(warn.mock.calls[0]?.[0])).toMatch(
        /pg_dump is not installed/,
      );
    });
  });

  describe('boot integrity check', () => {
    it('is silent for a healthy database', async () => {
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
      await service.onApplicationBootstrap();
      expect(error).not.toHaveBeenCalled();
    });

    it('says so loudly when the check fails, and points at the snapshots', async () => {
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
      jest
        .spyOn(dbService, 'quickCheck')
        .mockReturnValue(['row 3 missing from index x']);
      await service.onApplicationBootstrap();
      expect(error).toHaveBeenCalledTimes(2);
      expect(String(error.mock.calls[0]?.[0])).toMatch(/did not pass.*row 3/);
      expect(String(error.mock.calls[1]?.[0])).toMatch(/backups\/_panel/);
    });

    it('never throws if the check itself blows up', async () => {
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
      jest.spyOn(dbService, 'quickCheck').mockImplementation(() => {
        throw new Error('database disk image is malformed');
      });
      await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
      expect(String(error.mock.calls[0]?.[0])).toMatch(
        /could not run.*malformed/,
      );
    });
  });
});
