// TAKT — candidate evaluation, and the fix for the rng-fishing exploit.
//
// ---------------------------------------------------------------------------
// THE EXPLOIT
// ---------------------------------------------------------------------------
// `previewShipment` is exact: the engine seeds the machine rng from
// (seed, shift, round, shipmentIndex), so preview sees the same stream `play`
// will see. That is the right call for the UI — a preview that lied would be
// unusable — but it hands a searching bot the outcome of every coin flip in the
// line BEFORE it commits. Two things follow, and both corrupt the benchmark:
//
//   1. CONDITIONING. The six gamble machines resolve identically no matter what
//      the bot ships, so the bot simply reads the coin and sizes its shipment to
//      it: dump the whole hand into Wildcard on the 30% it promotes, ship one
//      throwaway part on the 70% it corrupts. A 30% machine becomes a 100%
//      machine that costs one part to check.
//   2. FISHING. Draw INDEX is not fixed. `gremlin` draws only on batches of 2+,
//      generative machines change batch length, and reordering the line reorders
//      which machine consumes which draw. So a bot that enumerates orderings is
//      also enumerating which coin each gamble gets, and takes the ordering where
//      they land well.
//
// Either way the planner's win rate stops measuring how well it plays TAKT and
// starts measuring how well it reads a PRNG. G1.3 and G1.5 would be inflated by
// an amount nobody could untangle after the fact.
//
// ---------------------------------------------------------------------------
// THE FIX
// ---------------------------------------------------------------------------
// Rank candidates by their MEAN over K rng streams that are independent of the
// one `play` will use. Concretely: `previewShipment` derives its stream from
// `s.seed` and nothing else that a bot may vary, and it is pure — so a shallow
// clone of the state carrying a different `seed` gives an independent stream
// while leaving hand, line, score, quota and shipment index identical.
//
// Because the K sampling seeds are a function of the run seed alone and never of
// the realised stream, the bot's CHOICE is statistically independent of the
// realised outcome. That is the property that closes the exploit — not a large K.
// K only controls how much noise there is in the estimate; it cannot reintroduce
// bias. The realised coin is drawn exactly once, inside `playShipment`, and the
// bot never gets to look at it and never gets to re-roll it.
//
// `fishing: true` restores the exploit exactly (evaluate the real state, one
// sample) so the harness can measure what the bug was worth. That mode exists to
// be reported, never to be shipped.
//
// COST CONTROL: K > 1 is only paid when the line can actually be random, which is
// discovered by probing the content (see `stochastic.ts`), not declared here.

import type { Machine, RunState } from '../engine/types.ts';
import { previewShipment, runMemo } from '../engine/run.ts';
import { stochasticAudits, stochasticMachineDefs } from './stochastic.ts';
import { ROUNDS_PER_SHIFT } from '../engine/types.ts';

export interface EvOptions {
  /** rng streams averaged over when the line is stochastic. 1 disables averaging. */
  samples: number;
  /** restore the bug: evaluate on the stream `play` will actually use. */
  fishing: boolean;
  /**
   * Hard ceiling on `previewShipment` calls per decision. The searches in
   * `search.ts` check it between phases and stop early rather than overrun, so a
   * pathological hand (a 14-card hand from three hand-size blueprints) cannot blow
   * the 20,000-run wall clock. Infinity disables it.
   */
  budget: number;
}

export const DEFAULT_EV: EvOptions = { samples: 8, fishing: false, budget: Infinity };

function mix(a: number, b: number): number {
  let h = (a ^ Math.imul(b, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/** The RunState fields `previewShipment` reads. Everything else is irrelevant to it. */
const MIRRORED = [
  'shift', 'round', 'quota', 'score', 'shipmentsLeft', 'lineCap', 'handSize', 'credits',
] as const;

export class Evaluator {
  readonly opts: EvOptions;
  /** number of `previewShipment` calls made. The harness reports this. */
  previews = 0;
  /** number of distinct candidates scored (a K-sample score counts once). */
  evaluations = 0;
  /** decisions in which the per-decision budget ran out before the search finished. */
  budgetHits = 0;

  private spent = 0;

  private s: RunState | null = null;
  private clones: RunState[] = [];
  private mirrored = 0;
  private stochasticDefs: Set<string> = new Set();
  private auditRandom: boolean[] = [];
  private auditActive = false;

  constructor(opts: Partial<EvOptions> = {}) {
    this.opts = { ...DEFAULT_EV, ...opts };
    if (!(this.opts.samples >= 1)) this.opts.samples = 1;
  }

  /** Called once per run. Loads the probed content facts. */
  startRun(): void {
    this.stochasticDefs = stochasticMachineDefs();
    this.auditRandom = stochasticAudits();
    this.clones = [];
    this.mirrored = 0;
    this.s = null;
  }

  /**
   * Called at the top of every decision. Re-mirrors the live state into the sample
   * clones (hand, score and shipment index all move between decisions).
   *
   * Mirroring is LAZY: clone i is only refreshed when a K-sample score actually
   * asks for it. Deterministic lines — the overwhelming majority — never touch
   * clones 1..K-1, and rollout policies that call begin() thousands of times per
   * run do not pay for samples they will not use.
   */
  begin(s: RunState): void {
    this.s = s;
    this.mirrored = 0;
    this.spent = 0;
    this.auditActive = s.round === ROUNDS_PER_SHIFT
      && this.auditRandom[s.shift - 1] === true;
  }

  private mirror(k: number): void {
    const s = this.s as RunState;
    while (this.clones.length < k) this.clones.push({} as RunState);
    for (let i = this.mirrored; i < k; i++) {
      const c = this.clones[i];
      for (const f of MIRRORED) (c as unknown as Record<string, number>)[f] = s[f];
      c.hand = s.hand;
      c.line = s.line;
      c.crate = s.crate;
      c.drawPile = s.drawPile;
      c.discard = s.discard;
      c.blueprints = s.blueprints;
      c.over = s.over;
      c.won = s.won;
      c.rng = s.rng;
      c.decisions = s.decisions;
      c.scrapsLeft = s.scrapsLeft;
      // The whole point: a stream `play` will never use.
      let seed = mix(mix(s.seed, 0xa5a5a5a5), i * 0x9e3779b1 + 1);
      if (seed === s.seed) seed = (seed + 1) >>> 0;
      c.seed = seed;
      // Machine-generated part ids come out of the memo counter; mirror it so a
      // clone cannot diverge from the live run on anything a machine can read.
      const m = runMemo(c);
      for (const key of Object.keys(m)) delete m[key];
      Object.assign(m, runMemo(s));
    }
    if (k > this.mirrored) this.mirrored = k;
  }

  /** True once this decision has spent its preview budget. Searches then stop. */
  get exhausted(): boolean {
    if (this.spent < this.opts.budget) return false;
    return true;
  }

  /** Records that a search stopped early. Called by search.ts, once per decision. */
  noteBudgetHit(): void {
    this.budgetHits++;
  }

  /** 1 when nothing in this line can be random, otherwise `opts.samples`. */
  samplesFor(line: readonly Machine[]): number {
    if (this.opts.fishing || this.opts.samples <= 1) return 1;
    if (this.auditActive) return this.opts.samples;
    for (let i = 0; i < line.length; i++) {
      if (this.stochasticDefs.has(line[i].def)) return this.opts.samples;
    }
    return 1;
  }

  /**
   * Expected score of shipping `indices` (ordered) through `line`.
   * `k` comes from `samplesFor`; pass 1 to force a single sample.
   */
  score(indices: number[], line: Machine[], k: number): number {
    const s = this.s as RunState;
    this.evaluations++;
    if (this.opts.fishing) {
      // Fishing mode reads the live state, and so the realised stream. This is the
      // bug, kept executable so the harness can price it.
      this.previews++;
      this.spent++;
      return previewShipment(s, indices, line).gained;
    }
    if (k > this.mirrored) this.mirror(k);
    if (k <= 1) {
      this.previews++;
      this.spent++;
      return previewShipment(this.clones[0], indices, line).gained;
    }
    let total = 0;
    for (let i = 0; i < k; i++) {
      this.previews++;
      this.spent++;
      total += previewShipment(this.clones[i], indices, line).gained;
    }
    return total / k;
  }
}
