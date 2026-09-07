// TAKT — the floor of the ladder.
//
// Legal random play, and nothing else: a random-size, randomly ordered, legal
// shipment; a random affordable purchase; occasional random scrapping; never a
// reorder. It calls `previewShipment` zero times, which is the point — G1.1 asks
// what the game gives a player who is not thinking, and any evaluation at all
// would stop it answering that question.
//
// Its rng is its own (derived from the run seed), never `s.rng`: drawing from the
// run's stream would change the cards the run deals and make the four tiers play
// different games on the same seed.

import type { Machine, RNG, RunState } from '../engine/types.ts';
import { PARTS_PER_SHIPMENT } from '../engine/types.ts';
import { makeRng } from '../engine/rng.ts';
import type { Shop } from '../engine/api.ts';
import type { Bot, ReorderDecision, ShipmentDecision, ShopAction } from './types.ts';
import { affordable } from './shop.ts';

/** Chance of burning a scrap on a random slice of the hand, per opportunity. */
const SCRAP_CHANCE = 0.25;
/** Chance of taking another random affordable item at the same shop. */
const BUY_CHANCE = 0.6;

export class RandomBot implements Bot {
  readonly name = 'random' as const;
  readonly ev = null;
  private rng: RNG = makeRng(1);

  startRun(_s: RunState, seed: number): void {
    this.rng = makeRng((seed ^ 0x5f356495) >>> 0);
  }

  chooseShipment(s: RunState): ShipmentDecision {
    const n = s.hand.length;
    const size = 1 + this.rng.int(Math.min(PARTS_PER_SHIPMENT, n));
    const pool: number[] = new Array(n);
    for (let i = 0; i < n; i++) pool[i] = i;
    const shuffled = this.rng.shuffle(pool);
    return { indices: shuffled.slice(0, size), marginPct: NaN, evaluated: 0 };
  }

  chooseScrap(s: RunState): number[] | null {
    if (s.scrapsLeft <= 0 || s.hand.length === 0) return null;
    if (this.rng.next() >= SCRAP_CHANCE) return null;
    const n = s.hand.length;
    const pool: number[] = new Array(n);
    for (let i = 0; i < n; i++) pool[i] = i;
    return this.rng.shuffle(pool).slice(0, 1 + this.rng.int(n));
  }

  chooseShop(s: RunState, shop: Shop): ShopAction {
    const options = affordable(s, shop);
    if (options.length === 0) return { kind: 'done' };
    if (this.rng.next() >= BUY_CHANCE) return { kind: 'done' };
    return { kind: 'buy', index: this.rng.pick(options) };
  }

  chooseReorder(_s: RunState, _arrival: Machine[]): ReorderDecision | null {
    return null;
  }
}
