// TAKT — engine core. Implements every declaration in `api.ts`.
//
// Two rules govern this file:
//   1. `previewShipment` is PURE. It never mutates `s`, never mutates a Part that
//      `s` owns, never advances `s.rng`, never touches credits or the live machine
//      memo. Bots call it ~10^8 times per benchmark; a hidden mutation silently
//      corrupts every number the project produces.
//   2. `previewShipment` is the hot path. Budget is 3us for a 5-part batch through
//      an 8-machine line. It allocates only what the contract forces it to
//      (the copied entry parts and the `stages` array); the RunCtx, its RNG and the
//      memo scratch are pooled and reused.

import type { Batch, Machine, Part, RNG, RunCtx, RunState, Rarity } from './types.ts';
import {
  BASE_HAND_SIZE, BASE_LINE_CAP, MAX_LINE_CAP, PARTS_PER_SHIPMENT,
  ROUNDS_PER_SHIFT, SCRAPS_PER_ROUND, SHIFTS_PER_RUN, SHIPMENTS_PER_ROUND,
  scoreBatch,
} from './types.ts';
import { makeRng } from './rng.ts';
import type { ShipmentResult, Shop, ShopItem } from './api.ts';
import type { PartDef, Registry } from '../content/registry.ts';
import { getRegistry } from '../content/registry.ts';

// ---------------------------------------------------------------------------
// Tuning constants. These are the dials the benchmark loop turns; everything
// else in this file is mechanism, not tuning.
// ---------------------------------------------------------------------------

/**
 * QUOTA CURVE.  quota(shift, round) = BASE * GROWTH^(shift-1) * ROUND_MULT[round-1]
 *
 * Reasoning:
 *  - GROWTH = 1.6 per shift compounds to 26.8x across the 8 shifts. That is steep
 *    enough that flat-additive builds die around shift 4-5 (they scale linearly)
 *    while multiplicative builds keep pace — which is exactly the pressure that
 *    forces the player from "add value" into "build an engine", and is what makes
 *    G1.5 (planner >= 2.5x greedy) reachable.
 *  - ROUND_MULT = [1, 1.5, 2.4] makes round 3 (the Audit) 2.4x round 1, so the boss
 *    is a real wall inside the shift rather than a formality, while the two Order
 *    rounds before it are the ramp that lets you buy the answer to it.
 *  - Deliberately NOT monotonic across the shift boundary (shift N round 3 = 2.4x
 *    base is above shift N+1 round 1 = 1.6x base). That dip is the breather after a
 *    boss; without it every round is a boss and G4.2/G4.3 (losses must not pile up
 *    in one shift) get harder, not easier. `quotaFor` is monotonic in each argument
 *    with the other held fixed, which is what api.ts asks for.
 *  - BASE = 300 against a ~20-part starter crate of value ~5-8 parts: a raw 5-part
 *    shipment is worth ~30, four of them ~120, so shift 1 round 1 is unclearable
 *    without the line doing real work. The game states its thesis on turn one.
 *  - Final quota is quotaFor(8, 3) = 19330 before the audit's own quotaMult. G5.1
 *    wants a p95 of 20x that (~390k), which multiplicative content can reach and
 *    additive content cannot — again by design.
 *  - Rounded to the nearest 5 purely so the number on screen reads as a target and
 *    not as a hash.
 */
export const QUOTA_BASE = 300;
export const QUOTA_GROWTH = 1.6;
export const QUOTA_ROUND_MULT: readonly number[] = [1, 1.5, 2.4];

export const STARTING_CREDITS = 4;
export const STARTER_CRATE_SIZE = 20;
export const STARTER_LINE_SIZE = 2;

export const SHOP_SIZE = 5;
export const BASE_REROLL_COST = 3;
export const REROLL_COST_STEP = 2;
/** cost to go 4->5, 5->6, 6->7, 7->8 */
export const LINESLOT_COSTS: readonly number[] = [10, 15, 22, 31];
export const BLUEPRINT_BASE_COST = 7;
export const MAX_MACHINE_LEVEL = 3;

// ---------------------------------------------------------------------------
// Per-run side table.
//
// RunState is frozen and has no field for the machine memo, so it lives here,
// keyed by the RunState object. Keeping it out of RunState is also what lets the
// determinism test deep-equal two RunStates directly.
// ---------------------------------------------------------------------------

interface RunAux {
  memo: Record<string, number>;
  /** round-clear credits are paid once, at the moment the quota is first met */
  rewarded: boolean;
  nextId: number;
}

const AUX = new WeakMap<RunState, RunAux>();

function aux(s: RunState): RunAux {
  let a = AUX.get(s);
  if (a === undefined) {
    // A state that arrived here by cloning gets a fresh, plausibly-resynced aux.
    a = {
      memo: {},
      rewarded: s.score >= s.quota,
      nextId: 1 + s.crate.length + s.line.length + s.blueprints.length,
    };
    AUX.set(s, a);
  }
  return a;
}

/** The machine scratch memo for this run. Cleared at round start. */
export function runMemo(s: RunState): Record<string, number> {
  return aux(s).memo;
}

// ---------------------------------------------------------------------------
// Pooled hot-path scratch
// ---------------------------------------------------------------------------

type ResetRng = RNG & { reset(seed: number): void };

/** mulberry32, byte-identical to rng.ts, but reseedable so preview can pool one. */
function makeResetRng(): ResetRng {
  let a = 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (n: number) => Math.floor(next() * n),
    pick: <T,>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)],
    shuffle: <T,>(xs: readonly T[]): T[] => {
      const out = xs.slice();
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        const t = out[i]; out[i] = out[j]; out[j] = t;
      }
      return out;
    },
    fork: () => makeRng(Math.floor(next() * 0xffffffff)),
    reset: (seed: number) => { a = seed >>> 0; },
  };
}

interface Grant { n: number }

function makeCtx(g: Grant): RunCtx {
  return {
    rng: null as unknown as RNG,
    shift: 0, round: 0, quota: 0, score: 0, shipmentIndex: 0,
    lineCap: 0, handSize: 0, credits: 0,
    memo: {},
    grantCredits(n: number): void { g.n += n; },
  };
}

const scratchGrant: Grant = { n: 0 };
const scratchRng: ResetRng = makeResetRng();
const scratchCtx: RunCtx = makeCtx(scratchGrant);
scratchCtx.rng = scratchRng;
let scratchBusy = false;

/**
 * Machine randomness is drawn from a stream derived from (seed, shift, round,
 * shipmentIndex) rather than from `s.rng`. Two consequences, both required:
 * preview cannot advance the run's RNG (purity), and preview predicts play exactly
 * (the two see the identical stream).
 */
function shipmentSeed(s: RunState): number {
  let h = s.seed >>> 0;
  h = (h ^ Math.imul(s.shift, 0x9e3779b1)) >>> 0;
  h = (h ^ Math.imul(s.round, 0x85ebca6b)) >>> 0;
  h = (h ^ Math.imul(SHIPMENTS_PER_ROUND - s.shipmentsLeft, 0xc2b2ae35)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x27d4eb2f) >>> 0;
  return h >>> 0;
}

function primeCtx(ctx: RunCtx, s: RunState, memo: Record<string, number>): void {
  ctx.shift = s.shift;
  ctx.round = s.round;
  ctx.quota = s.quota;
  ctx.score = s.score;
  ctx.shipmentIndex = SHIPMENTS_PER_ROUND - s.shipmentsLeft;
  ctx.lineCap = s.lineCap;
  ctx.handSize = s.handSize;
  ctx.credits = s.credits;
  ctx.memo = memo;
}

function copyMemo(src: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k in src) out[k] = src[k];
  return out;
}

// ---------------------------------------------------------------------------
// The line evaluation itself
// ---------------------------------------------------------------------------

function checkIndices(s: RunState, handIndices: number[]): void {
  const n = handIndices.length;
  if (n < 1 || n > PARTS_PER_SHIPMENT) {
    throw new RangeError(`shipment must be 1..${PARTS_PER_SHIPMENT} parts, got ${n}`);
  }
  const len = s.hand.length;
  for (let i = 0; i < n; i++) {
    const idx = handIndices[i];
    if (!(idx >= 0 && idx < len)) throw new RangeError(`hand index out of range: ${idx}`);
    for (let j = 0; j < i; j++) {
      if (handIndices[j] === idx) throw new RangeError(`duplicate hand index: ${idx}`);
    }
  }
}

/**
 * Push the selected hand parts through `line` and score what comes out.
 *
 * `stages[0]` is the batch entering machine 0; `stages[i+1]` is what leaves
 * machine i. When an Audit rule is in force one extra stage is appended holding
 * the post-audit batch — so `stages[stages.length - 1]` is ALWAYS the batch that
 * was actually scored.
 *
 * Every Part in `stages` is engine-owned; nothing here aliases a Part in `s`.
 */
function runLine(
  s: RunState, handIndices: number[], line: Machine[], reg: Registry, ctx: RunCtx,
): ShipmentResult {
  const n = handIndices.length;
  const hand = s.hand;
  const entry: Part[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const p = hand[handIndices[i]];
    // Deep copy: a buggy content machine that writes through its input must not be
    // able to reach a Part the run owns. `tags` is copied too.
    entry[i] = {
      id: p.id, def: p.def, value: p.value,
      tags: p.tags.slice(), mult: p.mult, sticky: p.sticky,
    };
  }

  const audit = s.round === ROUNDS_PER_SHIFT ? reg.audits[s.shift - 1] : undefined;
  const machines = reg.machines;
  const len = line.length;
  const stages: Batch[] = new Array(len + 1);
  let batch: Batch = entry;
  stages[0] = batch;

  for (let i = 0; i < len; i++) {
    const m = line[i];
    const def = machines.get(m.def);
    if (def !== undefined && (audit === undefined || audit.allow(def))) {
      const next = def.apply(batch, ctx, m.level);
      if (next != null) batch = next;
    }
    stages[i + 1] = batch;
  }

  if (audit !== undefined) {
    const next = audit.modify(batch, ctx);
    if (next != null) batch = next;
    stages.push(batch);
  }

  const gained = scoreBatch(batch);
  const scoreAfter = s.score + gained;
  return { stages, gained, scoreAfter, cleared: scoreAfter >= s.quota };
}

// ---------------------------------------------------------------------------
// api.ts — public surface
// ---------------------------------------------------------------------------

/** Quota for a given shift/round. Monotonic in each argument. See QUOTA_BASE. */
export function quotaFor(shift: number, round: number): number {
  const sh = Math.min(SHIFTS_PER_RUN, Math.max(1, Math.floor(shift)));
  const rd = Math.min(ROUNDS_PER_SHIFT, Math.max(1, Math.floor(round)));
  const q = QUOTA_BASE * Math.pow(QUOTA_GROWTH, sh - 1) * QUOTA_ROUND_MULT[rd - 1];
  return Math.round(q / 5) * 5;
}

/**
 * Pure evaluation. Does not mutate `s`, any Part in `s`, `s.rng`, `s.credits`, or
 * the live machine memo. `line` overrides `s.line` when given — this is how bots
 * price a candidate reordering.
 */
export function previewShipment(
  s: RunState, handIndices: number[], line?: Machine[],
): ShipmentResult {
  checkIndices(s, handIndices);
  const reg = getRegistry();
  const useLine = line !== undefined ? line : s.line;

  if (!scratchBusy) {
    scratchBusy = true;
    try {
      scratchRng.reset(shipmentSeed(s));
      scratchGrant.n = 0;
      primeCtx(scratchCtx, s, copyMemo(aux(s).memo));
      return runLine(s, handIndices, useLine, reg, scratchCtx);
    } finally {
      scratchBusy = false;
    }
  }

  // Re-entrant call (a machine previewing inside a preview). Rare; pay for it.
  const g: Grant = { n: 0 };
  const ctx = makeCtx(g);
  ctx.rng = makeRng(shipmentSeed(s));
  primeCtx(ctx, s, copyMemo(aux(s).memo));
  return runLine(s, handIndices, useLine, reg, ctx);
}

/** Ordered selection: handIndices[0] is the first part in the batch. */
export function playShipment(s: RunState, handIndices: number[]): ShipmentResult {
  if (s.over) throw new Error('run is over');
  if (s.shipmentsLeft <= 0) throw new Error('no shipments left this round');
  checkIndices(s, handIndices);

  const reg = getRegistry();
  const a = aux(s);
  const g: Grant = { n: 0 };
  const ctx = makeCtx(g);
  ctx.rng = makeRng(shipmentSeed(s));
  primeCtx(ctx, s, a.memo);

  const res = runLine(s, handIndices, s.line, reg, ctx);

  s.score = res.scoreAfter;
  if (g.n !== 0) s.credits = Math.max(0, s.credits + Math.floor(g.n));

  // Consume the played parts. Sticky parts stay in hand; everything else discards.
  const order = handIndices.slice().sort((x, y) => y - x);
  for (let i = 0; i < order.length; i++) {
    const idx = order[i];
    const p = s.hand[idx];
    if (p.sticky !== true) {
      s.hand.splice(idx, 1);
      s.discard.push(p);
    }
  }
  drawTo(s);

  s.shipmentsLeft--;
  s.decisions++;

  if (s.score >= s.quota) {
    if (!a.rewarded) {
      a.rewarded = true;
      s.credits += roundReward(s);
    }
  } else if (s.shipmentsLeft <= 0) {
    s.over = true;
    s.won = false;
  }
  return res;
}

/** Discard the given hand parts and redraw. Costs one scrap. No score. */
export function scrapParts(s: RunState, handIndices: number[]): void {
  if (s.over || s.scrapsLeft <= 0 || handIndices.length === 0) return;
  const len = s.hand.length;
  for (let i = 0; i < handIndices.length; i++) {
    const idx = handIndices[i];
    if (!(idx >= 0 && idx < len)) throw new RangeError(`hand index out of range: ${idx}`);
    for (let j = 0; j < i; j++) {
      if (handIndices[j] === idx) throw new RangeError(`duplicate hand index: ${idx}`);
    }
  }
  const order = handIndices.slice().sort((x, y) => y - x);
  for (let i = 0; i < order.length; i++) {
    const p = s.hand[order[i]];
    s.hand.splice(order[i], 1);
    s.discard.push(p);
  }
  drawTo(s);
  s.scrapsLeft--;
  s.decisions++;
}

/** `perm` is a permutation of 0..line.length-1. Free, always legal. */
export function reorderLine(s: RunState, perm: number[]): void {
  const len = s.line.length;
  if (perm.length !== len) {
    throw new RangeError(`perm length ${perm.length} != line length ${len}`);
  }
  const seen = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    const k = perm[i];
    if (!(k >= 0 && k < len) || seen[k] === 1) {
      throw new RangeError('perm is not a permutation of 0..line.length-1');
    }
    seen[k] = 1;
  }
  const next: Machine[] = new Array(len);
  let changed = false;
  for (let i = 0; i < len; i++) {
    next[i] = s.line[perm[i]];
    if (next[i] !== s.line[i]) changed = true;
  }
  for (let i = 0; i < len; i++) s.line[i] = next[i];
  if (changed) s.decisions++;
}

export function rollShop(s: RunState): Shop {
  const reg = getRegistry();
  const items: ShopItem[] = [];
  const taken = new Set<string>();
  for (let guard = 0; items.length < SHOP_SIZE && guard < 200; guard++) {
    const it = rollItem(s, reg, taken);
    if (it === undefined) continue;
    taken.add(`${it.kind}:${it.def}`);
    items.push(it);
  }
  return { items, rerollCost: BASE_REROLL_COST };
}

export function buy(s: RunState, shop: Shop, itemIndex: number): boolean {
  if (s.over) return false;
  if (!(itemIndex >= 0 && itemIndex < shop.items.length)) return false;
  const it = shop.items[itemIndex];
  if (s.credits < it.cost) return false;
  const reg = getRegistry();
  const a = aux(s);

  switch (it.kind) {
    case 'machine': {
      const def = reg.machines.get(it.def);
      if (def === undefined) return false;
      if (s.line.length >= s.lineCap) return false;
      for (const m of s.line) if (m.def === it.def) return false;
      s.line.push({ id: `m${a.nextId++}`, def: it.def, level: 1 });
      break;
    }
    case 'part': {
      const pd = reg.parts.get(it.def);
      if (pd === undefined) return false;
      const p = instantiate(pd, `p${a.nextId++}`);
      s.crate.push(p);
      s.discard.push(p);
      break;
    }
    case 'blueprint': {
      const bd = reg.blueprints.get(it.def);
      if (bd === undefined) return false;
      for (const b of s.blueprints) if (b.def === it.def) return false;
      s.blueprints.push({ id: `b${a.nextId++}`, def: it.def });
      if (bd.onRoundStart !== undefined) bd.onRoundStart(s);
      break;
    }
    case 'lineslot': {
      if (s.lineCap >= MAX_LINE_CAP) return false;
      s.lineCap++;
      break;
    }
    case 'upgrade': {
      let t = it.target !== undefined ? it.target : -1;
      // The line may have been reordered since the roll; re-find by def.
      if (!(t >= 0 && t < s.line.length && s.line[t].def === it.def)) {
        t = s.line.findIndex((m) => m.def === it.def);
      }
      if (t < 0) return false;
      if (s.line[t].level >= MAX_MACHINE_LEVEL) return false;
      s.line[t].level++;
      break;
    }
    default:
      return false;
  }

  s.credits -= it.cost;
  shop.items.splice(itemIndex, 1);
  s.decisions++;
  return true;
}

export function reroll(s: RunState, shop: Shop): Shop {
  if (s.over || s.credits < shop.rerollCost) return shop;
  s.credits -= shop.rerollCost;
  s.decisions++;
  const next = rollShop(s);
  next.rerollCost = shop.rerollCost + REROLL_COST_STEP;
  return next;
}

/** Advance past the shop into the next round/shift, or finish the run. */
export function nextRound(s: RunState): void {
  if (s.over) return;
  if (!roundCleared(s)) {
    s.over = true;
    s.won = false;
    return;
  }
  let round = s.round + 1;
  let shift = s.shift;
  if (round > ROUNDS_PER_SHIFT) { round = 1; shift++; }
  if (shift > SHIFTS_PER_RUN) {
    // Run completed. shift/round stay in-range per the RunState contract.
    s.over = true;
    s.won = true;
    return;
  }
  s.shift = shift;
  s.round = round;
  startRound(s);
}

/** True when the round's quota is met. */
export function roundCleared(s: RunState): boolean {
  return s.score >= s.quota;
}

/** Fresh run. Deterministic in `seed`. */
export function newRun(seed: number): RunState {
  const reg = getRegistry();
  const s: RunState = {
    seed: seed >>> 0,
    rng: makeRng(seed >>> 0),
    shift: 1,
    round: 1,
    quota: 0,
    score: 0,
    shipmentsLeft: SHIPMENTS_PER_ROUND,
    scrapsLeft: SCRAPS_PER_ROUND,
    credits: STARTING_CREDITS,
    line: [],
    lineCap: BASE_LINE_CAP,
    crate: [],
    drawPile: [],
    hand: [],
    discard: [],
    blueprints: [],
    handSize: BASE_HAND_SIZE,
    over: false,
    won: false,
    decisions: 0,
  };
  const a: RunAux = { memo: {}, rewarded: false, nextId: 1 };
  AUX.set(s, a);

  const crateDefs = reg.starterCrate !== undefined
    ? reg.starterCrate
    : buildStarterCrate(reg, s.rng);
  for (const d of crateDefs) {
    const pd = reg.parts.get(d);
    if (pd !== undefined) s.crate.push(instantiate(pd, `p${a.nextId++}`));
  }
  if (s.crate.length === 0) throw new Error('newRun: starter crate is empty');

  const lineDefs = reg.starterLine !== undefined
    ? reg.starterLine
    : buildStarterLine(reg, s.rng);
  for (const d of lineDefs) {
    if (s.line.length >= s.lineCap) break;
    if (!reg.machines.has(d)) continue;
    let dup = false;
    for (const m of s.line) if (m.def === d) dup = true;
    if (!dup) s.line.push({ id: `m${a.nextId++}`, def: d, level: 1 });
  }

  startRound(s);
  return s;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function instantiate(pd: PartDef, id: string): Part {
  const p: Part = {
    id,
    def: pd.def,
    value: pd.value,
    tags: pd.tags.slice(),
    mult: pd.mult,
  };
  if (pd.sticky === true) p.sticky = true;
  return p;
}

function buildStarterCrate(reg: Registry, rng: RNG): string[] {
  const pool: PartDef[] = [];
  for (const pd of reg.parts.values()) {
    if (pd.rarity === 'common' || pd.rarity === 'uncommon') pool.push(pd);
  }
  const src = pool.length > 0 ? pool : [...reg.parts.values()];
  src.sort((x, y) => (x.def < y.def ? -1 : x.def > y.def ? 1 : 0));
  const weights = src.map((pd) => {
    const w = pd.starterWeight !== undefined ? pd.starterWeight : 1;
    return w > 0 ? w : 0;
  });
  let total = 0;
  for (const w of weights) total += w;
  const out: string[] = [];
  for (let i = 0; i < STARTER_CRATE_SIZE; i++) {
    if (total <= 0) { out.push(src[i % src.length].def); continue; }
    let r = rng.next() * total;
    let k = 0;
    while (k < src.length - 1 && r >= weights[k]) { r -= weights[k]; k++; }
    out.push(src[k].def);
  }
  return out;
}

function buildStarterLine(reg: Registry, rng: RNG): string[] {
  const pool = [...reg.machines.values()].filter((m) => m.rarity === 'common');
  const src = pool.length > 0 ? pool : [...reg.machines.values()];
  src.sort((x, y) => (x.def < y.def ? -1 : x.def > y.def ? 1 : 0));
  const shuffled = rng.shuffle(src);
  return shuffled.slice(0, Math.min(STARTER_LINE_SIZE, shuffled.length)).map((m) => m.def);
}

function drawTo(s: RunState): void {
  while (s.hand.length < s.handSize) {
    if (s.drawPile.length === 0) {
      if (s.discard.length === 0) break;
      s.drawPile = s.rng.shuffle(s.discard);
      s.discard = [];
    }
    const p = s.drawPile.pop();
    if (p === undefined) break;
    s.hand.push(p);
  }
}

/**
 * Credits paid the first time a round's quota is met.
 * base by round (the Audit pays more) + a shift ramp + one per unspent shipment
 * (the "end fast" incentive) + Balatro-style interest on banked credits, capped so
 * hoarding is a strategy and not the strategy.
 */
function roundReward(s: RunState): number {
  const base = 4 + s.round;
  const shiftBonus = Math.floor((s.shift - 1) / 2);
  const leftover = Math.max(0, s.shipmentsLeft);
  const interest = Math.min(5, Math.floor(s.credits / 5));
  return base + shiftBonus + leftover + interest;
}

function startRound(s: RunState): void {
  const reg = getRegistry();
  const a = aux(s);
  a.memo = {};
  a.rewarded = false;

  s.score = 0;
  s.shipmentsLeft = SHIPMENTS_PER_ROUND;
  s.scrapsLeft = SCRAPS_PER_ROUND;

  const audit = s.round === ROUNDS_PER_SHIFT ? reg.audits[s.shift - 1] : undefined;
  const mult = audit !== undefined && audit.quotaMult > 0 ? audit.quotaMult : 1;
  s.quota = Math.max(1, Math.round(quotaFor(s.shift, s.round) * mult));

  // Blueprints run before the deal so they can change handSize / crate / quota.
  for (const b of s.blueprints) {
    const bd = reg.blueprints.get(b.def);
    if (bd !== undefined && bd.onRoundStart !== undefined) bd.onRoundStart(s);
  }

  s.drawPile = s.rng.shuffle(s.crate);
  s.hand = [];
  s.discard = [];
  drawTo(s);
}

// --- shop ------------------------------------------------------------------

/** Rarity weights drift toward the top end as the run progresses. */
function rarityWeight(r: Rarity, shift: number): number {
  const t = Math.max(0, shift - 1);
  switch (r) {
    case 'common': return Math.max(20, 100 - 7 * t);
    case 'uncommon': return 40 + 2 * t;
    case 'rare': return 8 + 4 * t;
    case 'legendary': return 1 + 1.6 * t;
    default: return 1;
  }
}

function weightedPick<T>(xs: T[], w: number[], rng: RNG): T | undefined {
  let total = 0;
  for (const x of w) total += x;
  if (!(total > 0)) return undefined;
  let r = rng.next() * total;
  for (let i = 0; i < xs.length; i++) {
    r -= w[i];
    if (r < 0) return xs[i];
  }
  return xs[xs.length - 1];
}

function scaleCost(base: number, shift: number, per: number): number {
  return Math.max(1, Math.round(base * (1 + per * (shift - 1))));
}

function rollItem(s: RunState, reg: Registry, taken: Set<string>): ShopItem | undefined {
  const kinds: ShopItem['kind'][] = [];
  const kw: number[] = [];

  kinds.push('machine'); kw.push(50);
  kinds.push('part'); kw.push(18);
  if (reg.blueprints.size > 0) { kinds.push('blueprint'); kw.push(12); }
  if (s.lineCap < MAX_LINE_CAP && !taken.has('lineslot:slot')) {
    kinds.push('lineslot'); kw.push(8);
  }
  if (s.line.some((m) => m.level < MAX_MACHINE_LEVEL)) { kinds.push('upgrade'); kw.push(12); }

  const kind = weightedPick(kinds, kw, s.rng);
  if (kind === undefined) return undefined;

  switch (kind) {
    case 'machine': {
      const owned = new Set(s.line.map((m) => m.def));
      const pool = [];
      const w = [];
      for (const def of reg.machines.values()) {
        if (owned.has(def.def)) continue;              // no duplicate of an owned unique
        if (taken.has(`machine:${def.def}`)) continue; // no duplicate inside one shop
        pool.push(def); w.push(rarityWeight(def.rarity, s.shift));
      }
      const pickd = weightedPick(pool, w, s.rng);
      if (pickd === undefined) return undefined;
      return { kind, def: pickd.def, cost: scaleCost(pickd.cost, s.shift, 0.12) };
    }
    case 'part': {
      const pool = [];
      const w = [];
      for (const pd of reg.parts.values()) {
        if (taken.has(`part:${pd.def}`)) continue;
        pool.push(pd); w.push(rarityWeight(pd.rarity, s.shift));
      }
      const pickd = weightedPick(pool, w, s.rng);
      if (pickd === undefined) return undefined;
      return { kind, def: pickd.def, cost: scaleCost(pickd.cost, s.shift, 0.1) };
    }
    case 'blueprint': {
      const owned = new Set(s.blueprints.map((b) => b.def));
      const pool = [];
      const w = [];
      for (const bd of reg.blueprints.values()) {
        if (owned.has(bd.def)) continue;
        if (taken.has(`blueprint:${bd.def}`)) continue;
        pool.push(bd); w.push(1);
      }
      const pickd = weightedPick(pool, w, s.rng);
      if (pickd === undefined) return undefined;
      return { kind, def: pickd.def, cost: BLUEPRINT_BASE_COST + s.shift };
    }
    case 'lineslot': {
      const step = Math.min(LINESLOT_COSTS.length - 1, Math.max(0, s.lineCap - BASE_LINE_CAP));
      return { kind, def: 'slot', cost: LINESLOT_COSTS[step] };
    }
    case 'upgrade': {
      const pool = [];
      const w = [];
      for (let i = 0; i < s.line.length; i++) {
        const m = s.line[i];
        if (m.level >= MAX_MACHINE_LEVEL) continue;
        if (taken.has(`upgrade:${m.def}`)) continue;
        pool.push(i); w.push(1);
      }
      const idx = weightedPick(pool, w, s.rng);
      if (idx === undefined) return undefined;
      const m = s.line[idx];
      const def = reg.machines.get(m.def);
      const base = def !== undefined ? def.cost : 6;
      return {
        kind, def: m.def, target: idx,
        cost: Math.max(2, Math.round(base * (0.9 + 0.7 * m.level))),
      };
    }
    default:
      return undefined;
  }
}
