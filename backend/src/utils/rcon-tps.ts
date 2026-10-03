// Parses tick-performance output from the few commands that expose it.
// Vanilla has none of these, so callers must tolerate a null result.
//
//   Paper / Purpur / Pufferfish  `tps`   -> "TPS from last 1m, 5m, 15m: 19.98, 20.0, *20.0"
//   Paper                        `mspt`  -> "Server tick times (avg/min/max) from last 5s, 10s, 1m:"
//                                           then "1.2/0.9/3.4, ..."
//   spark                        `spark tps` -> "TPS from last 5s, 10s, 1m, 5m, 15m: 20, 20, 20, 20, 20"
//   Forge / NeoForge             `forge tps` -> "Overall: Mean tick time: 3.456 ms. Mean TPS: 20.000"
//
// Modelled on upstream's `src/utils/rconTps.js`, rewritten for this codebase.

export interface TpsSample {
  tps1: number | null;
  tps5: number | null;
  tps15: number | null;
  mspt: number | null;
  source: 'paper' | 'spark' | 'forge';
}

const NUM = /-?\d+(?:\.\d+)?/g;

function nums(str: string): number[] {
  return (str.match(NUM) ?? []).map(Number).filter((n) => Number.isFinite(n));
}

type TpsWindows = Pick<TpsSample, 'tps1' | 'tps5' | 'tps15'>;

/** Paper/Purpur `tps` and spark `tps` both start "TPS from last <windows>: <values>". */
function parseTpsLine(text: string): TpsWindows | null {
  const m = /TPS from last ([^:]+):\s*([^\n\r]+)/i.exec(text);
  if (!m?.[1] || !m[2]) return null;
  const windows = (m[1].match(/\d+\s*[smh]/gi) ?? []).map((w) =>
    w.replace(/\s+/g, '').toLowerCase(),
  );
  const values = nums(m[2]); // "*20.0" (capped) still yields 20.0
  if (!values.length) return null;
  const pick = (label: string): number | null => {
    const i = windows.indexOf(label);
    return i !== -1 ? (values[i] ?? null) : null;
  };
  // spark reports 5s/10s/1m/5m/15m; Paper reports 1m/5m/15m. Fall back to the
  // last three values when the window labels don't line up.
  return {
    tps1: pick('1m') ?? values[values.length - 3] ?? values[0] ?? null,
    tps5: pick('5m') ?? values[values.length - 2] ?? null,
    tps15: pick('15m') ?? values[values.length - 1] ?? null,
  };
}

/** Forge / NeoForge `forge tps` — one "Overall:" summary line. */
function parseForgeTps(text: string): TpsSample | null {
  const m =
    /Overall\s*:?.*?Mean tick time:\s*(-?\d+(?:\.\d+)?)\s*ms.*?Mean TPS:\s*(-?\d+(?:\.\d+)?)/is.exec(
      text,
    );
  if (!m) return null;
  return {
    tps1: Number(m[2]),
    tps5: null,
    tps15: null,
    mspt: Number(m[1]),
    source: 'forge',
  };
}

/** Paper `mspt` — "... from last 5s, 10s, 1m:" then an "avg/min/max, ..." line. */
function parseMspt(text: string): number | null {
  if (!/tick times|mspt/i.test(text)) return null;
  const m = /(\d+(?:\.\d+)?)\s*\/\s*\d+(?:\.\d+)?\s*\/\s*\d+(?:\.\d+)?/.exec(
    text,
  );
  return m ? Number(m[1]) : null;
}

/**
 * @param raw - ANSI/§-stripped output of one of the commands above.
 * @returns null when the text matches nothing (vanilla, unknown command).
 */
export function parseTps(raw: string): TpsSample | null {
  const text = String(raw || '');
  if (!text.trim()) return null;

  const forge = parseForgeTps(text);
  if (forge) return forge;

  const line = parseTpsLine(text);
  if (line) {
    const source = /from last \d+\s*s/i.test(text) ? 'spark' : 'paper';
    return { mspt: parseMspt(text), source, ...line };
  }

  const mspt = parseMspt(text);
  if (mspt != null) {
    return { tps1: null, tps5: null, tps15: null, mspt, source: 'paper' };
  }
  return null;
}

/** Fold a later reading (e.g. `mspt`) into an earlier one (e.g. `tps`). */
export function mergeTps(a: TpsSample | null, b: TpsSample | null) {
  if (!a || !b) return a ?? b;
  return {
    tps1: a.tps1 ?? b.tps1,
    tps5: a.tps5 ?? b.tps5,
    tps15: a.tps15 ?? b.tps15,
    mspt: a.mspt ?? b.mspt,
    source: a.source,
  } satisfies TpsSample;
}
