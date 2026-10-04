import type { Request } from 'express';
import { ModsController } from './mods.controller';
import type { ModsService } from './mods.service';

// add-by-link passes the MC-version override through and reports whether it applied.

function build(versionOverridden?: boolean) {
  const installFromUrl = jest.fn().mockResolvedValue({
    library: { name: 'Sodium', version: '1.0' },
    filename: 'sodium.jar',
    versionOverridden,
  });
  const controller = new ModsController(
    { installFromUrl } as unknown as ModsService,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  const req = { user: { username: 'alice' } } as unknown as Request;
  return { controller, installFromUrl, req };
}

describe('ModsController.install', () => {
  it('passes ignoreVersion to the service and returns versionOverridden', async () => {
    const { controller, installFromUrl, req } = build(true);
    const res = await controller.install(req, 'srv1', {
      url: 'sodium',
      ignoreVersion: true,
    });
    expect(installFromUrl).toHaveBeenCalledWith(
      'srv1',
      'sodium',
      expect.objectContaining({ ignoreVersion: true, actor: 'alice' }),
    );
    expect(res.installed.versionOverridden).toBe(true);
  });

  it('defaults versionOverridden to false', async () => {
    const { controller, req } = build(undefined);
    const res = await controller.install(req, 'srv1', { url: 'sodium' });
    expect(res.installed.versionOverridden).toBe(false);
  });
});
