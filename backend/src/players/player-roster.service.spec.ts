import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { Test } from '@nestjs/testing';
import { ConflictException } from '@nestjs/common';
import { DbService } from '../db/db.service';
import { EventsService } from '../events/events.service';
import { ContainerService } from '../docker/container.service';
import { PathGuardService } from '../storage/path-guard.service';
import { ServerPropertiesService } from '../servers/server-properties.service';
import { MojangProfilesService } from './mojang-profiles.service';
import { PlayerNotesService } from './player-notes.service';
import { PlayerDataFileService } from '../inventory/player-data-file.service';
import { PlayerRosterService } from './player-roster.service';

// Docker-free: a real in-memory SQLite DB built from the checked-in migration
// SQL (players_notes + player_events live there — same pattern as
// worlds/backups.service.spec.ts), a real temp data dir for the vanilla JSON
// role files, and stubs for RCON/Docker/Mojang.

const MIGRATIONS_DIR = path.resolve(__dirname, '..', '..', 'drizzle');

const migrationFiles = (): string[] =>
  fs
    .readdirSync(MIGRATIONS_DIR)
    .sort()
    .map((dir) => path.join(MIGRATIONS_DIR, dir, 'migration.sql'))
    .filter((f) => fs.existsSync(f));

const SERVER_ID = 'srv_players_test';
const ALICE_UUID = '3f5f7c2a-8a4e-4a1a-9c1b-000000000001';

describe('PlayerRosterService', () => {
  let sqlite: DatabaseSync;
  let db: ReturnType<typeof drizzle>;
  let root: string;
  let service: PlayerRosterService;
  let notesService: PlayerNotesService;
  let execCapture: jest.Mock;
  let playerdataDir: string;

  const serverPath = (...parts: string[]) =>
    path.join(root, 'servers', SERVER_ID, ...parts);

  const writeRoleFile = (file: string, value: unknown[]): void => {
    fs.mkdirSync(serverPath(), { recursive: true });
    fs.writeFileSync(serverPath(file), JSON.stringify(value, null, 2));
  };
  const readRoleFile = (file: string): Array<Record<string, unknown>> =>
    JSON.parse(fs.readFileSync(serverPath(file), 'utf8')) as Array<
      Record<string, unknown>
    >;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cow-players-'));
    playerdataDir = path.join(
      root,
      'servers',
      SERVER_ID,
      'world',
      'players',
      'data',
    );
    fs.mkdirSync(playerdataDir, { recursive: true });

    sqlite = new DatabaseSync(':memory:');
    sqlite.exec('PRAGMA foreign_keys = ON');
    for (const file of migrationFiles()) {
      for (const stmt of fs
        .readFileSync(file, 'utf8')
        .split('--> statement-breakpoint')) {
        if (stmt.trim()) sqlite.exec(stmt);
      }
    }
    db = drizzle({ client: sqlite });
    execCapture = jest.fn().mockResolvedValue('');

    writeRoleFile('usercache.json', [
      { name: 'Alice', uuid: ALICE_UUID, expiresOn: '2027-01-01' },
    ]);
    writeRoleFile('whitelist.json', [{ name: 'Alice', uuid: ALICE_UUID }]);
    writeRoleFile('ops.json', []);
    writeRoleFile('banned-players.json', []);
    writeRoleFile('banned-ips.json', []);

    const moduleRef = await Test.createTestingModule({
      providers: [
        PlayerRosterService,
        PlayerNotesService,
        { provide: DbService, useValue: { db } },
        { provide: EventsService, useValue: { recordEvent: jest.fn() } },
        { provide: ContainerService, useValue: { execCapture } },
        { provide: MojangProfilesService, useValue: {} },
        { provide: ServerPropertiesService, useValue: {} },
        {
          provide: PathGuardService,
          useValue: {
            dataPath: (...parts: string[]) => path.join(root, ...parts),
          },
        },
        {
          provide: PlayerDataFileService,
          useValue: { playerdataDir: () => Promise.resolve(playerdataDir) },
        },
      ],
    }).compile();
    service = moduleRef.get(PlayerRosterService);
    notesService = moduleRef.get(PlayerNotesService);
  });

  afterEach(() => {
    sqlite.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  describe('temporary bans', () => {
    it('banPlayer with durationMs writes a real expiry and listPlayers reports it', async () => {
      const res = await service.banPlayer(SERVER_ID, 'Alice', 'test ban', {
        running: false,
        durationMs: 3600_000,
      });
      expect(res.banExpires).not.toBeNull();

      const entries = readRoleFile('banned-players.json');
      expect(entries).toHaveLength(1);
      expect(entries[0]?.expires).toBe(res.banExpires);

      const list = service.listPlayers(SERVER_ID);
      const alice = list.find((p) => p.name === 'Alice');
      expect(alice?.banned).toBe(true);
      expect(alice?.banExpires).toBe(res.banExpires);
    });

    it('listPlayers lazily treats an expired ban as pardoned without touching the file', async () => {
      // Ban already expired 1ms ago.
      await service.banPlayer(SERVER_ID, 'Alice', 'test ban', {
        running: false,
        durationMs: -1,
      });
      // The file entry is still there (no sweep) …
      expect(readRoleFile('banned-players.json')).toHaveLength(1);
      // … but every read treats it as no longer banned.
      const alice = service
        .listPlayers(SERVER_ID)
        .find((p) => p.name === 'Alice');
      expect(alice?.banned).toBe(false);
      expect(alice?.banExpires).toBeNull();
    });

    it('banPlayer with no durationMs bans permanently (banExpires null)', async () => {
      const res = await service.banPlayer(SERVER_ID, 'Alice', 'perma', {
        running: false,
      });
      expect(res.banExpires).toBeNull();
      const alice = service
        .listPlayers(SERVER_ID)
        .find((p) => p.name === 'Alice');
      expect(alice?.banned).toBe(true);
      expect(alice?.banExpires).toBeNull();
    });
  });

  describe('IP-ban linkage', () => {
    it('banIp tags the entry with the linked player and listBannedIps surfaces it', async () => {
      const res = await service.banIp(SERVER_ID, '203.0.113.5', 'griefing', {
        running: false,
        player: 'Alice',
      });
      expect(res.player).toBe('Alice');
      const ips = service.listBannedIps(SERVER_ID);
      expect(ips).toHaveLength(1);
      expect(ips[0]?.player).toBe('Alice');
    });
  });

  describe('moderator notes', () => {
    it('addNote/listNotes/deleteNote round-trip', async () => {
      const note = await notesService.addNote(
        SERVER_ID,
        { uuid: ALICE_UUID, name: 'Alice' },
        'reported for griefing',
        { actor: 'op1' },
      );
      expect(note.note).toBe('reported for griefing');

      const listed = await notesService.listNotes(SERVER_ID, ALICE_UUID);
      expect(listed).toHaveLength(1);

      await notesService.deleteNote(SERVER_ID, note.id, { actor: 'op1' });
      expect(await notesService.listNotes(SERVER_ID, ALICE_UUID)).toHaveLength(
        0,
      );
    });

    it('rejects an empty note', async () => {
      await expect(
        notesService.addNote(
          SERVER_ID,
          { uuid: ALICE_UUID, name: 'Alice' },
          '   ',
        ),
      ).rejects.toThrow('Note cannot be empty');
    });
  });

  describe('deletePlayer', () => {
    it('refuses while the player is online', async () => {
      execCapture.mockResolvedValue(
        'There are 1 of a max of 20 players online: Alice\n',
      );
      await expect(
        service.deletePlayer(SERVER_ID, 'Alice', { running: true }),
      ).rejects.toThrow(ConflictException);
      // Nothing touched.
      expect(readRoleFile('whitelist.json')).toHaveLength(1);
    });

    it('wipes role files, playerdata, and notes when offline', async () => {
      fs.writeFileSync(path.join(playerdataDir, `${ALICE_UUID}.dat`), 'x');
      fs.mkdirSync(
        path.join(root, 'logs', SERVER_ID, 'inventories', ALICE_UUID),
        {
          recursive: true,
        },
      );
      await notesService.addNote(
        SERVER_ID,
        { uuid: ALICE_UUID, name: 'Alice' },
        'note 1',
      );

      const res = await service.deletePlayer(SERVER_ID, 'Alice', {
        running: false,
      });
      expect(res.uuid).toBe(ALICE_UUID);
      expect(res.removed.playerdata).toBe(1);
      expect(res.removed.snapshots).toBe(true);
      expect(res.removed.notes).toBe(1);

      expect(readRoleFile('usercache.json')).toHaveLength(0);
      expect(readRoleFile('whitelist.json')).toHaveLength(0);
      expect(fs.existsSync(path.join(playerdataDir, `${ALICE_UUID}.dat`))).toBe(
        false,
      );
      expect(
        fs.existsSync(
          path.join(root, 'logs', SERVER_ID, 'inventories', ALICE_UUID),
        ),
      ).toBe(false);
      expect(await notesService.listNotes(SERVER_ID, ALICE_UUID)).toHaveLength(
        0,
      );
    });

    it('rejects an invalid player name', async () => {
      await expect(
        service.deletePlayer(SERVER_ID, 'bad name!', { running: false }),
      ).rejects.toThrow();
    });
  });

  describe('getLastKnownIp', () => {
    it('returns null when nothing was ever captured', async () => {
      expect(await service.getLastKnownIp(SERVER_ID, 'Alice')).toBeNull();
    });

    it('returns the most recent captured join IP', async () => {
      sqlite
        .prepare(
          `INSERT INTO player_events (server_id, ts, type, player, target) VALUES (?, ?, 'join', ?, ?)`,
        )
        .run(SERVER_ID, '2026-01-01 00:00:00', 'Alice', '203.0.113.1');
      sqlite
        .prepare(
          `INSERT INTO player_events (server_id, ts, type, player, target) VALUES (?, ?, 'join', ?, ?)`,
        )
        .run(SERVER_ID, '2026-01-02 00:00:00', 'Alice', '203.0.113.2');
      expect(await service.getLastKnownIp(SERVER_ID, 'Alice')).toBe(
        '203.0.113.2',
      );
    });
  });
});
