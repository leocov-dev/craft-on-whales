import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { NotFoundException } from '@nestjs/common';
import type { Response } from 'express';
import { ZodError } from 'zod';
import { IconsController } from './icons.controller';
import type { ConfigService } from '../config/config.service';

describe('IconsController.getLibraryIcon', () => {
  let dataDir: string;
  let controller: IconsController;
  const res = () => {
    const setHeader = jest.fn();
    const sendFile = jest.fn();
    return {
      res: { setHeader, sendFile } as unknown as Response,
      setHeader,
      sendFile,
    };
  };

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'icons-'));
    fs.mkdirSync(path.join(dataDir, 'library', 'icons', 'mods'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(dataDir, 'library', 'icons', 'mods', 'lib_abc-12.webp'),
      'x',
    );
    controller = new IconsController(
      {} as never,
      {} as never,
      { dataDir } as ConfigService,
      {} as never,
    );
  });
  afterEach(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  it('serves a cached icon with locked-down headers', () => {
    const { res: r, setHeader, sendFile } = res();
    controller.getLibraryIcon(r, 'lib_abc-12.webp');
    expect(sendFile).toHaveBeenCalledWith(
      path.join(dataDir, 'library', 'icons', 'mods', 'lib_abc-12.webp'),
    );
    expect(setHeader).toHaveBeenCalledWith('X-Content-Type-Options', 'nosniff');
  });

  it('404s when the icon was never cached', () => {
    expect(() => controller.getLibraryIcon(res().res, 'lib_nope.png')).toThrow(
      NotFoundException,
    );
  });

  it.each(['../../etc/passwd', 'lib_x.exe', 'srv_x.png', 'lib_a/b.png'])(
    'rejects %s',
    (name) => {
      expect(() => controller.getLibraryIcon(res().res, name)).toThrow(
        ZodError,
      );
    },
  );
});
