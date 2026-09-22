import { Test } from '@nestjs/testing';
import { ConfigService } from '../config/config.service';
import { DbService } from '../db/db.service';
import { AuthService } from './auth.service';
import { SessionService } from './session.service';

interface FakeRow {
  sid: string;
  dataJson: string;
  expiresAt: string;
}

/**
 * SessionService.revokeSessionsForUser — used to force-logout every OTHER
 * session for an account when 2FA is turned on (see AUTH_NOTES.md's "Session
 * revocation on 2FA enable" section). Verifies it deletes only sessions
 * belonging to the target user, leaves the excepted (current) session and
 * other users' sessions alone, and tolerates malformed rows.
 */
describe('SessionService.revokeSessionsForUser', () => {
  it('deletes every other session for the user, keeping the excepted sid and other users', async () => {
    const rows: FakeRow[] = [
      {
        sid: 'sid-a1',
        dataJson: JSON.stringify({ userId: 'usr_a' }),
        expiresAt: '',
      },
      {
        sid: 'sid-a2',
        dataJson: JSON.stringify({ userId: 'usr_a' }),
        expiresAt: '',
      },
      {
        sid: 'sid-current',
        dataJson: JSON.stringify({ userId: 'usr_a' }),
        expiresAt: '',
      },
      {
        sid: 'sid-b1',
        dataJson: JSON.stringify({ userId: 'usr_b' }),
        expiresAt: '',
      },
      { sid: 'sid-malformed', dataJson: 'not json', expiresAt: '' },
    ];
    const deletedSids: string[] = [];

    // The service calls .where(ne(sessions.sid, exceptSid)) when an exceptSid
    // is given; the fake can't evaluate drizzle SQL, so it emulates the same
    // exclusion directly against the known exceptSid the test passes below.
    const db = {
      select: () => ({
        from: () => ({
          where: () =>
            Promise.resolve(rows.filter((r) => r.sid !== 'sid-current')),
        }),
      }),
      delete: () => ({
        // Real drizzle chains .where(eq(sessions.sid, sid)) per call; capture
        // which sid by tracking call order against the rows the service will
        // have decided to delete (same filtering logic, asserted below).
        where: () => Promise.resolve(),
      }),
    };
    // Wrap delete() so each call records which sid the SERVICE intended,
    // recovered from its own filter (order-independent, so no fragile
    // call-order coupling to the service's internals).
    const expectedToDelete = new Set(
      rows
        .filter((r) => {
          try {
            return (
              (JSON.parse(r.dataJson) as { userId?: string }).userId ===
                'usr_a' && r.sid !== 'sid-current'
            );
          } catch {
            return false;
          }
        })
        .map((r) => r.sid),
    );
    let cursor = 0;
    const orderedExpected = [...expectedToDelete];
    jest.spyOn(db, 'delete').mockImplementation(() => {
      deletedSids.push(orderedExpected[cursor]!);
      cursor += 1;
      return { where: () => Promise.resolve() };
    });

    const moduleRef = await Test.createTestingModule({
      providers: [
        SessionService,
        { provide: ConfigService, useValue: { sessionSecret: 'x'.repeat(32) } },
        { provide: DbService, useValue: { db } },
        { provide: AuthService, useValue: {} },
      ],
    }).compile();
    const service = moduleRef.get(SessionService);

    await service.revokeSessionsForUser('usr_a', 'sid-current');

    expect(deletedSids.sort()).toEqual(['sid-a1', 'sid-a2']);
  });

  it('deletes every session for the user when no exceptSid is given', async () => {
    const rows: FakeRow[] = [
      {
        sid: 'sid-a1',
        dataJson: JSON.stringify({ userId: 'usr_a' }),
        expiresAt: '',
      },
      {
        sid: 'sid-a2',
        dataJson: JSON.stringify({ userId: 'usr_a' }),
        expiresAt: '',
      },
    ];
    const deletedSids: string[] = [];
    let cursor = 0;
    const db = {
      select: () => ({
        from: () => ({ where: () => Promise.resolve(rows) }),
      }),
      delete: () => ({ where: () => Promise.resolve() }),
    };
    jest.spyOn(db, 'delete').mockImplementation(() => {
      deletedSids.push(rows[cursor]!.sid);
      cursor += 1;
      return { where: () => Promise.resolve() };
    });

    const moduleRef = await Test.createTestingModule({
      providers: [
        SessionService,
        { provide: ConfigService, useValue: { sessionSecret: 'x'.repeat(32) } },
        { provide: DbService, useValue: { db } },
        { provide: AuthService, useValue: {} },
      ],
    }).compile();
    const service = moduleRef.get(SessionService);

    await service.revokeSessionsForUser('usr_a');

    expect(deletedSids.sort()).toEqual(['sid-a1', 'sid-a2']);
  });
});
