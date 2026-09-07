// TAKT — "play the best hand you can see, right now".
//
// Greedy is the honest proxy for a player who understands the scoring but not the
// line: it enumerates every subset of the hand and ships the one that scores best
// IN ONE FIXED ORDER (heaviest part first). It never searches orderings, never
// reorders the line, never looks past the current shipment, and buys the cheapest
// machine it can afford — the spec's policy, verbatim.
//
// It goes through the same `Evaluator` as the planner, so it is subject to the
// rng-fishing fix too. That is not optional. Greedy cannot fish (it searches no
// orderings) but it can CONDITION: shipping into a Wildcard whose coin it has
// already seen is worth a great deal, and a greedy tier that got that for free
// while the planner paid expectations would compress G1.5 for a reason that has
// nothing to do with how the game plays.
//
// What greedy is missing, and therefore what G1.5 measures: ordering inside the
// shipment, ordering of the line, and any notion of what a purchase is FOR.

import type { Machine, RunState } from '../engine/types.ts';
import { PARTS_PER_SHIPMENT } from '../engine/types.ts';
import type { Shop } from '../engine/api.ts';
import { Evaluator } from './ev.ts';
import type { EvOptions } from './ev.ts';
import type { Bot, ReorderDecision, ShipmentDecision, ShopAction } from './types.ts';
import { affordable } from './shop.ts';

/** Hand parts considered, worst-first-truncated. 8 -> all 218 subsets. */
const POOL_CAP = 8;

function heaviestFirst(s: RunState, members: number[]): number[] {
  return members.slice().sort((a, b) => {
    const pa = s.hand[a];
    const pb = s.hand[b];
    return pb.value * pb.mult - pa.value * pa.mult;
  });
}

export class GreedyBot implements Bot {
  readonly name = 'greedy' as const;
  readonly ev: Evaluator;
  private cachedSig = '';
  private cached: ShipmentDecision | null = null;

  constructor(ev: Partial<EvOptions> = {}) {
    this.ev = new Evaluator(ev);
  }

  startRun(_s: RunState, _seed: number): void {
    this.ev.startRun();
    this.cachedSig = '';
    this.cached = null;
  }

  private sig(s: RunState): string {
    let out = `${s.shift}.${s.round}.${s.shipmentsLeft}.${s.scrapsLeft}|`;
    for (const p of s.hand) out += `${p.id};`;
    return out;
  }

  private search(s: RunState): ShipmentDecision {
    const sig = this.sig(s);
    if (this.cached !== null && this.cachedSig === sig) return this.cached;
    this.ev.begin(s);
    const line = s.line;
    const k = this.ev.samplesFor(line);
    const n = Math.min(POOL_CAP, s.hand.length);
    const maxParts = Math.min(PARTS_PER_SHIPMENT, n);

    let best: number[] = [0];
    let bestScore = -Infinity;
    let evaluated = 0;
    for (let mask = 1; mask < (1 << n); mask++) {
      let size = 0;
      for (let v = mask; v !== 0; v &= v - 1) size++;
      if (size > maxParts) continue;
      const members: number[] = [];
      for (let b = 0; b < n; b++) if (mask & (1 << b)) members.push(b);
      const order = heaviestFirst(s, members);
      const v = this.ev.score(order, line, k);
      evaluated++;
      if (v > bestScore) { bestScore = v; best = order; }
    }
    // Greedy does not compute a runner-up: G6.1 is read off the planner tier, and
    // emitting a margin from a one-order search would describe the search, not the
    // decision. Cheap tiers emit no G6 samples by design (see gate.ts).
    const out: ShipmentDecision = {
      indices: best, marginPct: NaN, subsetMarginPct: NaN, evaluated,
    };
    this.cachedSig = sig;
    this.cached = out;
    return out;
  }

  chooseShipment(s: RunState): ShipmentDecision {
    return this.search(s);
  }

  chooseScrap(s: RunState): number[] | null {
    if (s.scrapsLeft <= 0 || s.hand.length <= PARTS_PER_SHIPMENT) return null;
    const need = s.quota - s.score;
    if (need <= 0 || s.shipmentsLeft <= 0) return null;
    this.ev.begin(s);
    const k = this.ev.samplesFor(s.line);
    const best = this.search(s);
    const pace = need / s.shipmentsLeft;
    if (this.ev.score(best.indices, s.line, k) >= pace) return null;
    // Dump what the best shipment does not use, worst first.
    const keep = new Set(best.indices);
    const rest: number[] = [];
    for (let i = 0; i < s.hand.length; i++) if (!keep.has(i)) rest.push(i);
    rest.sort((a, b) => s.hand[a].value * s.hand[a].mult - s.hand[b].value * s.hand[b].mult);
    const take = rest.slice(0, Math.min(3, rest.length));
    return take.length > 0 ? take : null;
  }

  chooseShop(s: RunState, shop: Shop): ShopAction {
    let bestIdx = -1;
    let bestCost = Infinity;
    for (const i of affordable(s, shop)) {
      const it = shop.items[i];
      if (it.kind !== 'machine') continue;
      if (it.cost < bestCost) { bestCost = it.cost; bestIdx = i; }
    }
    return bestIdx >= 0 ? { kind: 'buy', index: bestIdx } : { kind: 'done' };
  }

  refineLine(_s: RunState): number[] | null {
    return null;
  }

  chooseReorder(_s: RunState, _arrival: Machine[]): ReorderDecision | null {
    return null;
  }
}
