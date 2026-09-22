import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { parseBody } from '../utils/parse-body';
import { AuthService } from '../auth/auth.service';
import { LoginRateLimitService } from '../auth/login-rate-limit.service';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { currentUser } from '../auth/current-user';

/** Ports the "Users" (admin only) section of legacy `src/web/routes/api.ts`. */
@Controller('api/users')
@UseGuards(RolesGuard)
@Roles('admin')
export class UsersController {
  constructor(
    private readonly authService: AuthService,
    private readonly rateLimit: LoginRateLimitService,
  ) {}

  @Get()
  async list() {
    return { ok: true, users: await this.authService.listUsers() };
  }

  @Post()
  async create(@Req() req: Request, @Body() body: unknown) {
    const { username, password, role } = parseBody(
      z.object({
        username: z.string().trim().min(2).max(32),
        password: z.string().min(8).max(200),
        role: z.enum(['admin', 'operator', 'viewer']),
      }),
      body,
    );
    const user = await this.authService.createUser(
      { username, password, role },
      { actor: currentUser(req).username },
    );
    return { ok: true, user };
  }

  @Post(':id/role')
  async setRole(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const { role } = parseBody(
      z.object({ role: z.enum(['admin', 'operator', 'viewer']) }),
      body,
    );
    await this.authService.setRole(id, role, {
      actor: currentUser(req).username,
    });
    return { ok: true };
  }

  // Re-checks the ACTING admin's own current password before changing anyone's
  // password (including their own) — see AUTH_NOTES.md's "Re-auth to change a
  // password" section. Without this, a hijacked-but-unlocked admin session
  // (no password needed for anything else here) could silently take over
  // every other account by resetting its password, and self-service password
  // rotation (an admin changing THEIR OWN password) had no re-auth of its own
  // either. Shares the login lockout with the password/2FA steps, same as the
  // other password re-checks in AuthController.
  @Post(':id/password')
  async setPassword(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const { password, adminPassword } = parseBody(
      z.object({
        password: z.string().min(8).max(200),
        adminPassword: z.string().min(1).max(200),
      }),
      body,
    );
    const actor = currentUser(req);
    this.rateLimit.checkLoginAllowed(actor.username, req.ip);
    const verified = await this.authService.verifyCredentials(
      actor.username,
      adminPassword,
    );
    if (!verified) {
      this.rateLimit.recordLoginFailure(actor.username, req.ip);
      throw new UnauthorizedException('Your current password is incorrect.');
    }
    this.rateLimit.clearLoginFailures(actor.username, req.ip);
    await this.authService.setPassword(id, password, {
      actor: actor.username,
    });
    return { ok: true };
  }

  @Delete(':id')
  async remove(@Req() req: Request, @Param('id') id: string) {
    await this.authService.deleteUser(id, { actor: currentUser(req).username });
    return { ok: true };
  }

  @Post(':id/totp/disable')
  async disableTotp(@Req() req: Request, @Param('id') id: string) {
    if (id === currentUser(req).id) {
      return {
        ok: false,
        error: 'Use your own account’s 2FA settings to disable it.',
      };
    }
    await this.authService.adminDisableTotp(id, {
      actor: currentUser(req).username,
    });
    return { ok: true };
  }
}
