// TAKT — persistence. Everything lives in memory except a small meta record; there is
// no server, no fetch and no absolute URL anywhere in this build, which is the whole
// requirement for wrapping it in Capacitor later.
//
// Deliberately NOT saved: the run itself. `RunState` carries a live RNG whose internal
// position is not observable, so a serialised run could not be resumed without changing
// what the next shuffle deals — and a save that quietly rerolls your deck is worse than
// no save. Recorded as a known gap in the report rather than faked here.

const KEY = 'takt.meta.v1';

export interface Meta {
  runs: number;
  wins: number;
  bestScore: number;
  bestShift: number;
  /** highest rung of the tier ladder the player has ever made something reach */
  bestRung: number;
  bestObject: string;
  /** part defs the player has seen come off the line — the beginnings of a gallery */
  seen: string[];
  fast: boolean;
}

const BLANK: Meta = {
  runs: 0, wins: 0, bestScore: 0, bestShift: 0, bestRung: -1, bestObject: '', seen: [], fast: false,
};

export function loadMeta(): Meta {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return { ...BLANK };
    const m = JSON.parse(raw) as Partial<Meta>;
    return {
      runs: m.runs ?? 0,
      wins: m.wins ?? 0,
      bestScore: m.bestScore ?? 0,
      bestShift: m.bestShift ?? 0,
      bestRung: m.bestRung ?? -1,
      bestObject: m.bestObject ?? '',
      seen: Array.isArray(m.seen) ? m.seen.slice(0, 200) : [],
      fast: m.fast === true,
    };
  } catch {
    return { ...BLANK };
  }
}

export function saveMeta(m: Meta): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(m));
  } catch {
    /* private mode, quota, whatever — the game keeps working without it */
  }
}

export function noteObject(m: Meta, def: string, rung: number): boolean {
  let novel = false;
  if (m.seen.indexOf(def) < 0) { m.seen.push(def); novel = true; }
  if (rung > m.bestRung) { m.bestRung = rung; m.bestObject = def; novel = true; }
  return novel;
}
