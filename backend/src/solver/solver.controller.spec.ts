import { PreconditionFailedException } from '@nestjs/common';
import { ZodError } from 'zod';
import { SolverController } from './solver.controller';
import type { SolverService } from './solver.service';
import type { ModBrowserService } from '../mods/mod-browser.service';

function build(search: jest.Mock = jest.fn().mockResolvedValue([])) {
  const solve = jest.fn().mockResolvedValue({ best: null });
  const controller = new SolverController(
    { solve } as unknown as SolverService,
    { search } as unknown as ModBrowserService,
  );
  return { controller, solve, search };
}

describe('SolverController', () => {
  describe('solve', () => {
    it('accepts bare strings and ref objects, defaulting platform', async () => {
      const { controller, solve } = build();
      await controller.solve({ projects: ['sodium', { ref: 'jei' }] });
      expect(solve).toHaveBeenCalledWith([
        'sodium',
        { platform: 'modrinth', ref: 'jei' },
      ]);
    });

    it('rejects an unknown platform and empty/oversized lists', async () => {
      const { controller } = build();
      await expect(
        controller.solve({ projects: [{ platform: 'hangar', ref: 'x' }] }),
      ).rejects.toBeInstanceOf(ZodError);
      await expect(controller.solve({ projects: [] })).rejects.toBeInstanceOf(
        ZodError,
      );
      await expect(
        controller.solve({ projects: Array(26).fill('x') }),
      ).rejects.toBeInstanceOf(ZodError);
    });
  });

  describe('search', () => {
    it('defaults to Modrinth', async () => {
      const { controller, search } = build();
      await controller.search({ q: 'sodium' });
      expect(search).toHaveBeenCalledWith({
        query: 'sodium',
        platform: 'modrinth',
      });
    });

    it('returns empty without calling the registry for a blank query', async () => {
      const { controller, search } = build();
      await expect(controller.search({ q: '  ' })).resolves.toEqual({
        ok: true,
        results: [],
      });
      expect(search).not.toHaveBeenCalled();
    });

    it('maps CurseForge hits', async () => {
      const { controller, search } = build(
        jest.fn().mockResolvedValue([
          {
            platform: 'curseforge',
            ref: 'jei',
            name: 'JEI',
            iconUrl: null,
            description: 'd',
            downloads: 5,
          },
        ]),
      );
      const res = await controller.search({ q: 'jei', platform: 'curseforge' });
      expect(search).toHaveBeenCalledWith({
        query: 'jei',
        platform: 'curseforge',
      });
      expect(res.results).toEqual([
        {
          platform: 'curseforge',
          slug: 'jei',
          title: 'JEI',
          iconUrl: null,
          description: 'd',
          downloads: 5,
        },
      ]);
    });

    it('propagates the 412 when the CurseForge key is missing', async () => {
      const { controller } = build(
        jest.fn().mockRejectedValue(new PreconditionFailedException('no key')),
      );
      await expect(
        controller.search({ q: 'jei', platform: 'curseforge' }),
      ).rejects.toBeInstanceOf(PreconditionFailedException);
    });
  });
});
