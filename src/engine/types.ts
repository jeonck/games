// TAKT — frozen contract. Every agent builds against this file.
// Changing anything here is a spec change, not an implementation decision.

export type Tag = 'metal' | 'organic' | 'volatile' | 'precision' | 'scrap';

export const ALL_TAGS: Tag[] = ['metal', 'organic', 'volatile', 'precision', 'scrap'];

export type Rarity = 'common' | 'uncommon' | 'rare' | 'legendary';

export type Archetype =
  | 'arithmetic'
  | 'positional'
  | 'filter'
  | 'generative'
  | 'conditional'
  | 'economic'
  | 'transmutation';

export const ALL_ARCHETYPES: Archetype[] = [
  'arithmetic', 'positional', 'filter', 'generative',
  'conditional', 'economic', 'transmutation',
];

export interface Part {
  id: string;
  def: string;
  value: number;
  tags: Tag[];
  mult: number;
  sticky?: boolean;
}

/** Ordered. Position is meaningful — machines read first/last/highest. */
export type Batch = Part[];

export interface RNG {
  /** float in [0,1) */
  next(): number;
  /** integer in [0,n) */
  int(n: number): number;
  pick<T>(xs: readonly T[]): T;
  /** returns a new shuffled array; does not mutate input */
  shuffle<T>(xs: readonly T[]): T[];
  fork(): RNG;
}

/** Read-only view of the run handed to machine.apply(). */
export interface RunCtx {
  rng: RNG;
  shift: number;
  round: number;
  quota: number;
  score: number;
  shipmentIndex: number;   // 0-based, which shipment of this round
  lineCap: number;
  handSize: number;
  credits: number;
  /** Mutable scratch owned by machines; cleared at round start. */
  memo: Record<string, number>;
  /** Machines may award credits mid-shipment (economic archetype). */
  grantCredits(n: number): void;
}

export interface MachineDef {
  def: string;
  name: string;
  archetype: Archetype;
  rarity: Rarity;
  cost: number;
  /** short player-facing rule text, level-parameterised */
  text: (level: number) => string;
  /** Pure. MUST NOT mutate `batch` or any Part in it. Return a new array. */
  apply: (batch: Batch, ctx: RunCtx, level: number) => Batch;
}

export interface Machine {
  id: string;
  def: string;
  level: number;
}

export interface BlueprintDef {
  def: string;
  name: string;
  text: string;
  /** applied once at run start / round start; mutates RunState by design */
  onRoundStart?: (s: RunState) => void;
}

export interface Blueprint {
  id: string;
  def: string;
}

export interface RunState {
  seed: number;
  rng: RNG;
  shift: number;          // 1..8
  round: number;          // 1..3
  quota: number;
  score: number;
  shipmentsLeft: number;
  scrapsLeft: number;
  credits: number;
  line: Machine[];
  lineCap: number;
  crate: Part[];
  drawPile: Part[];
  hand: Part[];
  discard: Part[];
  blueprints: Blueprint[];
  handSize: number;
  over: boolean;
  won: boolean;
  /** decisions taken this run — used by G7 session-shape metric */
  decisions: number;
}

export const PARTS_PER_SHIPMENT = 5;
export const SHIPMENTS_PER_ROUND = 4;
export const SCRAPS_PER_ROUND = 3;
export const ROUNDS_PER_SHIFT = 3;
export const SHIFTS_PER_RUN = 8;
export const BASE_HAND_SIZE = 8;
export const BASE_LINE_CAP = 4;
export const MAX_LINE_CAP = 8;

/** score(batch) = floor(sum(value * mult)), floored at 0 */
export function scoreBatch(batch: Batch): number {
  let t = 0;
  for (const p of batch) t += p.value * p.mult;
  return Math.max(0, Math.floor(t));
}
