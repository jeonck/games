// TAKT — the bot contract.
//
// A bot is a policy over the four decisions the engine exposes: what to ship, what
// to scrap, what to buy, and how to order the line. The harness owns the run loop
// and the telemetry; a bot owns nothing and mutates nothing. Every method is handed
// the live `RunState` READ-ONLY — the harness is the only thing that calls
// `playShipment` / `scrapParts` / `buy` / `reorderLine`.
//
// The split exists so that the four tiers differ ONLY in policy. If a tier ever
// needed a different run loop, the win-rate ladder would stop being a comparison
// between kinds of play and start being a comparison between harnesses.

import type { Machine, RunState } from '../engine/types.ts';
import type { Shop } from '../engine/api.ts';
import type { BotName } from '../sim/telemetry.ts';
import type { Evaluator } from './ev.ts';

export interface ShipmentDecision {
  /** ordered hand indices; handIndices[0] enters the line first */
  indices: number[];
  /** G6.1 sample: (best - secondBest) / best * 100. NaN when not searched. */
  marginPct: number;
  /** the same margin against the best DIFFERENT-SUBSET candidate. See search.ts. */
  subsetMarginPct: number;
  /** distinct ordered selections the bot scored to reach this. 0 for non-searchers. */
  evaluated: number;
}

export interface ReorderDecision {
  /** perm[i] = index in the CURRENT s.line of the machine that ends up at i */
  perm: number[];
  /** the optimal ordering as a machine-def sequence — the G2.2/G2.4 identity */
  key: string[];
  /** G2.1 sample: (bestPerm - arrivalOrder) / arrivalOrder * 100. NaN when unmeasured. */
  gainPct: number;
}

export type ShopAction =
  | { kind: 'buy'; index: number }
  | { kind: 'reroll' }
  | { kind: 'done' };

export interface Bot {
  readonly name: BotName;
  /** null for tiers that never call previewShipment. */
  readonly ev: Evaluator | null;

  /** Called once, before the first decision of a run. */
  startRun(s: RunState, seed: number): void;

  /** Never returns an empty selection: the engine requires 1..5 parts. */
  chooseShipment(s: RunState): ShipmentDecision;

  /** Hand indices to scrap, or null to keep the hand. Called until it returns null. */
  chooseScrap(s: RunState): number[] | null;

  /** Called repeatedly at one shop until it returns `done`. */
  chooseShop(s: RunState, shop: Shop): ShopAction;

  /**
   * Called before every shipment, after any scrapping. A cheap in-round
   * refinement of the line: the hand changes under the bot as parts are played and
   * redrawn, and `reorderLine` is free and legal at any time, so a player who has
   * noticed that will nudge the line mid-round. Returns null for tiers that do not.
   * Emits no G2 telemetry — G2.2/G2.4 are about the OPTIMAL ordering per round,
   * which is measured once, at the round's start, from the arrival order.
   */
  refineLine(s: RunState): number[] | null;

  /**
   * `arrival` is the line in ACQUISITION
   * order — the order the machines would sit in had the player never reordered —
   * which is the baseline G2.1 is defined against. Return null to leave the line
   * alone (and to emit no G2 sample).
   */
  chooseReorder(s: RunState, arrival: Machine[]): ReorderDecision | null;
}
