import { WorldControlsService } from './world-controls.service';
import { GAMERULES } from './world-controls.constants';
import type { ContainerService } from '../docker/container.service';
import type { EventsService } from '../events/events.service';
import type { ServerPropertiesService } from '../servers/server-properties.service';
import type { GameruleKey } from './world-controls.types';

describe('WorldControlsService.getState — concurrent gamerule reads', () => {
  const SERVER_ID = 'srv-1';

  function buildService(execCapture: jest.Mock): WorldControlsService {
    const containers = { execCapture } as unknown as ContainerService;
    const events = { recordEvent: jest.fn() } as unknown as EventsService;
    const properties = {
      get: jest.fn().mockReturnValue(undefined),
    } as unknown as ServerPropertiesService;
    return new WorldControlsService(containers, events, properties);
  }

  it('includes the full vanilla boolean gamerule table', () => {
    const keys = Object.keys(GAMERULES) as GameruleKey[];
    // Guard against silent shrinkage of the table this item added.
    expect(keys.length).toBeGreaterThanOrEqual(43);
    expect(keys).toEqual(
      expect.arrayContaining(['keepInventory', 'doDaylightCycle']),
    );
    // Every key must have a distinct snake_case counterpart (26.x spelling).
    const values = Object.values(GAMERULES);
    expect(new Set(values).size).toBe(values.length);
  });

  it('reads every gamerule concurrently and merges results back into state', async () => {
    const execCapture = jest.fn(
      (_serverId: string, args: (string | number)[]): string => {
        const name = String(args[3] ?? '');
        // Every snake_case query succeeds with `true`.
        return `Gamerule ${name} is currently set to: true`;
      },
    );
    const service = buildService(execCapture);

    const state = await service.getState(SERVER_ID);

    const keys = Object.keys(GAMERULES) as GameruleKey[];
    for (const key of keys) {
      expect(state[key]).toBe(true);
    }
    // One RCON call per rule (snake_case succeeds first try, no camelCase
    // fallback), plus the time/day queries getState also makes.
    expect(execCapture.mock.calls.length).toBeGreaterThanOrEqual(keys.length);
  });

  it('does not let one failing/unsupported gamerule abort the rest of the batch', async () => {
    const FAILING_RULE: GameruleKey = 'doMobLoot';
    const UNSUPPORTED_RULE: GameruleKey = 'locatorBar';

    const execCapture = jest.fn(
      (_serverId: string, args: (string | number)[]): string => {
        const name = String(args[3] ?? '');
        if (name === GAMERULES[FAILING_RULE] || name === FAILING_RULE) {
          // Simulate a genuine exec/RCON failure (e.g. container exec error).
          throw new Error('exec failed: container busy');
        }
        if (name === GAMERULES[UNSUPPORTED_RULE] || name === UNSUPPORTED_RULE) {
          // Simulate an older MC version that doesn't know this rule at all.
          return 'Unknown or incomplete command, see below';
        }
        return `Gamerule ${name} is currently set to: true`;
      },
    );
    const service = buildService(execCapture);

    const state = await service.getState(SERVER_ID);

    // The failing rule and the unsupported rule are both simply absent —
    // neither one blanks the rest of the read.
    expect(state[FAILING_RULE]).toBeUndefined();
    expect(state[UNSUPPORTED_RULE]).toBeUndefined();

    const otherKeys = (Object.keys(GAMERULES) as GameruleKey[]).filter(
      (k) => k !== FAILING_RULE && k !== UNSUPPORTED_RULE,
    );
    for (const key of otherKeys) {
      expect(state[key]).toBe(true);
    }
  });
});
