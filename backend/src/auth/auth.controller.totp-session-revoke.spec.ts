import { Test } from '@nestjs/testing';
import type { Request } from 'express';
import { ConfigService } from '../config/config.service';
import { DockerConnectionService } from '../docker/docker-connection.service';
import { EventsService } from '../events/events.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { LoginRateLimitService } from './login-rate-limit.service';
import { SessionService } from './session.service';
import { SetupPinService } from './setup-pin.service';

/**
 * Confirming TOTP enrollment (turning 2FA on) must revoke every OTHER active
 * session for that account — see AUTH_NOTES.md's "Session revocation on 2FA
 * enable" section. The session doing the enrolling must NOT be revoked.
 */
describe('AuthController.confirmTotp — session revocation', () => {
  function fakeRequest(): Request {
    return {
      ip: '198.51.100.7',
      sessionID: 'sid-currently-enrolling',
      user: { id: 'usr_a', username: 'alice', role: 'admin' },
      body: { secret: 'ABCDEFGHIJKLMNOP', code: '123456', password: 'pw' },
    } as unknown as Request;
  }

  it('revokes other sessions for the user, excepting the current session, after confirmTotp succeeds', async () => {
    const revokeSessionsForUser = jest.fn().mockResolvedValue(undefined);
    const moduleRef = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        {
          provide: AuthService,
          useValue: {
            firstRunNeeded: () => Promise.resolve(false),
            confirmTotp: () => Promise.resolve({ backupCodes: ['aaaa-bbbb'] }),
          },
        },
        { provide: EventsService, useValue: { recordEvent: jest.fn() } },
        { provide: ConfigService, useValue: {} },
        {
          provide: LoginRateLimitService,
          useValue: {
            checkLoginAllowed: jest.fn(),
            recordLoginFailure: jest.fn(),
            clearLoginFailures: jest.fn(),
          },
        },
        { provide: DockerConnectionService, useValue: {} },
        { provide: SetupPinService, useValue: {} },
        { provide: SessionService, useValue: { revokeSessionsForUser } },
      ],
    }).compile();
    const controller = moduleRef.get(AuthController);

    const result = await controller.confirmTotp(fakeRequest());

    expect(result).toEqual({ ok: true, backupCodes: ['aaaa-bbbb'] });
    expect(revokeSessionsForUser).toHaveBeenCalledWith(
      'usr_a',
      'sid-currently-enrolling',
    );
  });

  it('does not revoke any session when confirmTotp fails', async () => {
    const revokeSessionsForUser = jest.fn().mockResolvedValue(undefined);
    const moduleRef = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        {
          provide: AuthService,
          useValue: {
            firstRunNeeded: () => Promise.resolve(false),
            confirmTotp: () => Promise.reject(new Error('bad code')),
          },
        },
        { provide: EventsService, useValue: { recordEvent: jest.fn() } },
        { provide: ConfigService, useValue: {} },
        {
          provide: LoginRateLimitService,
          useValue: {
            checkLoginAllowed: jest.fn(),
            recordLoginFailure: jest.fn(),
            clearLoginFailures: jest.fn(),
          },
        },
        { provide: DockerConnectionService, useValue: {} },
        { provide: SetupPinService, useValue: {} },
        { provide: SessionService, useValue: { revokeSessionsForUser } },
      ],
    }).compile();
    const controller = moduleRef.get(AuthController);

    await expect(controller.confirmTotp(fakeRequest())).rejects.toThrow(
      'bad code',
    );
    expect(revokeSessionsForUser).not.toHaveBeenCalled();
  });
});
