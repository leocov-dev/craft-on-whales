import {
  BadRequestException,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import * as fs from 'node:fs';
import * as path from 'node:path';
// qrcode ships no types of its own and none exist for it — matching the
// legacy code's own untyped require() for this package (same reasoning as
// archiver elsewhere in this backend).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const QRCode = require('qrcode');
import { z, ZodError } from 'zod';
import { ConfigService } from '../config/config.service';
import { EventsService } from '../events/events.service';
import { DockerConnectionService } from '../docker/docker-connection.service';
import { AuthService } from './auth.service';
import { LoginRateLimitService } from './login-rate-limit.service';
import { Public } from './public.decorator';
import { AllowViewerWrite } from './allow-viewer-write.decorator';
import type { SessionUser, SetupChecks } from '../../../shared/types/auth';

const loginSchema = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(200),
  next: z.string().max(300).optional(),
});
const setupSchema = z.object({
  username: z.string().trim().min(2).max(32),
  password: z.string().min(8).max(200),
});
const totpCodeSchema = z.object({ code: z.string().trim().min(1).max(64) });
const confirmTotpSchema = z.object({
  secret: z.string().min(16).max(64),
  code: z.string().trim().min(1).max(16),
  password: z.string().min(1).max(200),
});
const passwordSchema = z.object({ password: z.string().min(1).max(200) });

// /account/totp/setup mints a fresh secret and rasters a QR on every call,
// persisting nothing — so throttle it per account. Without a cap, any
// authenticated session (a read-only viewer included) could loop it to pin
// the event loop on a small self-hosted box.
const SETUP_WINDOW_MS = 60_000;
const SETUP_MAX = 20;

/**
 * First-run setup, login (+ 2FA), logout, and the SPA's session check.
 * JSON-only — ports the API-response branch of legacy
 * `src/web/routes/auth.ts` (the Handlebars page-render branch has no
 * equivalent now that the Vue frontend owns page rendering).
 */
@Controller()
export class AuthController {
  private readonly setupHits = new Map<string, number[]>(); // userId -> timestamps (ms) within the window

  constructor(
    private readonly authService: AuthService,
    private readonly events: EventsService,
    private readonly config: ConfigService,
    private readonly rateLimit: LoginRateLimitService,
    private readonly docker: DockerConnectionService,
  ) {}

  private throttleSetup(userId: string, nowMs: number): boolean {
    const recent = (this.setupHits.get(userId) || []).filter(
      (t) => nowMs - t < SETUP_WINDOW_MS,
    );
    recent.push(nowMs);
    this.setupHits.set(userId, recent);
    return recent.length <= SETUP_MAX;
  }

  /**
   * First-run environment checks for the onboarding wizard. Levels: 'pass'
   * (green), 'warn' (amber, can proceed), 'fail' (red, something is broken).
   * Booleans only for the secret — the value never leaves.
   */
  @Public()
  @Get('setup/checks')
  async setupChecks(): Promise<{ ok: true; checks: SetupChecks }> {
    if (!(await this.authService.firstRunNeeded()))
      throw new BadRequestException('Setup already complete');
    const docker = await this.docker.checkDocker();

    const maj = Number(process.versions.node.split('.')[0]);
    const nodeOk = maj >= 24;

    let dataWritable = false;
    try {
      const probe = path.join(this.config.dataDir, `.wtest-${process.pid}`);
      fs.writeFileSync(probe, 'ok');
      fs.rmSync(probe, { force: true });
      dataWritable = true;
    } catch {
      dataWritable = false;
    }

    const secretSet = Boolean(this.config.sessionSecret);
    const secretStrong =
      secretSet &&
      this.config.sessionSecret.length >= 16 &&
      !/^change-me/i.test(this.config.sessionSecret);

    return {
      ok: true,
      checks: {
        docker: {
          level: docker.available ? 'pass' : 'warn', // panel works without Docker; lifecycle features just wait
          available: docker.available,
          version: docker.version,
          os: docker.os,
          ncpu: docker.ncpu,
          memTotal: docker.memTotal,
          installed: docker.installed,
          isDockerDesktop: docker.isDockerDesktop,
          error: docker.error,
        },
        node: {
          level: nodeOk ? 'pass' : 'warn',
          version: process.versions.node,
          required: '24.0.0',
        },
        dataDir: {
          level: dataWritable ? 'pass' : 'fail',
          path: this.config.dataDir,
        },
        sessionSecret: {
          level: secretStrong ? 'pass' : 'warn',
          set: secretSet,
          weak: secretSet && !secretStrong,
        },
      },
    };
  }

  @Public()
  @Post('setup')
  async setup(@Req() req: Request, @Res() res: Response) {
    if (!(await this.authService.firstRunNeeded()))
      throw new BadRequestException('Setup already complete');
    const { username, password } = parseBody(setupSchema, req.body);
    // createUser only returns null when role/username conflicts are pre-checked
    // elsewhere; firstRunNeeded() above guarantees a fresh admin account here.
    const user = (await this.authService.createUser(
      { username, password, role: 'admin' },
      { actor: 'setup' },
    ))!;
    // Rotate the session id on privilege establishment (anti-fixation), matching login.
    req.session.regenerate((err) => {
      if (err)
        return res
          .status(500)
          .json({ ok: false, error: 'Session error — try again.' });
      req.session.userId = user.id;
      this.events.recordEvent({
        actor: username,
        type: 'login',
        summary: `First admin account created and signed in: ${username}`,
      });
      res.json({ ok: true, user: { username: user.username } });
    });
  }

  @Public()
  @Post('login')
  async login(@Req() req: Request, @Res() res: Response) {
    if (await this.authService.firstRunNeeded())
      throw new BadRequestException('Panel setup incomplete');
    if (req.session?.userId) return res.json({ ok: true, totpRequired: false });

    const { username, password, next } = parseBody(loginSchema, req.body);
    this.rateLimit.checkLoginAllowed(username, req.ip);
    const user = await this.authService.verifyCredentials(username, password);
    if (!user) {
      this.rateLimit.recordLoginFailure(username, req.ip);
      throw new UnauthorizedException('Wrong username or password.');
    }
    if (user.totpEnabled) {
      // Password alone does not authenticate — session.userId stays unset, so
      // SessionAuthGuard still treats this session as signed out. Deliberately
      // does NOT clear the login-failure counter yet: it stays shared with the
      // 2FA code step below, so a correct password can't be used to reset the
      // lockout right before brute-forcing the 6-digit code.
      req.session.pendingTotpUserId = user.id;
      req.session.pendingTotpUsername = user.username;
      req.session.pendingTotpNext = safeNext(next);
      return res.json({ ok: true, totpRequired: true });
    }
    this.rateLimit.clearLoginFailures(username, req.ip);
    req.session.regenerate((err) => {
      if (err)
        return res
          .status(500)
          .json({ ok: false, error: 'Session error — try again.' });
      req.session.userId = user.id;
      this.events.recordEvent({
        actor: user.username,
        type: 'login',
        summary: `${user.username} signed in`,
      });
      res.json({ ok: true, totpRequired: false });
    });
  }

  @Public()
  @Post('login/2fa')
  async loginTotp(@Req() req: Request, @Res() res: Response) {
    const pendingId = req.session?.pendingTotpUserId;
    const pendingUsername = req.session?.pendingTotpUsername;
    if (!pendingId) throw new UnauthorizedException('No pending sign-in.');

    const { code } = parseBody(totpCodeSchema, req.body);
    this.rateLimit.checkLoginAllowed(pendingUsername, req.ip);
    const ok = await this.authService.verifyTotpLogin(pendingId, code);
    if (!ok) {
      this.rateLimit.recordLoginFailure(pendingUsername, req.ip);
      throw new UnauthorizedException('Incorrect code.');
    }
    this.rateLimit.clearLoginFailures(pendingUsername, req.ip);
    delete req.session.pendingTotpUserId;
    delete req.session.pendingTotpUsername;
    delete req.session.pendingTotpNext;
    req.session.regenerate((err) => {
      if (err)
        return res
          .status(500)
          .json({ ok: false, error: 'Session error — try again.' });
      req.session.userId = pendingId;
      this.events.recordEvent({
        actor: pendingUsername,
        type: 'login',
        summary: `${pendingUsername} signed in (2FA)`,
      });
      res.json({ ok: true });
    });
  }

  @Public()
  @Post('logout')
  logout(@Req() req: Request, @Res() res: Response) {
    const name = req.user ? req.user.username : 'unknown';
    req.session.destroy(() => {
      this.events.recordEvent({
        actor: name,
        type: 'logout',
        summary: `${name} signed out`,
      });
      res.json({ ok: true });
    });
  }

  // requireAuth (SessionAuthGuard, applied globally) already 401s unauthenticated
  // requests, so a successful response here always has req.user populated.
  @Get('api/session')
  session(@Req() req: Request): { ok: true; user: SessionUser } {
    const user = req.user!;
    return {
      ok: true,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        totpEnabled: user.totpEnabled,
      },
    };
  }

  // -------------------------------------------------------------------
  // Self-service account security (2FA). Every role, including viewer, may
  // act on their OWN account here — legacy exempted these by mounting
  // /api/account before the requireWrite middleware; @AllowViewerWrite()
  // is the Nest-guard equivalent of that mount-order trick.

  @AllowViewerWrite()
  @Post('api/account/totp/setup')
  async totpSetup(@Req() req: Request) {
    if (!this.throttleSetup(req.user!.id, Date.now())) {
      throw new HttpException(
        'Too many 2FA setup attempts — wait a minute and try again.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const { secret, otpauthUrl } = await this.authService.beginTotpEnrollment(
      req.user!.id,
    );
    const qrDataUrl = await QRCode.toDataURL(otpauthUrl, {
      margin: 1,
      width: 220,
    });
    return { ok: true, secret, otpauthUrl, qrDataUrl };
  }

  // Enabling 2FA re-checks the account password (confirmTotp), so it gets the
  // same shared login lockout as disable/regenerate below.
  @AllowViewerWrite()
  @Post('api/account/totp/confirm')
  async confirmTotp(@Req() req: Request) {
    const { secret, code, password } = parseBody(confirmTotpSchema, req.body);
    this.rateLimit.checkLoginAllowed(req.user!.username, req.ip);
    let result: { backupCodes: string[] };
    try {
      result = await this.authService.confirmTotp(
        req.user!.id,
        secret,
        code,
        password,
        { actor: req.user!.username },
      );
    } catch (err) {
      if (err instanceof UnauthorizedException)
        this.rateLimit.recordLoginFailure(req.user!.username, req.ip);
      throw err;
    }
    this.rateLimit.clearLoginFailures(req.user!.username, req.ip);
    return { ok: true, backupCodes: result.backupCodes };
  }

  @AllowViewerWrite()
  @Post('api/account/totp/disable')
  async disableTotp(@Req() req: Request) {
    const { password } = parseBody(passwordSchema, req.body);
    this.rateLimit.checkLoginAllowed(req.user!.username, req.ip);
    try {
      await this.authService.disableTotp(req.user!.id, password, {
        actor: req.user!.username,
      });
    } catch (err) {
      if (err instanceof UnauthorizedException)
        this.rateLimit.recordLoginFailure(req.user!.username, req.ip);
      throw err;
    }
    this.rateLimit.clearLoginFailures(req.user!.username, req.ip);
    return { ok: true };
  }

  @AllowViewerWrite()
  @Post('api/account/totp/backup-codes/regenerate')
  async regenerateBackupCodes(@Req() req: Request) {
    const { password } = parseBody(passwordSchema, req.body);
    this.rateLimit.checkLoginAllowed(req.user!.username, req.ip);
    let result: { backupCodes: string[] };
    try {
      result = await this.authService.regenerateBackupCodes(
        req.user!.id,
        password,
        { actor: req.user!.username },
      );
    } catch (err) {
      if (err instanceof UnauthorizedException)
        this.rateLimit.recordLoginFailure(req.user!.username, req.ip);
      throw err;
    }
    this.rateLimit.clearLoginFailures(req.user!.username, req.ip);
    return { ok: true, backupCodes: result.backupCodes };
  }
}

/** schema.parse() that turns a ZodError into the same 400 + first-issue-message shape legacy returned. */
function parseBody<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
  try {
    return schema.parse(body);
  } catch (err) {
    if (err instanceof ZodError)
      throw new BadRequestException(
        err.issues[0]?.message || 'Invalid request',
      );
    throw err;
  }
}

function safeNext(next: unknown): string {
  if (typeof next !== 'string' || !next.startsWith('/')) return '';
  // Reject protocol-relative ("//host"), backslash tricks ("/\\host" — browsers
  // normalize \ to / making it "//host"), and any whitespace/control chars.
  if (next.startsWith('//') || /[\\\s\x00-\x1f]/.test(next)) return '';
  return next;
}
