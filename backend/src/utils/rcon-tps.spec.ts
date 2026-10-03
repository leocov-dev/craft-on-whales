import { mergeTps, parseTps } from './rcon-tps';

describe('parseTps', () => {
  it('parses Paper/Purpur `tps`', () => {
    expect(parseTps('TPS from last 1m, 5m, 15m: 19.98, 20.0, *20.0')).toEqual({
      source: 'paper',
      tps1: 19.98,
      tps5: 20,
      tps15: 20,
      mspt: null,
    });
  });

  it('parses spark `spark tps` (five windows, keeps 1m/5m/15m)', () => {
    const r = parseTps(
      'TPS from last 5s, 10s, 1m, 5m, 15m: 20, 20, 19.9, 19.95, 20',
    );
    expect(r).toMatchObject({
      source: 'spark',
      tps1: 19.9,
      tps5: 19.95,
      tps15: 20,
    });
  });

  it('parses Forge `forge tps` overall line', () => {
    expect(
      parseTps('Overall: Mean tick time: 3.456 ms. Mean TPS: 20.000'),
    ).toEqual({
      source: 'forge',
      tps1: 20,
      tps5: null,
      tps15: null,
      mspt: 3.456,
    });
  });

  it('parses Paper `mspt` average from the 5s group', () => {
    const r = parseTps(
      'Server tick times (avg/min/max) from last 5s, 10s, 1m:\n1.23/0.90/4.50, 1.30/0.88/6.0, 1.4/0.9/9.9',
    );
    expect(r).toMatchObject({ mspt: 1.23, tps1: null });
  });

  it('returns null for vanilla / unknown output', () => {
    expect(parseTps('Unknown command or insufficient permissions')).toBeNull();
    expect(parseTps('')).toBeNull();
  });
});

describe('mergeTps', () => {
  it('fills missing fields from the second reading', () => {
    const tps = parseTps('TPS from last 1m, 5m, 15m: 20, 20, 20');
    const mspt = parseTps('tick times from last 5s:\n2.5/1/4');
    expect(mergeTps(tps, mspt)).toMatchObject({ tps1: 20, mspt: 2.5 });
  });

  it('passes through a lone reading', () => {
    expect(mergeTps(null, null)).toBeNull();
  });
});
