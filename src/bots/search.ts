// TAKT — the bounded searches the planner and oracle are built from.
//
// Two spaces, both too large to enumerate:
//
//   ORDERED SELECTIONS. A hand of 8 with shipments of 1..5 parts is
//   sum_k P(8,k) = 8 + 56 + 336 + 1680 + 6720 = 8,800 ordered selections, and the
//   planner faces one of these ~96 times per run. Exhaustive search is ~9x over
//   the whole per-run time budget on its own. What we do instead: enumerate all
//   218 SUBSETS exactly (that part is cheap and complete), screen each in two
//   cheap orders, then spend the ordering search only on the best few subsets,
//   using best-insertion plus swap descent rather than permutation enumeration.
//   `SearchResult.evaluated` reports what that actually covered; the harness
//   aggregates it and `docs/bench/RESULTS.md` prints it, because a planner that
//   samples 1% of the space is not the "skilled human" the gate assumes it is.
//
//   LINE PERMUTATIONS. Up to 8! = 40,320, faced 24 times per run (once per shop).
//   Bounded pairwise-swap hill climb from the current order, scored against a
//   fixed probe set of plausible shipments so that two permutations are compared
//   on the same work rather than on two independent re-searches.
//
// Everything here goes through `Evaluator.score`, so every number in this file is
// already an expectation over rng streams the realised shipment will not use. No
// search in this file can fish a coin flip.

import type { Machine, RunState } from '../engine/types.ts';
import { PARTS_PER_SHIPMENT } from '../engine/types.ts';
import type { Evaluator } from './ev.ts';

export interface SearchConfig {
  /** hand parts considered. 8 -> 218 subsets; the subset count is 2^poolCap-ish. */
  poolCap: number;
  /** orders each subset is screened in: 1 = heaviest-first only, 2 = both directions. */
  screenOrders: number;
  /** subsets that get a real ordering search, best-screened first. */
  deepSubsets: number;
  /** swap-descent passes per subset. */
  swapPasses: number;
  /** candidates re-scored at full rng-sample count before the pick. */
  finalists: number;
  /** probes used to price one line permutation. */
  lineProbes: number;
  /** swap-descent passes over line permutations. */
  linePasses: number;
}

export const PLANNER_SEARCH: SearchConfig = {
  poolCap: 8, screenOrders: 2, deepSubsets: 10, swapPasses: 2, finalists: 8,
  lineProbes: 8, linePasses: 3,
};

/**
 * Used inside lookahead rollouts, where a single shop decision simulates dozens of
 * shipments. Roughly 1/10th the cost of PLANNER_SEARCH and visibly weaker; the
 * oracle's advantage has to come from looking FURTHER, not from looking harder in
 * the rollout than it can afford to.
 */
export const FAST_SEARCH: SearchConfig = {
  poolCap: 5, screenOrders: 1, deepSubsets: 1, swapPasses: 1, finalists: 1,
  lineProbes: 3, linePasses: 1,
};

export interface SearchResult {
  /** ordered hand indices, ready for playShipment */
  best: number[];
  bestScore: number;
  /** best score among candidates that are a DIFFERENT ordered selection, or NaN */
  secondScore: number;
  /** (best - second) / best * 100, or NaN when there is no second candidate */
  marginPct: number;
  /** distinct ordered selections scored */
  evaluated: number;
  /** the top orderings found, best first — reused as line-search probes */
  top: number[][];
}

const EMPTY: SearchResult = {
  best: [], bestScore: 0, secondScore: NaN, marginPct: NaN, evaluated: 0, top: [],
};

function popcount(x: number): number {
  let n = 0;
  for (let v = x; v !== 0; v &= v - 1) n++;
  return n;
}

/**
 * Which hand parts are worth considering. Under the default hand of 8 this is all
 * of them and the subset enumeration below is EXACT. Blueprints can push the hand
 * to 14, where 2^14 subsets is not affordable; then we keep the parts with the
 * best solo contribution plus the two worst — the worst are kept deliberately,
 * because "drop the lowest part" machines make a bad part a resource, and a pool
 * chosen purely by value would hide that line of play from the planner.
 */
function choosePool(ev: Evaluator, s: RunState, line: Machine[], k: number, cap: number): number[] {
  const n = s.hand.length;
  if (n <= cap) {
    const all: number[] = new Array(n);
    for (let i = 0; i < n; i++) all[i] = i;
    return all;
  }
  const solo: { i: number; v: number }[] = new Array(n);
  for (let i = 0; i < n; i++) solo[i] = { i, v: ev.score([i], line, 1) };
  solo.sort((a, b) => b.v - a.v);
  const keep = new Set<number>();
  for (let j = 0; j < cap - 2 && j < solo.length; j++) keep.add(solo[j].i);
  for (let j = solo.length - 1; j >= 0 && keep.size < cap; j--) keep.add(solo[j].i);
  return [...keep].sort((a, b) => a - b);
}

function insertionOrder(s: RunState, members: number[]): number[] {
  return members.slice().sort((a, b) => {
    const pa = s.hand[a];
    const pb = s.hand[b];
    return pb.value * pb.mult - pa.value * pa.mult;
  });
}

/** Best-insertion construction followed by swap descent. */
function orderSearch(
  ev: Evaluator, s: RunState, line: Machine[], k: number,
  members: number[], cfg: SearchConfig,
): { order: number[]; score: number } {
  const seq = insertionOrder(s, members);
  let cur = [seq[0]];
  let best = ev.score(cur, line, k);

  for (let m = 1; m < seq.length; m++) {
    const part = seq[m];
    let bestOrder = cur;
    let bestScore = -Infinity;
    for (let pos = 0; pos <= cur.length; pos++) {
      const cand = cur.slice(0, pos);
      cand.push(part);
      for (let t = pos; t < cur.length; t++) cand.push(cur[t]);
      const v = ev.score(cand, line, k);
      if (v > bestScore) { bestScore = v; bestOrder = cand; }
    }
    cur = bestOrder;
    best = bestScore;
  }

  for (let pass = 0; pass < cfg.swapPasses; pass++) {
    let improved = false;
    for (let i = 0; i < cur.length - 1; i++) {
      for (let j = i + 1; j < cur.length; j++) {
        const cand = cur.slice();
        const t = cand[i]; cand[i] = cand[j]; cand[j] = t;
        const v = ev.score(cand, line, k);
        if (v > best) { best = v; cur = cand; improved = true; }
      }
    }
    if (!improved) break;
  }
  return { order: cur, score: best };
}

/**
 * The planner's per-shipment decision.
 *
 * Phase 1 screens every subset of the pool in two cheap orders (descending and
 * ascending by value*mult). Phase 2 runs the ordering search on the best
 * `deepSubsets`. Phase 3 re-scores the finalists at the full rng-sample count and
 * picks the mean-best — never the best case.
 */
export function searchShipment(
  ev: Evaluator, s: RunState, line: Machine[], cfg: SearchConfig,
): SearchResult {
  const n = s.hand.length;
  if (n === 0) return EMPTY;
  const before = ev.evaluations;
  const k1 = 1;
  const kFull = ev.samplesFor(line);

  const pool = choosePool(ev, s, line, k1, cfg.poolCap);
  const p = pool.length;
  const maxParts = Math.min(PARTS_PER_SHIPMENT, p);

  // --- phase 1: every subset, two orders ---------------------------------
  const screened: { mask: number; order: number[]; score: number }[] = [];
  for (let mask = 1; mask < (1 << p); mask++) {
    const size = popcount(mask);
    if (size > maxParts) continue;
    const members: number[] = [];
    for (let b = 0; b < p; b++) if (mask & (1 << b)) members.push(pool[b]);
    const desc = insertionOrder(s, members);
    let order = desc;
    let score = ev.score(desc, line, k1);
    if (size > 1 && cfg.screenOrders > 1) {
      const asc = desc.slice().reverse();
      const v = ev.score(asc, line, k1);
      if (v > score) { score = v; order = asc; }
    }
    screened.push({ mask, order, score });
    if (ev.exhausted) { ev.noteBudgetHit(); break; }
  }
  if (screened.length === 0) return EMPTY;
  screened.sort((a, b) => b.score - a.score);

  // --- phase 2: ordering search on the best subsets ----------------------
  const deep = Math.min(cfg.deepSubsets, screened.length);
  const cands: { order: number[]; score: number }[] = [];
  let deepDone = 0;
  for (let i = 0; i < deep; i++) {
    if (i > 0 && ev.exhausted) { ev.noteBudgetHit(); break; }
    const members: number[] = [];
    for (let b = 0; b < p; b++) if (screened[i].mask & (1 << b)) members.push(pool[b]);
    cands.push(orderSearch(ev, s, line, k1, members, cfg));
    deepDone++;
  }
  for (let i = deepDone; i < screened.length; i++) {
    cands.push({ order: screened[i].order, score: screened[i].score });
  }
  cands.sort((a, b) => b.score - a.score);

  // --- phase 3: re-rank the finalists at full sample count ---------------
  const fin = Math.min(cfg.finalists, cands.length);
  const finalists = cands.slice(0, fin);
  if (kFull > 1) {
    for (const c of finalists) c.score = ev.score(c.order, line, kFull);
    finalists.sort((a, b) => b.score - a.score);
  }

  const best = finalists[0];
  const second = finalists.length > 1 ? finalists[1] : undefined;
  const secondScore = second !== undefined ? second.score : NaN;
  const marginPct = second !== undefined && best.score > 0
    ? ((best.score - second.score) / best.score) * 100
    : NaN;

  const top: number[][] = [];
  const seen = new Set<string>();
  for (const c of cands) {
    const key = c.order.join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    top.push(c.order);
    if (top.length >= 16) break;
  }

  return {
    best: best.order,
    bestScore: best.score,
    secondScore,
    marginPct,
    evaluated: ev.evaluations - before,
    top,
  };
}

// ---------------------------------------------------------------------------
// line permutations
// ---------------------------------------------------------------------------

export interface LineResult {
  /** perm[i] = index in `line` of the machine that ends up at position i */
  perm: number[];
  score: number;
  /** score of the line exactly as handed in */
  baseScore: number;
  evaluated: number;
  /** the machine defs in optimal order — the identity G2.2/G2.4 compare */
  key: string[];
}

function permute(line: Machine[], perm: number[]): Machine[] {
  const out: Machine[] = new Array(perm.length);
  for (let i = 0; i < perm.length; i++) out[i] = line[perm[i]];
  return out;
}

/**
 * Build the probe set a line permutation is priced against: plausible shipments
 * out of the current hand. Held FIXED across the hill climb so that two
 * permutations are compared on identical work — re-searching per permutation
 * would make the comparison dominated by search noise.
 */
export function lineProbes(
  ev: Evaluator, s: RunState, line: Machine[], cfg: SearchConfig,
): number[][] {
  const res = searchShipment(ev, s, line, {
    ...cfg, deepSubsets: Math.min(2, cfg.deepSubsets), finalists: 1,
  });
  const out: number[][] = [];
  for (const order of res.top) {
    out.push(order);
    if (out.length >= cfg.lineProbes) break;
    if (order.length > 1) {
      out.push(order.slice().reverse());
      if (out.length >= cfg.lineProbes) break;
    }
  }
  return out.length > 0 ? out : [[0]];
}

/** Value of a permutation: the best shipment among the fixed probes. */
function lineValue(
  ev: Evaluator, line: Machine[], perm: number[], probes: number[][], k: number,
): number {
  const l = permute(line, perm);
  let best = -Infinity;
  for (const probe of probes) {
    const v = ev.score(probe, l, k);
    if (v > best) best = v;
  }
  return best;
}

/**
 * Bounded pairwise-swap hill climb over line permutations, from the identity.
 * Returns the best permutation found and the value of the identity, so the caller
 * can report G2.1 (`(best - base) / base`).
 */
export function searchLine(
  ev: Evaluator, s: RunState, line: Machine[], probes: number[][], cfg: SearchConfig,
): LineResult {
  const len = line.length;
  const before = ev.evaluations;
  const identity: number[] = new Array(len);
  for (let i = 0; i < len; i++) identity[i] = i;
  const k = ev.samplesFor(line);

  if (len < 2) {
    return {
      perm: identity, score: len === 0 ? 0 : lineValue(ev, line, identity, probes, k),
      baseScore: len === 0 ? 0 : lineValue(ev, line, identity, probes, k),
      evaluated: ev.evaluations - before, key: line.map((m) => m.def),
    };
  }

  const baseScore = lineValue(ev, line, identity, probes, k);
  let cur = identity;
  let best = baseScore;

  for (let pass = 0; pass < cfg.linePasses; pass++) {
    let improved = false;
    for (let i = 0; i < len - 1; i++) {
      for (let j = i + 1; j < len; j++) {
        if (ev.exhausted) { ev.noteBudgetHit(); improved = false; i = len; break; }
        const cand = cur.slice();
        const t = cand[i]; cand[i] = cand[j]; cand[j] = t;
        const v = lineValue(ev, line, cand, probes, k);
        if (v > best + 1e-9) { best = v; cur = cand; improved = true; }
      }
    }
    if (!improved) break;
  }

  return {
    perm: cur,
    score: best,
    baseScore,
    evaluated: ev.evaluations - before,
    key: permute(line, cur).map((m) => m.def),
  };
}
