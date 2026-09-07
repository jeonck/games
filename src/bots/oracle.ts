// TAKT — the ceiling tier. Planner shipment and line play, plus a beam search over
// PURCHASE SEQUENCES scored by actually playing the next rounds out.
//
// G1.6 (oracle − planner ≥ 10pp) asks whether there is skill left above solving the
// hand in front of you. The only lever that can answer that is the shop: the
// planner already plays each shipment near-optimally, so anything the oracle wins
// it has to win by buying a different thing. Hence a beam over sequences (buy A
// then B is not the same decision as buy A) scored by rollout rather than by a
// one-ply hand valuation.
//
// ---------------------------------------------------------------------------
// THE ORACLE IS NOT CLAIRVOYANT, AND THAT IS ON PURPOSE
// ---------------------------------------------------------------------------
// The obvious "oracle" reads the real future: same seed, so the rollout deals the
// real hands and resolves the real coins. It would be much stronger, and it would
// be measuring nothing. G1.4/G1.6 are read as "how much room is there above a
// competent player", and a bot that knows next round's deal is not a better player
// — it is a different game. Every rollout here runs on an independent seed, so the
// oracle plans under exactly the uncertainty a human faces. See clone.ts.
//
// The honest consequence, reported rather than hidden: this makes the oracle a
// STRONG PLAYER, not an upper bound on play. If G1.4's ceiling is missed low, the
// right reading is "the oracle is not strong enough to find the ceiling", not "the
// game has no ceiling".

import type { RunState } from '../engine/types.ts';
import { ROUNDS_PER_SHIFT } from '../engine/types.ts';
import type { Shop, ShopItem } from '../engine/api.ts';
import {
  buy, nextRound, playShipment, reorderLine, rollShop, roundCleared,
} from '../engine/run.ts';
import { FAST_SEARCH, lineProbes, searchLine, searchShipment } from './search.ts';
import type { ShopAction } from './types.ts';
import { affordable } from './shop.ts';
import { cloneRun } from './clone.ts';
import { PlannerBot } from './planner.ts';
import type { PlannerOptions } from './planner.ts';

export interface OracleOptions extends PlannerOptions {
  /** rounds simulated per rollout */
  horizon?: number;
  /** purchase-sequence beam width */
  beamWidth?: number;
  /** maximum purchases planned at one shop */
  beamDepth?: number;
  /** children expanded per beam node (pre-screened by the planner's one-ply value) */
  branch?: number;
  /** rollout seeds averaged per node */
  rollouts?: number;
  /** preview budget for one rollout */
  rolloutBudget?: number;
}

/** Headroom credited per cleared round in a rollout. */
const RATIO_CAP = 3;

/** How much a beam candidate must beat the planner's own plan by to be taken. */
const BEAM_MARGIN = 0.2;

interface Node {
  state: RunState;
  items: ShopItem[];
  buys: ShopItem[];
  /** one entry per rollout seed */
  value: number[];
}

export class OracleBot extends PlannerBot {
  readonly name = 'oracle' as const;
  private horizon: number;
  private beamWidth: number;
  private beamDepth: number;
  private branch: number;
  private rollouts: number;
  private rolloutBudget: number;
  private planShop: Shop | null = null;
  private plan: ShopItem[] = [];

  constructor(opts: OracleOptions = {}) {
    super(opts);
    this.horizon = opts.horizon ?? 3;
    this.beamWidth = opts.beamWidth ?? 2;
    this.beamDepth = opts.beamDepth ?? 2;
    this.branch = opts.branch ?? 2;
    this.rollouts = opts.rollouts ?? 2;
    this.rolloutBudget = opts.rolloutBudget ?? 2500;
  }

  startRun(s: RunState, seed: number): void {
    super.startRun(s, seed);
    this.planShop = null;
    this.plan = [];
  }

  // -- rollout ------------------------------------------------------------

  /**
   * Play `horizon` rounds forward from a shop with a cheap policy. Value is
   * "rounds cleared, plus the fraction of the one it died on" — a continuous
   * signal, so two purchases that both fail on round 2 are still ranked by how
   * close they came.
   */
  private rolloutOnce(from: RunState, seed: number): number {
    const c = cloneRun(from, seed);
    const ev = this.ev;
    let value = 0;
    for (let h = 0; h < this.horizon; h++) {
      nextRound(c);
      if (c.over) return c.won ? value + this.horizon * RATIO_CAP : value;

      if (c.line.length > 1 && c.hand.length > 0) {
        ev.begin(c);
        const probes = lineProbes(ev, c, c.line, FAST_SEARCH);
        const lr = searchLine(ev, c, c.line, probes, FAST_SEARCH);
        reorderLine(c, lr.perm);
      }
      while (!c.over && c.shipmentsLeft > 0 && c.hand.length > 0) {
        ev.begin(c);
        const res = searchShipment(ev, c, c.line, FAST_SEARCH);
        if (res.best.length === 0) break;
        playShipment(c, res.best);
        if (ev.exhausted) break;
      }
      // A CONTINUOUS value, not a round count. Counting rounds makes almost every
      // candidate at an early shop score exactly `horizon` — every purchase clears
      // round 1 — so the beam ties, the tie resolves to "buy nothing", and the
      // oracle ends up POORER than the planner it is supposed to dominate. That
      // inversion is a bot bug, and the integrity constraint says so: it is not a
      // finding about the game. Headroom above the quota is what a purchase buys,
      // so headroom is what the rollout scores.
      const ratio = c.quota > 0 ? c.score / c.quota : 0;
      if (!roundCleared(c)) return value + Math.min(1, ratio);
      value += Math.min(RATIO_CAP, ratio);

      // A cheap in-rollout shop: the cheapest machine that fits. Deliberately
      // weaker than the oracle's real shop policy — a rollout that shopped as well
      // as the planner would cost more than the search it is informing.
      const sh = rollShop(c);
      for (let guard = 0; guard < 4; guard++) {
        let pick = -1;
        let cost = Infinity;
        for (const i of affordable(c, sh)) {
          const it = sh.items[i];
          if (it.kind === 'part') continue;
          if (it.cost < cost) { cost = it.cost; pick = i; }
        }
        if (pick < 0 || !buy(c, sh, pick)) break;
      }
    }
    return value;
  }

  /** One value per rollout seed, kept separate so candidates can be compared PAIRED. */
  private rolloutValues(from: RunState, seed: number): number[] {
    const ev = this.ev;
    const saved = ev.opts.budget;
    (ev.opts as { budget: number }).budget = this.rolloutBudget;
    try {
      const out: number[] = new Array(this.rollouts);
      for (let r = 0; r < this.rollouts; r++) {
        out[r] = this.rolloutOnce(from, (seed + r * 0x9e3779b1) >>> 0);
      }
      return out;
    } finally {
      (ev.opts as { budget: number }).budget = saved;
    }
  }

  /**
   * Does `cand` beat `incumbent` well enough to act on?
   *
   * Both were rolled out on the SAME seeds, so the comparison is paired. A candidate
   * has to win on the mean by a margin AND win on every individual rollout — a
   * three-round rollout with a cheap in-rollout policy is a biased, noisy instrument,
   * and at 20,000 runs an oracle that overrode the planner on noise-sized differences
   * came out 0.54pp BELOW it. That inversion is a bug in this file, not a fact about
   * the game, and this is the fix.
   */
  private beats(cand: number[], incumbent: number[]): boolean {
    let sum = 0;
    for (let i = 0; i < cand.length; i++) {
      if (!(cand[i] > incumbent[i])) return false;
      sum += cand[i] - incumbent[i];
    }
    return sum / cand.length > BEAM_MARGIN;
  }

  // -- beam ---------------------------------------------------------------

  private buildPlan(s: RunState, shop: Shop): ShopItem[] {
    const seed = (this.rolloutBase
      + s.shift * 0x9e3779b1 + s.round * 0x85ebca6b + s.credits * 0xc2b2ae35) >>> 0;
    // The last shop of the run leads nowhere: nothing bought there is ever used.
    if (s.shift >= 8 && s.round >= ROUNDS_PER_SHIFT) return [];

    const root: Node = {
      state: cloneRun(s, seed), items: shop.items.slice(), buys: [], value: [],
    };
    root.value = this.rolloutValues(root.state, seed);
    let best = root;

    // THE PLANNER'S OWN PLAN IS ALWAYS A CANDIDATE. The oracle is defined as
    // "planner plus a beam over shop choices"; if the beam finds nothing better on
    // a noisy two-round rollout, the right move is the planner's move, not an empty
    // basket. Without this the oracle loses to the planner on the shop alone, which
    // is a bot bug rather than a fact about the game.
    const plan: Node = {
      state: cloneRun(s, seed), items: shop.items.slice(), buys: [], value: [],
    };
    for (let step = 0; step < this.beamDepth + 2; step++) {
      const view: Shop = { items: plan.items, rerollCost: shop.rerollCost };
      const a = super.chooseShop(plan.state, view);
      if (a.kind !== 'buy') break;
      const item = plan.items[a.index];
      if (!buy(plan.state, view, a.index)) break;
      plan.items = view.items;
      plan.buys.push(item);
    }
    if (plan.buys.length > 0) {
      plan.value = this.rolloutValues(plan.state, seed);
      best = plan;
      // "Buy nothing" has to earn the wheel from the planner's plan too.
      if (this.beats(root.value, plan.value)) best = root;
    }

    let beam: Node[] = [root];

    for (let depth = 0; depth < this.beamDepth; depth++) {
      const children: Node[] = [];
      for (const node of beam) {
        const view: Shop = { items: node.items, rerollCost: shop.rerollCost };
        const opts = affordable(node.state, view);
        if (opts.length === 0) continue;
        // Pre-screen with the planner's one-ply value so the expensive rollouts
        // are spent on plausible purchases only.
        const screened = opts
          .map((i) => ({ i, v: this.lookahead(node.state, view, [view.items[i]], seed) }))
          .filter((x) => Number.isFinite(x.v))
          .sort((a, b) => b.v - a.v)
          .slice(0, this.branch);
        for (const { i } of screened) {
          const st = cloneRun(node.state, seed);
          const copy: Shop = { items: node.items.slice(), rerollCost: shop.rerollCost };
          const item = copy.items[i];
          if (!buy(st, copy, i)) continue;
          children.push({
            state: st, items: copy.items, buys: node.buys.concat([item]), value: [],
          });
        }
      }
      if (children.length === 0) break;
      for (const ch of children) ch.value = this.rolloutValues(ch.state, seed);
      const mean = (xs: number[]): number => {
        let t = 0;
        for (const x of xs) t += x;
        return xs.length > 0 ? t / xs.length : -Infinity;
      };
      children.sort((a, b) => mean(b.value) - mean(a.value));
      if (this.beats(children[0].value, best.value)) best = children[0];
      beam = children.slice(0, this.beamWidth);
    }
    return best.buys;
  }

  chooseShop(s: RunState, shop: Shop): ShopAction {
    if (this.planShop !== shop) {
      this.planShop = shop;
      this.plan = this.buildPlan(s, shop);
    }
    while (this.plan.length > 0) {
      const want = this.plan[0];
      const idx = shop.items.indexOf(want);
      this.plan.shift();
      if (idx >= 0 && affordable(s, shop).includes(idx)) return { kind: 'buy', index: idx };
    }
    // The beam decides WHAT TO BUY. It never evaluates a reroll — a reroll is an
    // expectation over a shop nobody has seen — so once the plan is spent, the
    // planner's reroll rule still applies. Without this the oracle silently LOST the
    // planner's rerolling, which is most of how it managed to finish below it.
    const fallback = super.chooseShop(s, shop);
    return fallback.kind === 'reroll' ? fallback : { kind: 'done' };
  }
}
