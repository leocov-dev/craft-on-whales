import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Test } from '@nestjs/testing';
import { PathGuardService } from '../storage/path-guard.service';
import { ServerQueryService } from './server-query.service';
import { ServerLifecycleService } from './server-lifecycle.service';
import { ServerPropertiesService } from './server-properties.service';
import type { Server } from './types';

const SERVER_ID = 'srv1';

describe('ServerPropertiesService', () => {
  let root: string;
  let service: ServerPropertiesService;
  let env: Record<string, string>;
  let updateServer: jest.Mock;

  const propsFile = (): string =>
    path.join(root, 'servers', SERVER_ID, 'server.properties');

  const writeFixture = (text: string): void => {
    fs.mkdirSync(path.dirname(propsFile()), { recursive: true });
    fs.writeFileSync(propsFile(), text);
  };

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cow-props-'));
    env = {};
    updateServer = jest
      .fn()
      .mockImplementation((_id, changes: { env?: Record<string, string> }) => {
        if (changes.env) env = { ...changes.env };
        return Promise.resolve({ needsRecreate: true });
      });

    const moduleRef = await Test.createTestingModule({
      providers: [
        ServerPropertiesService,
        {
          provide: PathGuardService,
          useValue: {
            dataPath: (...parts: string[]) => path.join(root, ...parts),
          },
        },
        {
          provide: ServerQueryService,
          useValue: {
            getServer: () =>
              Promise.resolve({ id: SERVER_ID, env } as unknown as Server),
          },
        },
        { provide: ServerLifecycleService, useValue: { updateServer } },
      ],
    }).compile();
    service = moduleRef.get(ServerPropertiesService);
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  describe('read/write', () => {
    it('parses values and ignores comments and blank lines', () => {
      writeFixture(
        '#Minecraft server properties\n\npvp=false\nmotd=Hi there\n',
      );
      const props = service.read(SERVER_ID);
      expect(props.get('pvp')).toBe('false');
      expect(props.get('motd')).toBe('Hi there');
      expect(props.size).toBe(2);
    });

    it('returns an empty map for a server with no file yet', () => {
      expect(service.read(SERVER_ID).size).toBe(0);
    });

    it('replaces an existing key in place and leaves the rest alone', () => {
      writeFixture('#header\npvp=true\nmotd=Hi\n');
      service.write(SERVER_ID, { pvp: 'false' });
      expect(fs.readFileSync(propsFile(), 'utf8')).toBe(
        '#header\npvp=false\nmotd=Hi\n',
      );
    });

    it('appends a key the file does not have, creating the file if needed', () => {
      service.write(SERVER_ID, { difficulty: 'hard' });
      expect(fs.readFileSync(propsFile(), 'utf8')).toBe('difficulty=hard\n');
    });
  });

  describe('setProperty', () => {
    it('clears the env var backing the property so the file wins on restart', async () => {
      env = { PVP: 'true', MEMORY: '4096M' };
      const result = await service.setProperty(SERVER_ID, 'pvp', 'false');
      expect(result.unlocked).toEqual(['PVP']);
      expect(updateServer).toHaveBeenCalledTimes(1);
      expect(env).toEqual({ MEMORY: '4096M' });
    });

    it('does not touch the server row when no env var backs the property', async () => {
      env = { MEMORY: '4096M' };
      const result = await service.setProperty(SERVER_ID, 'pvp', 'false');
      expect(result.unlocked).toEqual([]);
      expect(updateServer).not.toHaveBeenCalled();
    });

    it('never clears a panel-owned env var', async () => {
      env = { RCON_PASSWORD: 'secret' };
      await service.setProperty(SERVER_ID, 'rcon.password', 'other');
      expect(updateServer).not.toHaveBeenCalled();
      expect(env.RCON_PASSWORD).toBe('secret');
    });

    it('unlocks every key of a multi-key patch in a single update', async () => {
      env = { PVP: 'true', DIFFICULTY: 'easy', HARDCORE: 'false' };
      const result = await service.setProperties(SERVER_ID, {
        pvp: 'false',
        difficulty: 'hard',
      });
      expect(result.unlocked.sort()).toEqual(['DIFFICULTY', 'PVP']);
      expect(updateServer).toHaveBeenCalledTimes(1);
      expect(env).toEqual({ HARDCORE: 'false' });
    });

    it('honours unlockEnv:false for callers that set property and env together', async () => {
      env = { SEED: '123' };
      await service.setProperty(SERVER_ID, 'level-seed', '456', {
        unlockEnv: false,
      });
      expect(updateServer).not.toHaveBeenCalled();
      expect(env.SEED).toBe('123');
    });
  });

  describe('preserveEdits', () => {
    it('puts back the keys the game reverted, leaving the excepted key alone', async () => {
      writeFixture('pvp=false\ndifficulty=hard\nwhite-list=false\n');
      await service.preserveEdits(SERVER_ID, ['white-list'], () => {
        // Stand in for Minecraft rewriting the file from its boot-time values.
        fs.writeFileSync(
          propsFile(),
          'pvp=true\ndifficulty=easy\nwhite-list=true\n',
        );
        return Promise.resolve();
      });
      const after = service.read(SERVER_ID);
      expect(after.get('pvp')).toBe('false');
      expect(after.get('difficulty')).toBe('hard');
      expect(after.get('white-list')).toBe('true');
    });

    it('leaves the file untouched when the game rewrote nothing', async () => {
      writeFixture('pvp=false\n');
      await service.preserveEdits(SERVER_ID, ['white-list'], () =>
        Promise.resolve(),
      );
      expect(fs.readFileSync(propsFile(), 'utf8')).toBe('pvp=false\n');
    });

    it('returns the wrapped call result', async () => {
      writeFixture('pvp=false\n');
      await expect(
        service.preserveEdits(SERVER_ID, [], () =>
          Promise.resolve('rcon output'),
        ),
      ).resolves.toBe('rcon output');
    });
  });
});
