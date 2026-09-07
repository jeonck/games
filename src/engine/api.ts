// TAKT — frozen engine API. Implemented in run.ts. Bots and UI call only these.
import type { RunState, Machine, Batch, Part } from './types.ts';

export interface ShipmentResult {
  /** batch as it exits each machine, index 0 = batch entering machine 0 */
  stages: Batch[];
  gained: number;
  scoreAfter: number;
  cleared: boolean;
}

export interface ShopItem {
  kind: 'machine' | 'part' | 'blueprint' | 'lineslot' | 'upgrade';
  def: string;
  cost: number;
  /** for 'upgrade': index into state.line */
  target?: number;
}

export interface Shop { items: ShopItem[]; rerollCost: number; }

/** Fresh run. Deterministic in `seed`. */
export declare function newRun(seed: number): RunState;

/** Quota for a given shift/round. Monotonic in both. */
export declare function quotaFor(shift: number, round: number): number;

/**
 * Pure evaluation. Does not mutate `s`. `line` overrides s.line when given —
 * this is how bots price a candidate reordering.
 */
export declare function previewShipment(
  s: RunState, handIndices: number[], line?: Machine[],
): ShipmentResult;

/** Ordered selection: handIndices[0] is the first part in the batch. */
export declare function playShipment(s: RunState, handIndices: number[]): ShipmentResult;

export declare function scrapParts(s: RunState, handIndices: number[]): void;

/** `perm` is a permutation of 0..line.length-1. Free, always legal. */
export declare function reorderLine(s: RunState, perm: number[]): void;

export declare function rollShop(s: RunState): Shop;
export declare function buy(s: RunState, shop: Shop, itemIndex: number): boolean;
export declare function reroll(s: RunState, shop: Shop): Shop;

/** Advance past the shop into the next round/shift, or finish the run. */
export declare function nextRound(s: RunState): void;

/** True when the round's quota is met. */
export declare function roundCleared(s: RunState): boolean;
