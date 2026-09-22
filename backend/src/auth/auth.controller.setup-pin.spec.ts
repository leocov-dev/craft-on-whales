import { UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Request, Response } from 'express';
import { ConfigService } from '../config/config.service';
import { DockerConnectionService } from '../docker/docker-connection.service';
import { EventsService } from '../events/events.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { LoginRateLimitService } from './login-rate-limit.service';
import { SessionService } from './session.service';
import { SetupPinService } from './setup-pin.service';

/**
 * POST /setup's setup-PIN gate + its per-IP/global lockout — see
 * AUTH_NOTES.md's "Setup-PIN gate" and "Setup-PIN lockout" sections. The
 * lockout deliberately reuses LoginRateLimitService's existing generic
 * "subject|ip" API unchanged: two calls under fixed pseudo-subjects, one
 * keyed by the real caller IP (per-IP) and one by a fixed pseudo-IP (global,
 * shared across every caller).
 */
describe('AuthController — setup-PIN gate', () => {
  function fakeResponse(): Response & { body?: unknown; statusCode?: number } {
    const res: Partial<Response> & { body?: unknown; statusCode?: number } = {};
    res.status = jest.fn().mockImplementation((code: number) => {
      res.statusCode = code;
      return res;
    });
    res.json = jest.fn().mockImplementation((body: unknown) => {
      res.body = body;
      return res;
    });
    return res as Response & { body?: unknown; statusCode?: number };
  }

  function fakeRequest(body: unknown): Request {
    return {
      ip: '198.51.100.7',
      body,
      session: {
        regenerate: (cb: (err?: Error) => void) => cb(),
      },
    } as unknown as Request;
  }

  async function build(pinRequired: boolean) {
    const checkLoginAllowed = jest.fn();
    const recordLoginFailure = jest.fn();
    const clearLoginFailures = jest.fn();
    const verify = jest.fn().mockReturnValue(false);
    const consume = jest.fn();
    const createUser = jest.fn().mockResolvedValue({ username: 'newadmin' });

    const moduleRef = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        {
          provide: AuthService,
          useValue: {
            firstRunNeeded: () => Promise.resolve(true),
            createUser,
          },
        },
        { provide: EventsService, useValue: { recordEvent: jest.fn() } },
        { provide: ConfigService, useValue: {} },
        {
          provide: LoginRateLimitService,
          useValue: {
            checkLoginAllowed,
            recordLoginFailure,
            clearLoginFailures,
          },
        },
        { provide: DockerConnectionService, useValue: {} },
        {
          provide: SetupPinService,
          useValue: { required: () => pinRequired, verify, consume },
        },
        {
          provide: SessionService,
          useValue: { revokeSessionsForUser: jest.fn() },
        },
      ],
    }).compile();
    return {
      controller: moduleRef.get(AuthController),
      checkLoginAllowed,
      recordLoginFailure,
      clearLoginFailures,
      verify,
      consume,
      createUser,
    };
  }

  it('skips the PIN check entirely when no PIN is required (loopback bind)', async () => {
    const { controller, checkLoginAllowed, createUser } = await build(false);
    const req = fakeRequest({ username: 'admin', password: 'password123' });
    const res = fakeResponse();

    await controller.setup(req, res);

    expect(checkLoginAllowed).not.toHaveBeenCalled();
    expect(createUser).toHaveBeenCalled();
  });

  it('rejects setup with a missing/incorrect PIN, recording BOTH per-IP and global failures', async () => {
    const { controller, recordLoginFailure, createUser } = await build(true);
    const req = fakeRequest({
      username: 'admin',
      password: 'password123',
      pin: '000000',
    });
    const res = fakeResponse();

    await expect(controller.setup(req, res)).rejects.toThrow(
      UnauthorizedException,
    );
    expect(createUser).not.toHaveBeenCalled();
    expect(recordLoginFailure).toHaveBeenCalledWith(
      'setup-pin',
      '198.51.100.7',
    );
    expect(recordLoginFailure).toHaveBeenCalledWith('setup-pin-global', '*');
  });

  it('checks BOTH the per-IP and global lockout before verifying the PIN', async () => {
    const { controller, checkLoginAllowed } = await build(true);
    const req = fakeRequest({
      username: 'admin',
      password: 'password123',
      pin: '000000',
    });
    const res = fakeResponse();

    await expect(controller.setup(req, res)).rejects.toThrow();
    expect(checkLoginAllowed).toHaveBeenCalledWith('setup-pin', '198.51.100.7');
    expect(checkLoginAllowed).toHaveBeenCalledWith('setup-pin-global', '*');
  });

  it('creates the admin and consumes the PIN once verified correctly', async () => {
    const { controller, verify, consume, createUser, clearLoginFailures } =
      await build(true);
    verify.mockReturnValue(true);
    const req = fakeRequest({
      username: 'admin',
      password: 'password123',
      pin: '123456',
    });
    const res = fakeResponse();

    await controller.setup(req, res);

    expect(createUser).toHaveBeenCalled();
    expect(consume).toHaveBeenCalled();
    expect(clearLoginFailures).toHaveBeenCalledWith(
      'setup-pin',
      '198.51.100.7',
    );
    expect(clearLoginFailures).toHaveBeenCalledWith('setup-pin-global', '*');
  });
});
