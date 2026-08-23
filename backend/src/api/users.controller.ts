import { BadRequestException, Body, Controller, Delete, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { z, ZodError } from 'zod';
import { AuthService } from '../auth/auth.service';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';

function parseBody<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
  try {
    return schema.parse(body);
  } catch (err) {
    if (err instanceof ZodError) throw new BadRequestException(err.issues[0]?.message || 'Invalid request');
    throw err;
  }
}

/** Ports the "Users" (admin only) section of legacy `src/web/routes/api.ts`. */
@Controller('api/users')
@UseGuards(RolesGuard)
@Roles('admin')
export class UsersController {
  constructor(private readonly authService: AuthService) {}

  @Get()
  list() {
    return { ok: true, users: this.authService.listUsers() };
  }

  @Post()
  create(@Req() req: Request, @Body() body: unknown) {
    const { username, password, role } = parseBody(
      z.object({ username: z.string().trim().min(2).max(32), password: z.string().min(8).max(200), role: z.enum(['admin', 'operator', 'viewer']) }),
      body
    );
    const user = this.authService.createUser({ username, password, role }, { actor: req.user!.username });
    return { ok: true, user };
  }

  @Post(':id/role')
  setRole(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    const { role } = parseBody(z.object({ role: z.enum(['admin', 'operator', 'viewer']) }), body);
    this.authService.setRole(id, role, { actor: req.user!.username });
    return { ok: true };
  }

  @Post(':id/password')
  setPassword(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    const { password } = parseBody(z.object({ password: z.string().min(8).max(200) }), body);
    this.authService.setPassword(id, password, { actor: req.user!.username });
    return { ok: true };
  }

  @Delete(':id')
  remove(@Req() req: Request, @Param('id') id: string) {
    this.authService.deleteUser(id, { actor: req.user!.username });
    return { ok: true };
  }

  @Post(':id/totp/disable')
  disableTotp(@Req() req: Request, @Param('id') id: string) {
    if (id === req.user!.id) {
      return { ok: false, error: 'Use your own account’s 2FA settings to disable it.' };
    }
    this.authService.adminDisableTotp(id, { actor: req.user!.username });
    return { ok: true };
  }
}
