import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { Test } from '@nestjs/testing';
import { DbService } from '../db/db.service';
import { RestartHookService } from './restart-hook.service';

const MIGRATIONS_DIR = path.resolve(__dirname, '..', '..', 'drizzle');

describe('RestartHookService', () => {
  let service: RestartHookService;

  beforeEach(async () => {
    const sqlite = new DatabaseSync(':memory:');
    for (const dir of fs.readdirSync(MIGRATIONS_DIR).sort()) {
      const file = path.join(MIGRATIONS_DIR, dir, 'migration.sql');
      if (!fs.existsSync(file)) continue;
      for (const stmt of fs
        .readFileSync(file, 'utf8')
        .split('--> statement-breakpoint')) {
        if (stmt.trim()) sqlite.exec(stmt);
      }
    }
    const db = drizzle({ client: sqlite });
    const moduleRef = await Test.createTestingModule({
      providers: [RestartHookService, { provide: DbService, useValue: { db } }],
    }).compile();
    service = moduleRef.get(RestartHookService);
  });

  it('starts disabled with no key', async () => {
    const cfg = await service.getConfig('srv_a');
    expect(cfg).toMatchObject({ enabled: false, hasKey: false });
    expect(await service.verify('srv_a', 'anything')).toBe(false);
  });

  it('cannot be enabled without a key', async () => {
    expect((await service.setEnabled('srv_a', true)).enabled).toBe(false);
  });

  it('a generated key works for its own server only', async () => {
    const { key, restartHook } = await service.regenerateKey('srv_a');
    expect(restartHook.enabled).toBe(true);
    expect(key).toMatch(/^cow_rst_/);
    expect(await service.verify('srv_a', key)).toBe(true);
    expect(await service.verify('srv_b', key)).toBe(false);
    expect(await service.verify('srv_a', key + 'x')).toBe(false);
  });

  it('never stores the raw key', async () => {
    const { key } = await service.regenerateKey('srv_a');
    expect(JSON.stringify(await service.getConfig('srv_a'))).not.toContain(key);
  });

  it('regenerating invalidates the old key', async () => {
    const first = await service.regenerateKey('srv_a');
    const second = await service.regenerateKey('srv_a');
    expect(await service.verify('srv_a', first.key)).toBe(false);
    expect(await service.verify('srv_a', second.key)).toBe(true);
  });

  it('disabled or cleared hook rejects the key', async () => {
    const { key } = await service.regenerateKey('srv_a');
    await service.setEnabled('srv_a', false);
    expect(await service.verify('srv_a', key)).toBe(false);
    await service.setEnabled('srv_a', true);
    expect(await service.verify('srv_a', key)).toBe(true);
    await service.clear('srv_a');
    expect(await service.verify('srv_a', key)).toBe(false);
  });
});
