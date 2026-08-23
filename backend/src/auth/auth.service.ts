import { ConflictException, Injectable, NotFoundException, UnauthorizedException, BadRequestException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { nanoid } from 'nanoid';
import { asc, eq, sql } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { users } from '../db/schema';
import { EventsService } from '../events/events.service';
import { TotpService } from './totp.service';
import { SecretsService } from './secrets.service';
import type { Role } from '../../../shared/types/auth';
import type { PublicUser } from '../../../shared/types/settings';

export type { Role, PublicUser };

type UserRow = typeof users.$inferSelect;

/**
 * Users + credentials. bcryptjs hashes; roles admin/operator/viewer. Also
 * owns the TOTP enrollment/verification flow (composes TotpService for the
 * RFC 6238 math and SecretsService for at-rest encryption of the secret).
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly dbService: DbService,
    private readonly events: EventsService,
    private readonly totp: TotpService,
    private readonly secrets: SecretsService
  ) {}

  private get db() {
    return this.dbService.db;
  }

  async firstRunNeeded(): Promise<boolean> {
    const [row] = await this.db.select({ x: sql`1` }).from(users).limit(1);
    return !row;
  }

  async createUser(
    { username, password, role = 'admin' }: { username: string; password: string; role?: Role },
    { actor = 'system' }: { actor?: string } = {}
  ): Promise<PublicUser | null> {
    if (!/^[a-zA-Z0-9_.-]{2,32}$/.test(username)) throw new BadRequestException('Username: 2–32 letters, numbers, _ . -');
    if (typeof password !== 'string' || password.length < 8) throw new BadRequestException('Password must be at least 8 characters');
    const [existing] = await this.db.select({ x: sql`1` }).from(users).where(eq(users.username, username)).limit(1);
    if (existing) {
      throw new ConflictException('Username already exists');
    }
    const id = `usr_${nanoid(8)}`;
    await this.db.insert(users).values({ id, username, passwordHash: bcrypt.hashSync(password, 11), role });
    this.events.recordEvent({ actor, type: 'user-created', summary: `User created: ${username} (${role})` });
    return this.getUser(id);
  }

  async verifyCredentials(username: string, password: string): Promise<PublicUser | null> {
    const [user] = await this.db.select().from(users).where(eq(users.username, username)).limit(1);
    if (!user) {
      bcrypt.compareSync(password, '$2a$11$invalidsaltinvalidsaltinvalidsaltuFakeHash1234567890ab'); // constant-time-ish
      return null;
    }
    return bcrypt.compareSync(password, user.passwordHash) ? this.publicUser(user) : null;
  }

  async getUser(id: string): Promise<PublicUser | null> {
    const [user] = await this.db.select().from(users).where(eq(users.id, id)).limit(1);
    return user ? this.publicUser(user) : null;
  }

  async listUsers(): Promise<PublicUser[]> {
    const rows = await this.db.select().from(users).orderBy(asc(users.createdAt));
    return rows.map((u) => this.publicUser(u));
  }

  async setPassword(id: string, password: string, { actor = 'system' }: { actor?: string } = {}): Promise<void> {
    if (typeof password !== 'string' || password.length < 8) throw new BadRequestException('Password must be at least 8 characters');
    await this.db.update(users).set({ passwordHash: bcrypt.hashSync(password, 11) }).where(eq(users.id, id));
    const user = await this.getUser(id);
    this.events.recordEvent({ actor, type: 'user-password-changed', summary: `Password changed for ${user?.username}` });
  }

  async setRole(id: string, role: Role, { actor = 'system' }: { actor?: string } = {}): Promise<void> {
    if (!['admin', 'operator', 'viewer'].includes(role)) throw new BadRequestException('Invalid role');
    const adminCountRows = await this.db.select({ n: sql<number>`count(*)` }).from(users).where(eq(users.role, 'admin'));
    const admins = adminCountRows[0]!.n;
    const [user] = await this.db.select().from(users).where(eq(users.id, id)).limit(1);
    if (user && user.role === 'admin' && role !== 'admin' && admins <= 1) {
      throw new ConflictException('Cannot demote the last admin');
    }
    await this.db.update(users).set({ role }).where(eq(users.id, id));
    this.events.recordEvent({ actor, type: 'user-role-changed', summary: `${user?.username} role → ${role}` });
  }

  async deleteUser(id: string, { actor = 'system' }: { actor?: string } = {}): Promise<void> {
    const [user] = await this.db.select().from(users).where(eq(users.id, id)).limit(1);
    if (!user) return;
    if (user.role === 'admin') {
      const adminCountRows = await this.db.select({ n: sql<number>`count(*)` }).from(users).where(eq(users.role, 'admin'));
      if (adminCountRows[0]!.n <= 1) throw new ConflictException('Cannot delete the last admin');
    }
    await this.db.delete(users).where(eq(users.id, id));
    this.events.recordEvent({ actor, type: 'user-deleted', summary: `User deleted: ${user.username}` });
  }

  private publicUser(u: UserRow): PublicUser {
    return { id: u.id, username: u.username, role: u.role as Role, createdAt: u.createdAt, totpEnabled: u.totpEnabled };
  }

  // ---------------------------------------------------------------------
  // TOTP two-factor auth. Self-service (any role, acts on your own account),
  // plus one admin recovery path. The secret is only ever written once a
  // live code from it has been verified (confirmTotp), so a setup a user
  // never finishes leaves nothing persisted.

  /** Start enrollment: a fresh secret + otpauth URL, NOT persisted until confirmTotp(). */
  async beginTotpEnrollment(id: string): Promise<{ secret: string; otpauthUrl: string }> {
    const [user] = await this.db.select({ username: users.username }).from(users).where(eq(users.id, id)).limit(1);
    if (!user) throw new NotFoundException('User not found');
    const secret = this.totp.generateSecret();
    return { secret, otpauthUrl: this.totp.buildOtpauthUrl(secret, { account: user.username }) };
  }

  /** Verify the account password + the first live code, then persist the secret + backup codes. */
  async confirmTotp(id: string, secret: string, code: string, password: string, { actor = 'system' }: { actor?: string } = {}): Promise<{ backupCodes: string[] }> {
    const [user] = await this.db.select().from(users).where(eq(users.id, id)).limit(1);
    if (!user) throw new NotFoundException('User not found');
    if (user.totpEnabled) {
      throw new ConflictException('Two-factor authentication is already enabled — disable it first to re-enroll.');
    }
    // Re-check the account's own password before ENABLING 2FA, exactly as disable
    // and regenerate do. Without it, a hijacked-but-unlocked session (no password
    // needed) could enroll the attacker's OWN authenticator on an account with no
    // 2FA yet — locking the real owner out on their next login until an admin
    // force-reset. The UI always sends the password; the API must not rely on that.
    // Checked before the code so it can't double as a code-verification oracle.
    if (!bcrypt.compareSync(password, user.passwordHash)) throw new UnauthorizedException('Wrong password');
    if (this.totp.verify(secret, code) == null) {
      throw new BadRequestException('That code is incorrect or expired — try the next one your app shows.');
    }
    const backupCodes = this.totp.generateBackupCodes();
    const hashed = backupCodes.map((c) => bcrypt.hashSync(c, 11));
    // totp_last_step deliberately stays NULL here rather than recording this
    // confirmation code's step: replay protection exists to stop a *login* code
    // being reused, not to block the very first login from landing in the same
    // 30s window as enrollment (a real code shown on-screen doesn't change until
    // the window rolls over, so that first login legitimately reuses it).
    await this.db
      .update(users)
      .set({ totpSecret: this.secrets.encrypt(secret), totpEnabled: true, totpBackupCodesJson: JSON.stringify(hashed) })
      .where(eq(users.id, id));
    this.events.recordEvent({ actor, type: 'user-2fa-enabled', summary: `Two-factor authentication enabled for ${user.username}` });
    return { backupCodes };
  }

  /** Self-service disable — re-checks the account's own current password first. */
  async disableTotp(id: string, password: string, { actor = 'system' }: { actor?: string } = {}): Promise<void> {
    const [user] = await this.db.select().from(users).where(eq(users.id, id)).limit(1);
    if (!user) throw new NotFoundException('User not found');
    if (!bcrypt.compareSync(password, user.passwordHash)) throw new UnauthorizedException('Wrong password');
    await this.db
      .update(users)
      .set({ totpSecret: null, totpEnabled: false, totpBackupCodesJson: null, totpLastStep: null })
      .where(eq(users.id, id));
    this.events.recordEvent({ actor, type: 'user-2fa-disabled', summary: `Two-factor authentication disabled for ${user.username}` });
  }

  /** Admin recovery path: force-disable another user's 2FA (lost phone + backup codes). */
  async adminDisableTotp(id: string, { actor = 'system' }: { actor?: string } = {}): Promise<void> {
    const [user] = await this.db.select({ username: users.username, totpEnabled: users.totpEnabled }).from(users).where(eq(users.id, id)).limit(1);
    if (!user) throw new NotFoundException('User not found');
    if (!user.totpEnabled) return;
    await this.db
      .update(users)
      .set({ totpSecret: null, totpEnabled: false, totpBackupCodesJson: null, totpLastStep: null })
      .where(eq(users.id, id));
    this.events.recordEvent({ actor, type: 'user-2fa-disabled', summary: `Two-factor authentication reset for ${user.username} by an admin` });
  }

  /** Re-check the password, then reissue backup codes (old ones stop working). */
  async regenerateBackupCodes(id: string, password: string, { actor = 'system' }: { actor?: string } = {}): Promise<{ backupCodes: string[] }> {
    const [user] = await this.db.select().from(users).where(eq(users.id, id)).limit(1);
    if (!user) throw new NotFoundException('User not found');
    if (!user.totpEnabled) throw new BadRequestException('Two-factor authentication is not enabled');
    if (!bcrypt.compareSync(password, user.passwordHash)) throw new UnauthorizedException('Wrong password');
    const backupCodes = this.totp.generateBackupCodes();
    const hashed = backupCodes.map((c) => bcrypt.hashSync(c, 11));
    await this.db.update(users).set({ totpBackupCodesJson: JSON.stringify(hashed) }).where(eq(users.id, id));
    this.events.recordEvent({ actor, type: 'user-2fa-backup-codes', summary: `Backup codes regenerated for ${user.username}` });
    return { backupCodes };
  }

  /**
   * Verify a login-time TOTP or backup code for `id` (the pendingTotpUserId
   * from the first login step). Returns true/false; never throws on a bad
   * code (the caller handles lockout/messaging same as a wrong password).
   */
  async verifyTotpLogin(id: string, code: string): Promise<boolean> {
    const [user] = await this.db.select().from(users).where(eq(users.id, id)).limit(1);
    if (!user || !user.totpEnabled || !user.totpSecret) return false;

    const secret = this.secrets.tryDecrypt(user.totpSecret);
    if (secret) {
      const step = this.totp.verify(secret, code, { lastStep: user.totpLastStep });
      if (step != null) {
        await this.db.update(users).set({ totpLastStep: step }).where(eq(users.id, id));
        return true;
      }
    }

    // Fall back to a backup code — single use, removed once matched.
    let codes: string[] = [];
    try {
      codes = JSON.parse(user.totpBackupCodesJson || '[]');
    } catch {
      codes = [];
    }
    const cleanCode = String(code || '').trim();
    const idx = codes.findIndex((hash) => bcrypt.compareSync(cleanCode, hash));
    if (idx === -1) return false;
    codes.splice(idx, 1);
    await this.db.update(users).set({ totpBackupCodesJson: JSON.stringify(codes) }).where(eq(users.id, id));
    this.events.recordEvent({
      actor: user.username,
      type: 'user-2fa-backup-used',
      summary: `${user.username} signed in with a backup code (${codes.length} left)`,
    });
    return true;
  }
}
