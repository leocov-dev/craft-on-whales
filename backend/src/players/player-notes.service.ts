import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { DbService } from '../db/db.service';
import { playerNotes } from '../db/schema';
import { EventsService } from '../events/events.service';
import type { PlayerNote } from '../../../shared/types/players';

const MAX_NOTE_LENGTH = 1000;

/**
 * Sticky moderator notes, one row per note, keyed by (serverId, uuid) — see
 * `db/schema/events.ts`'s `playerNotes` table. Split out from
 * `PlayerRosterService` because notes are plain DB-row CRUD with no RCON or
 * file-edit concern, unlike everything else in that service. Gated in
 * `PlayersController` behind the `players` capability, same as ban/kick/op —
 * a `viewer` (whose role default is `['view']` only) can see the roster but
 * not moderator notes. See PLAYERS_NOTES.md.
 */
@Injectable()
export class PlayerNotesService {
  constructor(
    private readonly dbService: DbService,
    private readonly events: EventsService,
  ) {}

  private get db() {
    return this.dbService.db;
  }

  async listNotes(serverId: string, uuid: string): Promise<PlayerNote[]> {
    const rows = await this.db
      .select()
      .from(playerNotes)
      .where(
        and(eq(playerNotes.serverId, serverId), eq(playerNotes.uuid, uuid)),
      )
      .orderBy(desc(playerNotes.createdAt), desc(playerNotes.id));
    return rows.map((r) => ({
      id: r.id,
      uuid: r.uuid,
      name: r.name,
      note: r.note,
      author: r.author,
      createdAt: r.createdAt,
    }));
  }

  async addNote(
    serverId: string,
    who: { uuid: string; name: string },
    noteInput: unknown,
    { actor = 'system' }: { actor?: string } = {},
  ): Promise<PlayerNote> {
    const note = (typeof noteInput === 'string' ? noteInput : '').trim();
    if (!note) throw new BadRequestException('Note cannot be empty');
    if (note.length > MAX_NOTE_LENGTH) {
      throw new BadRequestException(
        `Note is too long (max ${MAX_NOTE_LENGTH} characters)`,
      );
    }
    const id = `pnote_${nanoid(10)}`;
    await this.db.insert(playerNotes).values({
      id,
      serverId,
      uuid: who.uuid,
      name: who.name,
      note,
      author: actor,
    });
    this.events.recordEvent({
      serverId,
      actor,
      type: 'player-note-added',
      summary: `Note added for ${who.name}`,
      details: { name: who.name, uuid: who.uuid },
    });
    const [row] = await this.db
      .select()
      .from(playerNotes)
      .where(eq(playerNotes.id, id))
      .limit(1);
    return {
      id: row!.id,
      uuid: row!.uuid,
      name: row!.name,
      note: row!.note,
      author: row!.author,
      createdAt: row!.createdAt,
    };
  }

  async deleteNote(
    serverId: string,
    id: string,
    { actor = 'system' }: { actor?: string } = {},
  ): Promise<void> {
    const [row] = await this.db
      .select()
      .from(playerNotes)
      .where(and(eq(playerNotes.id, id), eq(playerNotes.serverId, serverId)))
      .limit(1);
    if (!row) throw new NotFoundException('Note not found');
    await this.db.delete(playerNotes).where(eq(playerNotes.id, id));
    this.events.recordEvent({
      serverId,
      actor,
      type: 'player-note-deleted',
      summary: `Note removed for ${row.name}`,
      details: { name: row.name, uuid: row.uuid },
    });
  }

  /** Remove every note for a player (used when their whole record is deleted). Returns count removed. */
  async deletePlayerNotes(serverId: string, uuid: string): Promise<number> {
    const rows = await this.db
      .delete(playerNotes)
      .where(
        and(eq(playerNotes.serverId, serverId), eq(playerNotes.uuid, uuid)),
      )
      .returning({ id: playerNotes.id });
    return rows.length;
  }
}
