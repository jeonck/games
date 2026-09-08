// TAKT — the content set. Importing this module INSTALLS it; the engine then reaches
// it through `getRegistry()` and never imports these files directly.
//
//   110 machines / 25 parts / 16 blueprints / 8 audits
//
// The shape of the set, and why:
//  - the tier ladder (parts.ts) is the game's fantasy — junk becomes a Monument;
//  - ~16 machines exist only to move a part along that ladder;
//  - 6 machines are outright gambles, so a lost run has something to blame;
//  - the rest split across seven archetypes so that five different builds can win.

import { buildRegistry, setRegistry } from './registry.ts';
import type { Registry } from './registry.ts';
import { MACHINES } from './machines.ts';
import { PARTS, STARTER_CRATE } from './parts.ts';
import { BLUEPRINTS } from './blueprints.ts';
import { AUDITS } from './audits.ts';

/**
 * THE OPENING LINE — four machines in a deliberately wrong order.
 *
 * What it replaces and why. The opening used to be `press -> foundry -> doubler`,
 * and the Chart Critic measured what that actually taught: over 200 seeds the order
 * the player was handed was ALREADY OPTIMAL in 86% of first turns, and the median
 * gain from reordering it was 0.0%. The game opened by putting a button marked
 * ORDER in front of a stranger next to a panel headed "REORDER THE LINE — drag",
 * and in six runs out of seven dragging anything made the number worse. The one
 * mechanic the product rests on did not appear until the line reached six machines,
 * which the median run does not reach until shift 4 — twelve minutes in.
 *
 * This line is wrong, on purpose, in one specific and legible way:
 *
 *     FOUNDRY   promote the first part one tier      <- in the wrong place
 *     STAMP     +16 first, then it moves to the back
 *     HOIST     move the highest to front, +10
 *     DOUBLER   x2 mult first, then swap the first two
 *
 * `promote` is multiplicative — a promoted part keeps 1.5x of the value it already
 * had, plus its new tier's base. So the Foundry wants to fire LATE, on a part that
 * has been fattened by the Stamp and chosen by the Hoist. Handed first, it promotes
 * whichever part happens to be at the front, before anything has happened to it.
 *
 * Dragging the Foundry from slot 1 to slot 3 — one machine, one drag — is the whole
 * fix, and it is the correct drag in 100% of seeds. Measured over 200 seeds with
 * the critic's own probe (best shipment chosen under the handed order, then the
 * line permuted): median gain 48.7%, 0% of runs already optimal. Under a plain
 * heaviest-five-parts shipment — what a first-time player actually does — 47.5%.
 * The two agree, which is the point: this line is wrong in the machines, not in a
 * batch order the player could have fixed instead.
 *
 * Three design constraints it is built to satisfy:
 *
 *  - WRONG, NOT BAD. The handed order still beats 83% of the 24 possible orders and
 *    its first shipment scores ~234 against a 210 quota, so a new player clears
 *    round 1 on their first shipment and reads the line as a working factory that
 *    happens to be improvable. Frustration in the first ninety seconds is worse
 *    than boredom.
 *  - LEGIBLE FROM THE BREAKDOWN ALONE. The fix shows up as one row: the FOUNDRY
 *    line in "WHY THE NUMBER MOVED" goes from a rounding error to the biggest
 *    contribution on the panel, because it promoted a Gear instead of an Offcut.
 *    Nothing else in the panel changes shape.
 *  - THE ALCHEMY HOOK SURVIVES. The Foundry is still here, so a Rivet still becomes
 *    a Bolt on turn one — the one 30-second hook the critic judged to be working.
 *
 * Known limitation, recorded rather than hidden: this is still ONE fixed opening in
 * every run. The critic's §2.7 sameness finding wants the opening line varied across
 * runs, which needs `starterLine` to become a draw rather than a constant, and the
 * A2 amendment (`aggregate({ excludeMachineDefs: starterLine })`) reads it as a
 * constant. That is a separate change and it is not made here.
 */
export const STARTER_LINE: string[] = ['foundry', 'stamp', 'hoist', 'doubler'];

export const CONTENT: Registry = buildRegistry({
  machines: MACHINES,
  parts: PARTS,
  blueprints: BLUEPRINTS,
  audits: AUDITS,
  starterCrate: STARTER_CRATE,
  starterLine: STARTER_LINE,
});

setRegistry(CONTENT);

export { MACHINES, BUILD_SUPPORT } from './machines.ts';
export { PARTS, TIER_LADDER, STARTER_CRATE } from './parts.ts';
export { BLUEPRINTS } from './blueprints.ts';
export { AUDITS } from './audits.ts';
export { getRegistry } from './registry.ts';

// ---------------------------------------------------------------------------
// G2.3 — the content set's own measurement of itself.
//
// The gate (src/sim/gate.ts) takes `nonCommutativePairRate` from the content harness
// rather than from a run, so this function is the single source of that number: the
// content test asserts on it and the sim reports it, and neither can quietly measure
// something kinder than the other.
//
// DEFAULT WINDOW: batches of 2..5 parts. A shipment is 1..5 parts, but on a 1-part
// batch every positional machine is the identity BY CONSTRUCTION — there is no order
// to be sensitive to — so including singletons measures batch size rather than
// content. `withSingletons` is returned alongside, unmassaged, so the choice is
// visible in the report instead of buried here: it runs ~5 points lower.
// ---------------------------------------------------------------------------

import type { Batch } from '../engine/types.ts';
import { ALL_TAGS } from '../engine/types.ts';
import { makeRng } from '../engine/rng.ts';
import type { RunCtx } from '../engine/types.ts';

export interface CommutativityMeasurement {
  /** fraction in [0,1] of random distinct machine pairs where A(B(x)) != B(A(x)) */
  rate: number;
  /** the same measurement including 1-part batches */
  withSingletons: number;
  trials: number;
  minParts: number;
  maxParts: number;
}

export function measureNonCommutativity(
  opts: { seed?: number; trials?: number; minParts?: number; maxParts?: number } = {},
): CommutativityMeasurement {
  const seed = opts.seed ?? 20260907;
  const trials = opts.trials ?? 20000;
  const minParts = opts.minParts ?? 2;
  const maxParts = opts.maxParts ?? 5;

  const observable = (b: Batch): string =>
    b.map((p) => `${p.def}:${p.value}:${Math.round(p.mult * 1e6)}:${p.tags.join(',')}`).join('|');

  const measure = (lo: number, hi: number, sd: number): number => {
    const rng = makeRng(sd);
    const ctx = (s: number): RunCtx => ({
      rng: makeRng(s), shift: 3, round: 2, quota: 900, score: 250, shipmentIndex: 1,
      lineCap: 5, handSize: 8, credits: 24, memo: {}, grantCredits: () => {},
    });
    let differ = 0;
    for (let t = 0; t < trials; t++) {
      const i = rng.int(MACHINES.length);
      let j = rng.int(MACHINES.length);
      while (j === i) j = rng.int(MACHINES.length);
      const A = MACHINES[i];
      const B = MACHINES[j];
      const la = 1 + rng.int(3);
      const lb = 1 + rng.int(3);
      const n = lo + rng.int(hi - lo + 1);
      const focus = rng.next() < 0.33 ? rng.pick(ALL_TAGS) : null;
      const pool = focus === null ? PARTS : PARTS.filter((p) => p.tags.indexOf(focus) >= 0);
      const batch: Batch = [];
      for (let k = 0; k < n; k++) {
        const d = rng.pick(pool.length > 0 ? pool : PARTS);
        const boost = [1, 1, 1, 2, 4, 9][rng.int(6)];
        batch.push({
          id: `p${k}`, def: d.def, value: Math.floor(d.value * boost),
          mult: d.mult * [1, 1, 1, 2, 3][rng.int(5)], tags: d.tags,
        });
      }
      const s = 900 + t;
      const ab = observable(A.apply(B.apply(batch, ctx(s), lb), ctx(s), la));
      const ba = observable(B.apply(A.apply(batch, ctx(s), la), ctx(s), lb));
      if (ab !== ba) differ++;
    }
    return differ / trials;
  };

  return {
    rate: measure(minParts, maxParts, seed),
    withSingletons: measure(1, maxParts, seed),
    trials,
    minParts,
    maxParts,
  };
}
