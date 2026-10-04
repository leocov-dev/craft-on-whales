import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  PgToolMissingError,
  pgDump,
  pgDumpVersion,
  pgEnvFromUrl,
} from './pg-dump';
import { fakePgTools } from './pg-dump.test-helpers';

describe('pgEnvFromUrl', () => {
  it('maps a URL to PG* variables, decoding escaped credentials', () => {
    expect(
      pgEnvFromUrl('postgres://panel:p%40ss%2Fw%3Ard@db.internal:5433/msm'),
    ).toEqual({
      PGHOST: 'db.internal',
      PGPORT: '5433',
      PGUSER: 'panel',
      PGPASSWORD: 'p@ss/w:rd',
      PGDATABASE: 'msm',
    });
  });

  it('carries the TLS and socket parameters libpq understands, ignoring the rest', () => {
    expect(
      pgEnvFromUrl(
        'postgresql://u:p@h/db?sslmode=verify-full&sslrootcert=/ca.pem&connect_timeout=5&host=/var/run/postgresql&application_name=x&options=-c%20foo',
      ),
    ).toEqual({
      PGHOST: '/var/run/postgresql', // a socket dir overrides the URL host
      PGUSER: 'u',
      PGPASSWORD: 'p',
      PGDATABASE: 'db',
      PGSSLMODE: 'verify-full',
      PGSSLROOTCERT: '/ca.pem',
      PGCONNECT_TIMEOUT: '5',
    });
  });

  it('omits what the URL does not say', () => {
    expect(pgEnvFromUrl('postgres://localhost/panel')).toEqual({
      PGHOST: 'localhost',
      PGDATABASE: 'panel',
    });
  });
});

describe('pgDump', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pgdump-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.SESSION_SECRET;
  });

  const env = {
    PGHOST: 'h',
    PGUSER: 'u',
    PGPASSWORD: 'hunter2',
    PGDATABASE: 'd',
  };

  it('dumps in custom format and validates the archive, passing the URL only via env', async () => {
    process.env.SESSION_SECRET = 'panel-secret';
    const tools = fakePgTools(dir);
    const dest = path.join(dir, 'out.dump');

    await pgDump(tools, env, dest);

    expect(fs.readFileSync(dest, 'utf8')).toBe('PGDUMP');
    const log = fs.readFileSync(tools.log, 'utf8');
    expect(log).toContain('PGPASSWORD=hunter2');
    expect(log).toContain('PGDATABASE=d');
    expect(log).toContain('--format=custom --no-owner --no-privileges --file');
    // The password is never an argument, and the panel's own secrets stay out.
    expect(log.split('\n').at(-2)).not.toContain('hunter2');
    expect(log).not.toContain('panel-secret');
  });

  it('reports the tool’s stderr when pg_dump fails', async () => {
    const tools = fakePgTools(dir, { dumpFails: true });
    await expect(pgDump(tools, env, path.join(dir, 'o'))).rejects.toThrow(
      /failed: connection refused/,
    );
  });

  it('rejects an archive pg_restore cannot read', async () => {
    const tools = fakePgTools(dir, { restoreFails: true });
    await expect(pgDump(tools, env, path.join(dir, 'o'))).rejects.toThrow(
      /not a pg_dump archive/,
    );
  });

  it('says so plainly when the binary is not installed', async () => {
    await expect(
      pgDump(
        { dump: path.join(dir, 'nope'), restore: 'x' },
        env,
        path.join(dir, 'o'),
      ),
    ).rejects.toBeInstanceOf(PgToolMissingError);
  });

  it('pgDumpVersion returns the banner, or null when not installed', async () => {
    const tools = fakePgTools(dir);
    expect(await pgDumpVersion(tools.dump)).toBe('pg_dump (PostgreSQL) 17.0');
    expect(await pgDumpVersion(path.join(dir, 'nope'))).toBeNull();
  });
});
