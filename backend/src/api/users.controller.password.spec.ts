import { UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Request } from 'express';
import { AuthService } from '../auth/auth.service';
import { LoginRateLimitService } from '../auth/login-rate-limit.service';
import { UsersController } from './users.controller';

/**
 * POST /api/users/:id/password now re-checks the ACTING admin's own current
 * password before changing anyone's — including their own. See
 * AUTH_NOTES.md's "Re-auth to change a password" section for the threat this
 * closes (a hijacked-but-unlocked admin session silently taking over every
 * other account).
 */
describe('UsersController — password change re-auth', () => {
  function fakeRequest(username: string): Request {
    return {
      ip: '203.0.113.5',
      user: { id: 'usr_admin', username, role: 'admin' },
    } as unknown as Request;
  }

  it('rejects the change when the acting admin gets their own current password wrong', async () => {
    const setPassword = jest.fn();
    const rateLimitRecord = jest.fn();
    const moduleRef = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [
        {
          provide: AuthService,
          useValue: {
            verifyCredentials: () => Promise.resolve(null),
            setPassword,
          },
        },
        {
          provide: LoginRateLimitService,
          useValue: {
            checkLoginAllowed: jest.fn(),
            recordLoginFailure: rateLimitRecord,
            clearLoginFailures: jest.fn(),
          },
        },
      ],
    }).compile();
    const controller = moduleRef.get(UsersController);

    await expect(
      controller.setPassword(fakeRequest('admin'), 'usr_target', {
        password: 'newpassword1',
        adminPassword: 'wrong-current-password',
      }),
    ).rejects.toThrow(UnauthorizedException);

    expect(setPassword).not.toHaveBeenCalled();
    expect(rateLimitRecord).toHaveBeenCalledWith('admin', '203.0.113.5');
  });

  it('applies the change once the acting admin’s current password verifies', async () => {
    const setPassword = jest.fn(() => Promise.resolve());
    const rateLimitClear = jest.fn();
    const moduleRef = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [
        {
          provide: AuthService,
          useValue: {
            verifyCredentials: (username: string, password: string) =>
              Promise.resolve(
                password === 'correct-current-password'
                  ? { id: 'usr_admin', username, role: 'admin' }
                  : null,
              ),
            setPassword,
          },
        },
        {
          provide: LoginRateLimitService,
          useValue: {
            checkLoginAllowed: jest.fn(),
            recordLoginFailure: jest.fn(),
            clearLoginFailures: rateLimitClear,
          },
        },
      ],
    }).compile();
    const controller = moduleRef.get(UsersController);

    const result = await controller.setPassword(
      fakeRequest('admin'),
      'usr_target',
      {
        password: 'brandnewpassword',
        adminPassword: 'correct-current-password',
      },
    );

    expect(result).toEqual({ ok: true });
    expect(setPassword).toHaveBeenCalledWith('usr_target', 'brandnewpassword', {
      actor: 'admin',
    });
    expect(rateLimitClear).toHaveBeenCalledWith('admin', '203.0.113.5');
  });

  it('applies the same re-auth requirement when an admin changes their OWN password', async () => {
    const setPassword = jest.fn(() => Promise.resolve());
    const moduleRef = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [
        {
          provide: AuthService,
          useValue: {
            verifyCredentials: () => Promise.resolve(null),
            setPassword,
          },
        },
        {
          provide: LoginRateLimitService,
          useValue: {
            checkLoginAllowed: jest.fn(),
            recordLoginFailure: jest.fn(),
            clearLoginFailures: jest.fn(),
          },
        },
      ],
    }).compile();
    const controller = moduleRef.get(UsersController);

    await expect(
      controller.setPassword(fakeRequest('admin'), 'usr_admin', {
        password: 'newpassword1',
        adminPassword: 'wrong',
      }),
    ).rejects.toThrow(UnauthorizedException);
    expect(setPassword).not.toHaveBeenCalled();
  });
});
