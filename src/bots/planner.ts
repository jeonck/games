// TAKT — the "competent human" tier. G1.3 pins it to 40–60% and every G2–G7
// metric is read off it, so this policy is the one the whole gate stands on.
//
// What it does that greedy does not:
//   1. searches ORDERINGS inside a shipment, not just subsets (bounded — see
//      search.ts, and see the coverage numbers printed in RESULTS.md);
//   2. searches LINE PERMUTATIONS at every shop, from the arrival order, which is
//      also where the G2.1 / G2.2 / G2.4 samples come from;
//   3. prices a purchase by ONE PLY of lookahead — clone the run, buy it, deal the
//      next round, and see what the hand is worth — rather than by its price tag;
//   4. spends scraps on a hand that cannot make the round's pace.
//
// What it deliberately does NOT do, because that is the oracle's job and G1.6
// exists to measure the gap: plan across a whole shift, or consider a SEQUENCE of
// purchases as a plan rather than one purchase at a time.
//
// EVERY evaluation goes through Evaluator, so no search in this file can read the
// coin flip it is about to be dealt. See ev.ts.

import type { Machine, RunState } from '../engine/types.ts';
import type { Shop, ShopItem } from '../engine/api.ts';
import { buy, nextRound } from '../engine/run.ts';
import { Evaluator } from './ev.ts';
import type { EvOptions } from './ev.ts';
import { FAST_SEARCH, PLANNER_SEARCH, lineProbes, searchLine, searchShipment } from './search.ts';
import type { SearchConfig } from './search.ts';
import type { Bot, ReorderDecision, ShipmentDecision, ShopAction } from './types.ts';
import { affordable } from './shop.ts';
import { cloneRun } from './clone.ts';
import { makeRng } from '../engine/rng.ts';
import { lineCreditYield } from './credits.ts';

/**
 * A purchase must beat doing nothing by this much per credit, measured in
 * fractions of the next round's quota. 0.01 = "a credit is worth 1% of a round".
 * It is the planner's only price-of-money knob; it exists so that hoarding for a
 * later, better shop is a live option rather than something the bot can never do.
 * It is NOT tuned against the gate — see the report.
 */
export const CREDIT_COST_WEIGHT = 0.02;

/** A redraw must beat the hand in front of you by this much to be worth a scrap. */
const SCRAP_MARGIN = 1.08;

/** Redraws sampled when pricing one scrap. */
const SCRAP_SAMPLES = 2;

/** Probes used by the cheap in-round line refinement. */
const REFINE_PROBES = 4;

/** Partners tried per enabling candidate when pricing a pair. */
const PAIR_PARTNERS = 4;

/** Reroll only while the reroll leaves this multiple of its own cost behind. */
const REROLL_RESERVE = 3;

/** Hands sampled out of the resulting crate when pricing one purchase. */
const SHOP_HANDS = 2;

/** Pair lookaheads allowed per shop step, across all enabling candidates. */
const PAIR_BUDGET = 3;

export interface PlannerOptions extends Partial<EvOptions> {
  search?: SearchConfig;
  /** preview budget for a shipment decision */
  shipmentBudget?: number;
  /** preview budget for the line-permutation search at one shop */
  lineBudget?: number;
  /** preview budget for pricing ONE candidate purchase */
  shopBudget?: number;
  /** price of money: how much next-round value one credit must buy to be spent */
  creditWeight?: number;
  /** preview budget for the per-shipment line refinement */
  refineBudget?: number;
}

export class PlannerBot implements Bot {
  readonly name = 'planner' as const;
  readonly ev: Evaluator;
  protected cfg: SearchConfig;
  protected shipmentBudget: number;
  protected lineBudget: number;
  protected shopBudget: number;
  protected creditWeight: number;
  protected refineBudget: number;
  private cachedSig = '';
  private cached: (ShipmentDecision & { score: number }) | null = null;
  /** rollout seeds are per-run and independent of the run's own stream */
  protected rolloutBase = 1;

  constructor(opts: PlannerOptions = {}) {
    const {
      search, shipmentBudget, lineBudget, shopBudget, creditWeight, refineBudget, ...ev
    } = opts;
    this.creditWeight = creditWeight ?? CREDIT_COST_WEIGHT;
    this.cfg = search ?? PLANNER_SEARCH;
    this.shipmentBudget = shipmentBudget ?? 4000;
    this.lineBudget = lineBudget ?? 4000;
    this.shopBudget = shopBudget ?? 400;
    this.refineBudget = opts.refineBudget ?? 900;
    this.ev = new Evaluator({ budget: Infinity, ...ev });
  }

  startRun(_s: RunState, seed: number): void {
    this.ev.startRun();
    this.cachedSig = '';
    this.cached = null;
    this.rolloutBase = ((seed ^ 0x7f4a7c15) >>> 0) || 1;
  }

  private sig(s: RunState): string {
    let out = `${s.shift}.${s.round}.${s.shipmentsLeft}.${s.scrapsLeft}.${s.score}|`;
    for (const p of s.hand) out += `${p.id};`;
    for (const m of s.line) out += `${m.def}:${m.level},`;
    return out;
  }

  /** Cached because chooseScrap and chooseShipment ask the same question. */
  protected shipmentSearch(s: RunState): ShipmentDecision & { score: number } {
    const sig = this.sig(s);
    if (this.cached !== null && this.cachedSig === sig) return this.cached;
    this.ev.begin(s);
    const res = searchShipment(this.ev, s, s.line, this.cfg);
    const out = {
      indices: res.best, marginPct: res.marginPct, subsetMarginPct: res.subsetMarginPct,
      evaluated: res.evaluated, score: res.bestScore,
    };
    this.cachedSig = sig;
    this.cached = out;
    return out;
  }

  chooseShipment(s: RunState): ShipmentDecision {
    const r = this.shipmentSearch(s);
    return {
      indices: r.indices, marginPct: r.marginPct,
      subsetMarginPct: r.subsetMarginPct, evaluated: r.evaluated,
    };
  }

  /**
   * Scrapping is not a panic button: three scraps a round are a resource, and the
   * question is whether a redraw is worth more than the hand in front of you. So
   * the policy is an actual comparison — price the current hand, then price the
   * hand you would hold after dumping a candidate set and drawing replacements out
   * of the crate, averaged over a few draws. Scrap only when the redraw wins by a
   * margin (the margin is the option value of keeping the scrap for a worse hand
   * later in the round).
   *
   * Replacements are sampled from the crate rather than the true draw pile: the
   * bot is not allowed to know the deck order, for the same reason it is not
   * allowed to know the coin (ev.ts).
   */
  chooseScrap(s: RunState): number[] | null {
    if (s.scrapsLeft <= 0 || s.shipmentsLeft <= 0) return null;
    if (s.hand.length <= 1) return null;
    const cur = this.shipmentSearch(s);
    const keep = new Set(cur.indices);
    const unused: number[] = [];
    for (let i = 0; i < s.hand.length; i++) if (!keep.has(i)) unused.push(i);
    if (unused.length === 0) return null;
    unused.sort((a, b) => s.hand[a].value * s.hand[a].mult - s.hand[b].value * s.hand[b].mult);

    const sets: number[][] = [unused];
    if (unused.length > 2) sets.push(unused.slice(0, Math.ceil(unused.length / 2)));

    const seed = (this.rolloutBase + s.shift * 7919 + s.round * 104729
      + s.shipmentsLeft * 65537 + s.scrapsLeft) >>> 0;
    let bestSet: number[] | null = null;
    let bestEst = cur.score * SCRAP_MARGIN;
    for (const set of sets) {
      const est = this.afterScrap(s, set, seed);
      if (est > bestEst) { bestEst = est; bestSet = set; }
    }
    // Re-prime the evaluator on the live state: afterScrap left it on a clone.
    this.ev.begin(s);
    return bestSet;
  }

  /** Expected best shipment after dumping `drop` and redrawing, averaged. */
  private afterScrap(s: RunState, drop: number[], seed: number): number {
    const dropped = new Set(drop);
    const ev = this.ev;
    const saved = ev.opts.budget;
    (ev.opts as { budget: number }).budget = this.shopBudget;
    try {
      let total = 0;
      for (let h = 0; h < SCRAP_SAMPLES; h++) {
        const c = cloneRun(s, (seed + h * 0x9e3779b1) >>> 0);
        const kept = c.hand.filter((_p, i) => !dropped.has(i));
        const inHand = new Set(kept.map((p) => p.id));
        const pool = c.crate.filter((p) => !inHand.has(p.id));
        const rng = makeRng((seed + h * 0x85ebca6b) >>> 0);
        const want = Math.min(drop.length, pool.length);
        for (let i = 0; i < want; i++) {
          const j = i + rng.int(pool.length - i);
          const t = pool[i]; pool[i] = pool[j]; pool[j] = t;
        }
        c.hand = kept.concat(pool.slice(0, want));
        if (c.hand.length === 0) continue;
        ev.begin(c);
        total += searchShipment(ev, c, c.line, FAST_SEARCH).bestScore;
      }
      return total / SCRAP_SAMPLES;
    } finally {
      (ev.opts as { budget: number }).budget = saved;
    }
  }

  // -- shop ---------------------------------------------------------------

  /**
   * One ply: clone the run, make the purchases, deal the next round, and price the
   * hand that comes out. Every candidate at one shop is rolled out on the SAME
   * seed (common random numbers), so the comparison between purchases is not
   * dominated by which hand each happened to be dealt.
   */
  protected lookahead(s: RunState, shop: Shop, picks: ShopItem[], seed: number): number {
    const c = cloneRun(s, seed);
    let firstBest: number[] = [];
    if (picks.length > 0) {
      const copy: Shop = { items: shop.items.slice(), rerollCost: shop.rerollCost };
      for (const item of picks) {
        const i = copy.items.indexOf(item);
        if (i < 0 || !buy(c, copy, i)) return -Infinity;
      }
    }
    nextRound(c);
    if (c.over) return -Infinity;

    const ev = this.ev;
    const saved = ev.opts.budget;
    (ev.opts as { budget: number }).budget = this.shopBudget;
    let value: number;
    try {
      // 1. WHERE WOULD IT SIT? A machine is bought onto the END of the line, which
      //    is usually the wrong place for it, and the line gets reordered before
      //    that round is played. Pricing a purchase where it lands rather than
      //    where it would sit undervalues every machine whose job is to run early.
      ev.begin(c);
      let line = c.line;
      const opening = searchShipment(ev, c, line, FAST_SEARCH);
      if (line.length > 1 && opening.best.length > 0) {
        const k = ev.samplesFor(line);
        let bestPlacement = ev.score(opening.best, line, k);
        for (let from = 0; from < c.line.length && !ev.exhausted; from++) {
          const rest = c.line.slice();
          const [m] = rest.splice(from, 1);
          for (let pos = 0; pos <= rest.length; pos++) {
            if (pos === from) continue;
            const cand = rest.slice(0, pos);
            cand.push(m);
            for (let t = pos; t < rest.length; t++) cand.push(rest[t]);
            const v = ev.score(opening.best, cand, k);
            if (v > bestPlacement) { bestPlacement = v; line = cand; }
          }
        }
      }

      // 2. WHAT IS IT WORTH? Average over several hands out of the resulting
      //    crate, not just the one `nextRound` dealt. Purchases that CHANGE THE
      //    CRATE (parts, and blueprints that add parts) reshuffle the deal, so a
      //    single-hand valuation compares them against the baseline on a different
      //    hand and prices pure noise — the planner bought a 1-credit Dust six
      //    times in a row before this was fixed. The sampling seeds are shared by
      //    every candidate at this shop, so the comparison stays on common random
      //    numbers.
      let total = 0;
      let counted = 0;
      for (let h = 0; h < SHOP_HANDS; h++) {
        if (h > 0) {
          sampleHand(c, (seed + h * 0x27d4eb2f) >>> 0);
          ev.begin(c);
        }
        if (c.hand.length === 0) continue;
        total += h === 0 && line === c.line
          ? opening.bestScore
          : searchShipment(ev, c, line, FAST_SEARCH).bestScore;
        counted++;
      }
      const mean = counted > 0 ? total / counted : 0;
      // Credits the line itself pays (invisible to previewShipment — see
      // credits.ts), priced in the same units as the spend penalty so the two
      // sides of the economy are on one scale.
      const paid = lineCreditYield(c.line) * c.shipmentsLeft;
      value = (mean * c.shipmentsLeft) / Math.max(1, c.quota) + this.creditWeight * paid;
    } finally {
      (ev.opts as { budget: number }).budget = saved;
    }
    return value;
  }

  /**
   * Shop policy.
   *
   * Purchases are taken one at a time, each priced one round ahead. Singles alone
   * are not enough: a LINE SLOT is worth exactly nothing on its own — it changes no
   * machine and no hand — so a bot that only prices single purchases will never buy
   * one, will cap out at four machines on shift one, and will sit on eighty unspent
   * credits by shift five. That is not a finding about the game, it is a hole in
   * the bot, and it is the kind of hole that makes a deep game measure shallow.
   *
   * So candidates whose own value is zero or negative are re-priced PAIRED with the
   * best few other items in the shop, and the pair's value is charged the pair's
   * cost. The bot still commits to one purchase at a time and re-plans, so this is
   * an enabling-move fix, not a purchase-sequence search — sequences are the
   * oracle's job (G1.6).
   */
  chooseShop(s: RunState, shop: Shop): ShopAction {
    const options = affordable(s, shop);
    if (options.length === 0) return { kind: 'done' };

    // ONE HAND-AUTHORED PRIOR, DISCLOSED RATHER THAN HIDDEN.
    //
    // A line slot is the only purchase whose entire value is in a LATER shop: it
    // changes no machine, no part and no hand, so one ply of lookahead prices it
    // at exactly zero and the pair trick above only rescues it when slot + machine
    // are affordable in the same shop, which at 10c + 8c almost never happens
    // early. Left alone, the planner caps at four machines for the whole run,
    // stalls around shift 5, and the game measures far shallower than it is —
    // which is precisely the failure mode the integrity constraint warns about.
    //
    // So: when the line is FULL and capacity is affordable, take it. This is a
    // prior about TAKT ("capacity is the scaling resource"), not a search result,
    // and it is the only one in this file. Its measured effect is reported.
    if (s.line.length >= s.lineCap) {
      for (const i of options) if (shop.items[i].kind === 'lineslot') return { kind: 'buy', index: i };
    }
    const seed = (this.rolloutBase
      + s.shift * 0x9e3779b1 + s.round * 0x85ebca6b + s.credits * 0xc2b2ae35) >>> 0;
    const base = this.lookahead(s, shop, [], seed);
    if (!Number.isFinite(base)) return { kind: 'done' };

    const singles = options.map((i) => {
      const item = shop.items[i];
      const v = this.lookahead(s, shop, [item], seed);
      const gain = Number.isFinite(v) ? v - base - this.creditWeight * item.cost : -Infinity;
      return { i, item, gain };
    });

    let bestIdx = -1;
    let bestGain = 0;
    for (const c of singles) if (c.gain > bestGain) { bestGain = c.gain; bestIdx = c.i; }

    // Enabling moves: anything worthless alone, priced with a partner.
    //
    // The partner list is EVERY item in the shop, not just the ones that are legal
    // right now. That is the whole point: when the line is full, the machines are
    // exactly the items `affordable` rejects, and they are exactly what a line slot
    // is for. `lookahead` returns -Infinity if the pair does not go through, so
    // illegal pairs cost one clone and price themselves out.
    const gainOf = new Map<ShopItem, number>();
    for (const c of singles) gainOf.set(c.item, c.gain);
    const partners = shop.items.slice().sort((a, b) => {
      const ga = gainOf.has(a) ? (gainOf.get(a) as number) : Infinity;
      const gb = gainOf.has(b) ? (gainOf.get(b) as number) : Infinity;
      return gb - ga;  // untried (currently illegal) items first: those are the point
    });
    let pairsLeft = PAIR_BUDGET;
    for (const c of singles) {
      if (c.gain > 0 || pairsLeft <= 0) continue;
      let tried = 0;
      for (const p of partners) {
        if (p === c.item || tried >= PAIR_PARTNERS || pairsLeft <= 0) continue;
        if (c.item.cost + p.cost > s.credits) continue;
        tried++;
        pairsLeft--;
        const v = this.lookahead(s, shop, [c.item, p], seed);
        if (!Number.isFinite(v)) continue;
        const gain = v - base - this.creditWeight * (c.item.cost + p.cost);
        if (gain > bestGain) { bestGain = gain; bestIdx = c.i; }
      }
    }

    if (bestIdx >= 0) return { kind: 'buy', index: bestIdx };
    // Nothing on the shelf is worth buying. Rerolling is, as long as the reroll
    // leaves enough behind to act on what it turns up.
    if (s.credits >= shop.rerollCost * REROLL_RESERVE) return { kind: 'reroll' };
    return { kind: 'done' };
  }

  /**
   * A cheap in-round line refinement, run before every shipment.
   *
   * The round-start reorder is solved against the hand dealt at the round's start;
   * four shipments later the hand is different and, on an Audit round, the answer
   * can be different too. `reorderLine` is free and legal at any time, so a player
   * who cares will nudge the line between shipments — and a planner that does not
   * is weaker than the tier it is supposed to stand for. This is a WARM-STARTED
   * single swap-descent pass from the current order against a handful of probes,
   * about a tenth the cost of the round-start search, not a re-solve.
   */
  refineLine(s: RunState): number[] | null {
    if (s.line.length < 2 || s.hand.length === 0) return null;
    const ev = this.ev;
    const saved = ev.opts.budget;
    (ev.opts as { budget: number }).budget = this.refineBudget;
    ev.begin(s);
    try {
      const cfg: SearchConfig = { ...this.cfg, lineProbes: REFINE_PROBES, linePasses: 1 };
      // Probes come from the CHEAP search, not the planner's own. Building them
      // with the full screen costs more than the refinement it feeds — 500 previews
      // to save 100 — and a probe only has to be a plausible shipment, not the
      // best one.
      const probes = lineProbes(ev, s, s.line, { ...FAST_SEARCH, lineProbes: REFINE_PROBES });
      const res = searchLine(ev, s, s.line, probes, cfg);
      let moved = false;
      for (let i = 0; i < res.perm.length; i++) if (res.perm[i] !== i) moved = true;
      return moved ? res.perm : null;
    } finally {
      (ev.opts as { budget: number }).budget = saved;
      this.cachedSig = '';   // the line moved; the shipment cache is stale
      this.cached = null;
    }
  }

  // -- reorder ------------------------------------------------------------

  /**
   * The line search runs from the ARRIVAL order, not from wherever the line
   * happens to be sitting. Two reasons, one practical and one for the gate:
   * starting from the current order would warm-start the hill climb into last
   * round's answer and hide real restructuring (G2.4), and G2.1 is DEFINED as the
   * gain over arrival order, so the baseline has to be the arrival order.
   */
  chooseReorder(s: RunState, arrival: Machine[]): ReorderDecision | null {
    if (arrival.length < 2 || s.hand.length === 0) return null;
    const ev = this.ev;
    const saved = ev.opts.budget;
    (ev.opts as { budget: number }).budget = this.lineBudget;
    ev.begin(s);
    try {
      const probes = lineProbes(ev, s, arrival, this.cfg);
      const res = searchLine(ev, s, arrival, probes, this.cfg);
      const target = res.perm.map((i) => arrival[i]);
      const perm = target.map((m) => s.line.indexOf(m));
      if (perm.some((i) => i < 0)) return null;
      const gainPct = res.baseScore > 0
        ? ((res.score - res.baseScore) / res.baseScore) * 100
        : NaN;
      return { perm, key: res.key, gainPct };
    } finally {
      (ev.opts as { budget: number }).budget = saved;
    }
  }
}

/**
 * Overwrite `c.hand` with a fresh sample from its crate. Used only inside the
 * lookahead clone — the parts are shared with the crate, which is safe because
 * `previewShipment` copies every part it touches.
 */
function sampleHand(c: RunState, seed: number): void {
  const rng = makeRng(seed);
  const pool = c.crate.slice();
  const n = Math.min(c.handSize, pool.length);
  for (let i = 0; i < n; i++) {
    const j = i + rng.int(pool.length - i);
    const t = pool[i]; pool[i] = pool[j]; pool[j] = t;
  }
  c.hand = pool.slice(0, n);
}
