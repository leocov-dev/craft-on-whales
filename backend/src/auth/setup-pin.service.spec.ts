import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigService } from '../config/config.service';
import { AuthService } from './auth.service';
import { SetupPinService } from './setup-pin.service';

describe('SetupPinService', () => {
  async function build(
    isExposedBind: boolean,
    firstRunNeeded: boolean,
  ): Promise<{ service: SetupPinService; loggedPin: string | null }> {
    let loggedPin: string | null = null;
    const warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(function (this: Logger, message: unknown) {
        const match = /First-run setup PIN: (\d{6})/.exec(String(message));
        if (match) loggedPin = match[1]!;
        return undefined;
      });
    const moduleRef = await Test.createTestingModule({
      providers: [
        SetupPinService,
        {
          provide: ConfigService,
          useValue: { isExposedBind, host: '0.0.0.0' },
        },
        {
          provide: AuthService,
          useValue: { firstRunNeeded: () => Promise.resolve(firstRunNeeded) },
        },
      ],
    }).compile();
    const service = moduleRef.get(SetupPinService);
    await service.onModuleInit();
    warnSpy.mockRestore();
    return { service, loggedPin };
  }

  it('does not require a PIN on a loopback-only bind', async () => {
    const { service } = await build(false, true);
    expect(service.required()).toBe(false);
    expect(service.verify('000000')).toBe(false);
  });

  it('does not require a PIN once first-run setup is already complete', async () => {
    const { service } = await build(true, false);
    expect(service.required()).toBe(false);
  });

  it('requires and generates a 6-digit PIN on a non-loopback bind during first run, logged to the console', async () => {
    const { service, loggedPin } = await build(true, true);
    expect(service.required()).toBe(true);
    expect(loggedPin).toMatch(/^\d{6}$/);
  });

  it('verify() accepts the generated PIN and rejects anything else', async () => {
    const { service, loggedPin } = await build(true, true);
    expect(loggedPin).not.toBeNull();
    expect(service.verify(loggedPin!)).toBe(true);
    const wrongPin = loggedPin === '000000' ? '111111' : '000000';
    expect(service.verify(wrongPin)).toBe(false);
    expect(service.verify('not-a-pin')).toBe(false);
    expect(service.verify('')).toBe(false);
  });

  it('consume() invalidates the PIN permanently, even the correct one', async () => {
    const { service, loggedPin } = await build(true, true);
    expect(service.required()).toBe(true);
    service.consume();
    expect(service.required()).toBe(false);
    expect(service.verify(loggedPin!)).toBe(false);
  });
});
