// TAKT — machine content.
//
// WHAT THIS SET IS FOR, in priority order:
//
// 1. ALCHEMY. A part is an object, not a labelled number. `Part.def` is the thing on
//    the belt, and the tier ladder in `parts.ts` (Offcut -> Bolt -> Gear -> Pump ->
//    Engine -> Reactor -> Monument) is what machines promote a part along. The end of
//    a shipment should be an absurd object arriving, not a bigger integer. Sixteen
//    machines here exist only to promote, fuse or corrupt an identity.
//
// 2. ORDER. `x2 then +5` is not `+5 then x2`, and that is the skill. Order-sensitivity
//    is reached through machines that READ position and identity (`the highest part`,
//    `the part before it`, `all one tag`) and machines that MOVE parts down the belt,
//    not by banning designs. The aggregate target — >=60% of machine pairs must be
//    non-commutative — is tested in `tests/content.test.ts`.
//
// 3. DRAMA. Machines are allowed to whiff. A conditional that misses is a beloved
//    design (every good roguelike deck is full of them) and the miss is part of the
//    story of a run. Six machines are outright gambles and say so in their rule text.
//
// Earlier drafts of this file carried two rules — "no machine may ever be a no-op" and
// "every economic machine must also change the batch" — that existed purely to protect
// the non-commutativity metric. They banned good designs to defend a number and have
// been removed. The benchmark serves the game.
//
// RANDOMNESS. `ctx.rng` is reseeded by the engine per shipment from
// (seed, shift, round, shipmentIndex), so preview predicts play exactly as long as a
// machine's draws are a pure function of the batch it is handed. Every gamble machine
// here takes exactly one draw at one fixed point, so that holds. Losing a run to a
// coin flip you can see coming is a story; losing it to arithmetic you got wrong is
// homework.
//
// PURITY. `apply` never mutates `batch` or any `Part` in it, and always returns a new
// array. Values stay finite, integral and >= 0; batches never exceed MAX_BATCH.

import type {
  Archetype, Batch, MachineDef, Part, Rarity, RunCtx, Tag,
} from '../engine/types.ts';
import { TIER_INDEX, TIER_LADDER } from './parts.ts';

// ---------------------------------------------------------------------------
// limits — totality guards. `apply` must never emit NaN/Infinity/negative value.
// ---------------------------------------------------------------------------

/** Generative machines never grow a batch past this. Keeps the hot path bounded. */
export const MAX_BATCH = 12;
const MAX_VALUE = 1e9;
const MAX_MULT = 1e4;

/** level parameter: 1 -> a, 2 -> b, 3 -> c */
function L<T>(l: number, a: T, b: T, c: T): T {
  const n = Math.floor(l);
  return n <= 1 ? a : n === 2 ? b : c;
}

/** player-facing copy: "1 tier" / "2 tiers" — never "1 tiers". */
function TIERS(n: number): string {
  return n === 1 ? '1 tier' : `${n} tiers`;
}

/** player-facing copy: "1 part" / "2 parts" — never "1 parts". */
function PARTS(n: number): string {
  return n === 1 ? 'part' : `${n} parts`;
}

/** clamp a value: integer, finite, >= 0 */
function cv(n: number): number {
  if (!Number.isFinite(n)) return MAX_VALUE;
  if (n <= 0) return 0;
  if (n >= MAX_VALUE) return MAX_VALUE;
  return Math.floor(n);
}

/** clamp a mult: finite, >= 0 (fractional allowed — scoreBatch floors the total) */
function cm(n: number): number {
  if (!Number.isFinite(n)) return MAX_MULT;
  if (n <= 0) return 0;
  if (n >= MAX_MULT) return MAX_MULT;
  return n;
}

/** shallow copy of a part. `tags` is shared by reference and never mutated in place. */
function cp(p: Part): Part {
  const q: Part = { id: p.id, def: p.def, value: p.value, tags: p.tags, mult: p.mult };
  if (p.sticky) q.sticky = true;
  return q;
}

function setV(p: Part, v: number): Part { const q = cp(p); q.value = cv(v); return q; }
function addV(p: Part, d: number): Part { return setV(p, p.value + d); }
function mulV(p: Part, f: number): Part { return setV(p, p.value * f); }
function setM(p: Part, m: number): Part { const q = cp(p); q.mult = cm(m); return q; }
function mulM(p: Part, f: number): Part { return setM(p, p.mult * f); }
function retag(p: Part, t: Tag): Part { const q = cp(p); q.tags = [t]; return q; }

/** a generated part: fresh id, never sticky (sticky clones would leak into the hand). */
function spawn(ctx: RunCtx, src: Part, value: number, mult: number, tags: Tag[]): Part {
  return {
    id: uid(ctx, src.id), def: src.def, value: cv(value), mult: cm(mult), tags,
  };
}

let fallbackUid = 0;
/**
 * Deterministic unique id for generated parts. Uses `ctx.memo` (cleared at round start,
 * so identical runs from one seed produce identical ids) and only falls back to a module
 * counter when a caller hands us no memo.
 */
function uid(ctx: RunCtx, base: string): string {
  const m = ctx && ctx.memo;
  if (m) {
    const n = (typeof m.__uid === 'number' ? m.__uid : 0) + 1;
    m.__uid = n;
    return base + '+' + n;
  }
  return base + '+f' + (++fallbackUid);
}

function credits(ctx: RunCtx, n: number): void {
  if (!ctx || typeof ctx.grantCredits !== 'function') return;
  const k = Math.floor(n);
  if (Number.isFinite(k) && k > 0) ctx.grantCredits(Math.min(k, 999));
}

// --- batch helpers ---------------------------------------------------------

function all(b: Batch, f: (p: Part, i: number) => Part): Batch {
  const out: Batch = new Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = f(b[i], i);
  return out;
}

function at(b: Batch, i: number, f: (p: Part) => Part): Batch {
  const out = b.slice();
  if (i >= 0 && i < b.length) out[i] = f(b[i]);
  return out;
}

/** index of the highest-value part (ties: earliest). -1 on empty. */
function hi(b: Batch): number {
  let k = -1, best = -Infinity;
  for (let i = 0; i < b.length; i++) if (b[i].value > best) { best = b[i].value; k = i; }
  return k;
}

/** index of the lowest-value part (ties: earliest). -1 on empty. */
function lo(b: Batch): number {
  let k = -1, best = Infinity;
  for (let i = 0; i < b.length; i++) if (b[i].value < best) { best = b[i].value; k = i; }
  return k;
}

function tagOf(p: Part): Tag { return p.tags.length > 0 ? p.tags[0] : 'scrap'; }
function has(p: Part, t: Tag): boolean { return p.tags.indexOf(t) >= 0; }

function countTag(b: Batch, t: Tag): number {
  let n = 0;
  for (const p of b) if (has(p, t)) n++;
  return n;
}

/** the tag shared by every part, or null */
function oneTag(b: Batch): Tag | null {
  if (b.length === 0) return null;
  const t = tagOf(b[0]);
  for (const p of b) if (!has(p, t)) return null;
  return t;
}

function totalValue(b: Batch): number {
  let t = 0;
  for (const p of b) t += p.value;
  return t;
}

/** filter that refuses to empty the batch: an empty line output is a dead shipment. */
function keep(b: Batch, pred: (p: Part, i: number) => boolean, then: (p: Part) => Part): Batch {
  const out: Batch = [];
  for (let i = 0; i < b.length; i++) if (pred(b[i], i)) out.push(then(b[i]));
  if (out.length === 0) return b.slice();
  return out;
}

function trunc(b: Batch): Batch { return b.length > MAX_BATCH ? b.slice(0, MAX_BATCH) : b; }

/** move index i to the back. Parts physically travelling down the line is the point. */
function toBack(b: Batch, i: number): Batch {
  const out = b.slice();
  if (i < 0 || i >= b.length || b.length < 2) return out;
  const [p] = out.splice(i, 1);
  out.push(p);
  return out;
}

function toFront(b: Batch, i: number): Batch {
  const out = b.slice();
  if (i < 0 || i >= b.length || b.length < 2) return out;
  const [p] = out.splice(i, 1);
  out.unshift(p);
  return out;
}

function swapAt(b: Batch, i: number, j: number): Batch {
  const out = b.slice();
  if (i < 0 || j < 0 || i >= b.length || j >= b.length || i === j) return out;
  out[i] = b[j];
  out[j] = b[i];
  return out;
}

/** keep only `t`; if nothing carries `t`, convert the whole batch to it instead. */
function sieve(b: Batch, t: Tag, then: (p: Part) => Part): Batch {
  const out: Batch = [];
  for (const p of b) if (has(p, t)) out.push(then(p));
  if (out.length > 0) return out;
  return all(b, (p) => retag(p, t));
}

// --- the tier ladder -------------------------------------------------------

/**
 * Which rung a part sits on. On-ladder parts know their rung; anything else (a Fish,
 * a Cursed Doll, a part some machine has already inflated) enters the ladder at the
 * highest rung its value has earned, so every part in the game can be promoted.
 */
function tierOf(p: Part): number {
  const known = TIER_INDEX.get(p.def);
  if (known !== undefined) return known;
  let k = 0;
  for (let i = 0; i < TIER_LADDER.length; i++) if (p.value >= TIER_LADDER[i].value) k = i;
  return k;
}

/**
 * Promote a part `n` rungs: it BECOMES the higher object — new def, new name on the
 * belt, new tags. Its own value is carried across AND scaled, so a part you have been
 * building up stays built up: promotion rewards the work done to its left instead of
 * overwriting it. (An earlier draft set the new value to the tier's flat value, which
 * quietly erased every machine upstream — and made promotions score-commutative with
 * every adder, which is the opposite of what this archetype is for.)
 * At the top of the ladder a promotion instead makes the Monument bigger.
 */
function promote(p: Part, n: number): Part {
  if (n <= 0) return cp(p);
  const i = tierOf(p);
  const top = TIER_LADDER.length - 1;
  const j = Math.min(i + n, top);
  if (j <= i) return setV(p, p.value * 1.3 + 60);
  const t = TIER_LADDER[j];
  const q = cp(p);
  q.def = t.def;
  q.tags = t.tags;
  q.value = cv(t.value + p.value * (1 + 0.5 * (j - i)));
  return q;
}

/** Knock a part back down to an Offcut: it loses a third of its value, and the
 *  vandalism is paid for in mult. */
function corrupt(p: Part, multBoost: number): Part {
  const t = TIER_LADDER[0];
  const q = cp(p);
  q.def = t.def;
  q.tags = t.tags;
  q.value = cv(p.value * 0.66 + 4);
  q.mult = cm(p.mult * multBoost);
  return q;
}

/** affine value change: v -> v*a + b. Two different affines never commute, which is
 *  why several machines pay in "+x% and +n" rather than a flat bonus. */
function aff(p: Part, a: number, b: number): Part { return setV(p, p.value * a + b); }

/** one draw, one decision. See the RANDOMNESS note in the header. */
function roll(ctx: RunCtx): number {
  const r = ctx && ctx.rng && typeof ctx.rng.next === 'function' ? ctx.rng.next() : 0.5;
  return Number.isFinite(r) ? r : 0.5;
}

function mk(
  def: string, name: string, archetype: Archetype, rarity: Rarity, cost: number,
  text: (level: number) => string,
  apply: (batch: Batch, ctx: RunCtx, level: number) => Batch,
): MachineDef {
  return { def, name, archetype, rarity, cost, text, apply };
}

// ===========================================================================
// ARITHMETIC — the glue. Kept deliberately position-aware: only `press` and
// `tally` are value-blind and permutation-invariant (R4).
// ===========================================================================

const ARITHMETIC: MachineDef[] = [
  mk('press', 'Press', 'arithmetic', 'common', 4,
    (l) => `+${L(l, 5, 8, 12)} each, first part to the back`,
    (b, _c, l) => { const n = L(l, 5, 8, 12); return toBack(all(b, (p) => addV(p, n)), 0); }),

  mk('stamp', 'Stamp', 'arithmetic', 'common', 4,
    (l) => `+${L(l, 16, 26, 40)} first, then it moves to the back`,
    (b, _c, l) => toBack(at(b, 0, (p) => addV(p, L(l, 16, 26, 40))), 0)),

  mk('capstone', 'Capstone', 'arithmetic', 'common', 4,
    (l) => `+${L(l, 16, 26, 40)} last, then it moves to the front`,
    (b, _c, l) => toFront(at(b, b.length - 1, (p) => addV(p, L(l, 16, 26, 40))), b.length - 1)),

  mk('doubler', 'Doubler', 'arithmetic', 'common', 6,
    (l) => `x${L(l, 2, 2.5, 3)} mult first, then swap the first two`,
    (b, _c, l) => swapAt(at(b, 0, (p) => mulM(p, L(l, 2, 2.5, 3))), 0, 1)),

  mk('tailspin', 'Tailspin', 'arithmetic', 'common', 6,
    (l) => `x${L(l, 2, 2.5, 3)} mult last, then swap the last two`,
    (b, _c, l) => swapAt(at(b, b.length - 1, (p) => mulM(p, L(l, 2, 2.5, 3))), b.length - 1, b.length - 2)),

  mk('cascade', 'Cascade', 'arithmetic', 'uncommon', 7,
    (l) => `+${L(l, 4, 7, 11)} x position each`,
    (b, _c, l) => { const n = L(l, 4, 7, 11); return all(b, (p, i) => addV(p, n * i)); }),

  mk('tally', 'Tally', 'arithmetic', 'common', 5,
    (l) => `+${L(l, 10, 15, 20)}% value and +${L(l, 3, 5, 8)} per part, to each`,
    (b, _c, l) => {
      const n = L(l, 3, 5, 8) * b.length;
      return all(b, (p) => aff(p, L(l, 1.1, 1.15, 1.2), n));
    }),

  mk('kinship', 'Kinship', 'arithmetic', 'uncommon', 7,
    (l) => `+${L(l, 15, 22, 30)}% value, and +${L(l, 6, 10, 15)} per part sharing the first part's tag`,
    (b, _c, l) => {
      if (b.length === 0) return [];
      const n = L(l, 6, 10, 15) * countTag(b, tagOf(b[0]));
      return all(b, (p) => aff(p, L(l, 1.15, 1.22, 1.3), n));
    }),

  mk('seesaw', 'Seesaw', 'arithmetic', 'uncommon', 8,
    (l) => `move ${L(l, 30, 45, 60)}% of the highest to the lowest, +${L(l, 6, 12, 20)}`,
    (b, _c, l) => {
      const h = hi(b), o = lo(b);
      if (h < 0) return [];
      const bump = L(l, 6, 12, 20);
      if (h === o) return at(b, h, (p) => addV(p, bump));
      const d = Math.floor(b[h].value * L(l, 0.3, 0.45, 0.6));
      const out = b.slice();
      out[h] = addV(b[h], -d);
      out[o] = addV(b[o], d + bump);
      return out;
    }),

  mk('mirror_add', 'Mirror Feed', 'arithmetic', 'uncommon', 8,
    (l) => `each +1/${L(l, 4, 3, 2)} of the part opposite it`,
    (b, _c, l) => {
      const d = L(l, 4, 3, 2);
      return all(b, (p, i) => addV(p, Math.floor(b[b.length - 1 - i].value / d)));
    }),

  mk('tithe', 'Tithe', 'arithmetic', 'uncommon', 7,
    (l) => `-${L(l, 25, 20, 15)}% value each, x${L(l, 2, 2.6, 3.2)} mult the highest`,
    (b, _c, l) => {
      const h = hi(b);
      const cut = L(l, 0.75, 0.8, 0.85);
      const out = all(b, (p) => aff(p, cut, 0));
      if (h >= 0) out[h] = mulM(out[h], L(l, 2, 2.6, 3.2));
      return out;
    }),

  mk('ratchet', 'Ratchet', 'arithmetic', 'rare', 10,
    (l) => `each part +${L(l, 25, 40, 60)}% of the one before it`,
    (b, _c, l) => {
      const f = L(l, 0.25, 0.4, 0.6);
      const out: Batch = new Array(b.length);
      for (let i = 0; i < b.length; i++) {
        out[i] = i === 0 ? cp(b[i]) : addV(b[i], Math.floor(b[i - 1].value * f));
      }
      return out;
    }),
];

// ===========================================================================
// POSITIONAL — the reason the line has an order at all. Four are pure
// permutations (clean to read on a phone); the rest pay a small effect so they
// do not commute with the value-blind arithmetic.
// ===========================================================================

function rot(b: Batch, k: number): Batch {
  const n = b.length;
  if (n < 2) return b.slice();
  const s = ((k % n) + n) % n;
  const out: Batch = new Array(n);
  for (let i = 0; i < n; i++) out[i] = b[(i + s) % n];
  return out;
}

const POSITIONAL: MachineDef[] = [
  mk('reverse', 'Reverser', 'positional', 'common', 5,
    () => 'reverse the batch',
    (b) => { const out: Batch = new Array(b.length); for (let i = 0; i < b.length; i++) out[i] = b[b.length - 1 - i]; return out; }),

  mk('rot_left', 'Left Shunt', 'positional', 'common', 4,
    (l) => `rotate left ${L(l, 1, 2, 3)}`,
    (b, _c, l) => rot(b, L(l, 1, 2, 3))),

  mk('rot_right', 'Right Shunt', 'positional', 'common', 4,
    (l) => `rotate right ${L(l, 1, 2, 3)}`,
    (b, _c, l) => rot(b, -L(l, 1, 2, 3))),

  mk('swap_ends', 'Turntable', 'positional', 'common', 4,
    () => 'swap first and last',
    (b) => {
      const out = b.slice();
      if (b.length >= 2) { out[0] = b[b.length - 1]; out[b.length - 1] = b[0]; }
      return out;
    }),

  mk('sort_asc', 'Ascender', 'positional', 'uncommon', 7,
    () => 'sort by value, low to high',
    (b) => b.map((p, i) => ({ p, i })).sort((x, y) => (x.p.value - y.p.value) || (x.i - y.i)).map((x) => cp(x.p))),

  mk('sort_desc', 'Descender', 'positional', 'uncommon', 7,
    () => 'sort by value, high to low',
    (b) => b.map((p, i) => ({ p, i })).sort((x, y) => (y.p.value - x.p.value) || (x.i - y.i)).map((x) => cp(x.p))),

  mk('hoist', 'Hoist', 'positional', 'uncommon', 7,
    (l) => `move the highest to front, +${L(l, 10, 18, 28)}`,
    (b, _c, l) => {
      const h = hi(b);
      if (h < 0) return [];
      const out = b.slice();
      out.splice(h, 1);
      out.unshift(addV(b[h], L(l, 10, 18, 28)));
      return out;
    }),

  mk('sink', 'Sump', 'positional', 'uncommon', 7,
    (l) => `move the lowest to the back, x${L(l, 2, 2.5, 3)} mult`,
    (b, _c, l) => {
      const o = lo(b);
      if (o < 0) return [];
      const out = b.slice();
      out.splice(o, 1);
      out.push(mulM(b[o], L(l, 2, 2.5, 3)));
      return out;
    }),

  mk('pair_swap', 'Crossover', 'positional', 'common', 5,
    () => 'swap each adjacent pair',
    (b) => {
      const out = b.slice();
      for (let i = 0; i + 1 < b.length; i += 2) { out[i] = b[i + 1]; out[i + 1] = b[i]; }
      return out;
    }),

  mk('halves', 'Shuttle', 'positional', 'uncommon', 6,
    (l) => `swap the halves of the batch, +${L(l, 6, 11, 17)} to the new front half`,
    (b, _c, l) => {
      const n = b.length;
      if (n < 2) return b.slice();
      const m = Math.floor(n / 2);
      const bump = L(l, 6, 11, 17);
      const back = b.slice(n - m);
      const front = b.slice(0, n - m);
      const out: Batch = [];
      for (const p of back) out.push(addV(p, bump));
      for (const p of front) out.push(cp(p));
      return out;
    }),

  mk('tag_sort', 'Sorter', 'positional', 'rare', 9,
    (l) => `group by tag, biggest group first, +${L(l, 8, 14, 22)} to the first group`,
    (b, _c, l) => {
      if (b.length === 0) return [];
      const groups = new Map<Tag, Part[]>();
      for (const p of b) {
        const t = tagOf(p);
        const g = groups.get(t);
        if (g) g.push(p); else groups.set(t, [p]);
      }
      const keys = [...groups.keys()].sort((x, y) => (groups.get(y)!.length - groups.get(x)!.length));
      const bump = L(l, 8, 14, 22);
      const out: Batch = [];
      let first = true;
      for (const k of keys) {
        for (const p of groups.get(k)!) out.push(first ? addV(p, bump) : cp(p));
        first = false;
      }
      return out;
    }),

  mk('interleave', 'Interleaver', 'positional', 'rare', 9,
    (l) => `interleave the halves, x${L(l, 1.4, 1.7, 2)} mult to the odd positions`,
    (b, _c, l) => {
      const n = b.length;
      if (n < 2) return b.slice();
      const m = Math.ceil(n / 2);
      const a = b.slice(0, m), z = b.slice(m);
      const out: Batch = [];
      for (let i = 0; i < m; i++) {
        out.push(cp(a[i]));
        if (i < z.length) out.push(z[i]);
      }
      const f = L(l, 1.4, 1.7, 2);
      for (let i = 1; i < out.length; i += 2) out[i] = mulM(out[i], f);
      for (let i = 0; i < out.length; i += 2) out[i] = cp(out[i]);
      return out;
    }),
];

// ===========================================================================
// FILTER — every filter refuses to empty the batch (an empty batch scores 0 and
// makes the machine a trap rather than a choice), and every one pays the
// survivors so that "fewer parts" can compete with "more parts".
// ===========================================================================

const FILTER: MachineDef[] = [
  mk('cull', 'Culler', 'filter', 'common', 5,
    (l) => `drop the lowest ${L(l, 1, 1, 2)}, +${L(l, 25, 35, 45)}% value and +${L(l, 6, 10, 12)} each`,
    (b, _c, l) => {
      const k = L(l, 1, 1, 2), fa = L(l, 1.25, 1.35, 1.45), fb = L(l, 6, 10, 12);
      const bump = (p: Part) => aff(p, fa, fb);
      if (b.length <= k) return all(b, bump);
      const order = b.map((p, i) => ({ p, i })).sort((x, y) => (x.p.value - y.p.value) || (x.i - y.i));
      const drop = new Set(order.slice(0, k).map((x) => x.i));
      const out: Batch = [];
      for (let i = 0; i < b.length; i++) if (!drop.has(i)) out.push(bump(b[i]));
      return out;
    }),

  mk('topcut', 'Top Cut', 'filter', 'uncommon', 7,
    (l) => `keep the top ${L(l, 2, 3, 4)} by value, x${L(l, 1.5, 1.6, 1.8)} mult and +${L(l, 25, 35, 45)}% value each, high to low`,
    (b, _c, l) => {
      const k = L(l, 2, 3, 4), f = L(l, 1.5, 1.6, 1.8), v = L(l, 1.25, 1.35, 1.45);
      const pay = (p: Part) => aff(mulM(p, f), v, 0);
      if (b.length <= k) return all(b, pay);
      const order = b.map((p, i) => ({ p, i })).sort((x, y) => (y.p.value - x.p.value) || (x.i - y.i));
      const out: Batch = [];
      for (const x of order.slice(0, k)) out.push(pay(x.p));
      return out;
    }),

  mk('purge', 'Purge', 'filter', 'common', 5,
    (l) => `drop the last, +${L(l, 22, 36, 55)} to the new last`,
    (b, _c, l) => {
      if (b.length <= 1) return all(b, (p) => addV(p, L(l, 22, 36, 55)));
      const out = b.slice(0, b.length - 1);
      out[out.length - 1] = addV(out[out.length - 1], L(l, 22, 36, 55));
      return out;
    }),

  mk('trim', 'Trimmer', 'filter', 'common', 5,
    (l) => `drop the first, x${L(l, 1.6, 2, 2.5)} mult the rest`,
    (b, _c, l) => {
      const f = L(l, 1.6, 2, 2.5);
      if (b.length <= 1) return all(b, (p) => mulM(p, f));
      return all(b.slice(1), (p) => mulM(p, f));
    }),

  mk('sieve_metal', 'Metal Sieve', 'filter', 'common', 6,
    (l) => `keep only metal, +${L(l, 40, 55, 70)}% value and +${L(l, 8, 12, 18)} each. No metal: the batch becomes metal`,
    (b, _c, l) => sieve(b, 'metal', (p) => aff(p, L(l, 1.4, 1.55, 1.7), L(l, 8, 12, 18)))),

  mk('sieve_volatile', 'Blast Sieve', 'filter', 'uncommon', 7,
    (l) => `keep only volatile, x${L(l, 2, 2.6, 3.2)} mult and +${L(l, 20, 30, 40)}% value each. None: the batch becomes volatile`,
    (b, _c, l) => sieve(b, 'volatile', (p) => aff(mulM(p, L(l, 2, 2.6, 3.2)), L(l, 1.2, 1.3, 1.4), 0))),

  mk('sieve_organic', 'Organic Sieve', 'filter', 'common', 6,
    (l) => `keep only organic, +${L(l, 30, 45, 60)}% value and +${L(l, 12, 18, 26)} each. None: the batch becomes organic`,
    (b, _c, l) => sieve(b, 'organic', (p) => aff(p, L(l, 1.3, 1.45, 1.6), L(l, 12, 18, 26)))),

  mk('sieve_precision', 'Gauge', 'filter', 'uncommon', 7,
    (l) => `keep only precision, x${L(l, 1.8, 2.2, 2.8)} mult, +${L(l, 25, 35, 45)}% value and +${L(l, 6, 10, 14)} each. None: the batch becomes precision`,
    (b, _c, l) => sieve(b, 'precision',
      (p) => aff(mulM(p, L(l, 1.8, 2.2, 2.8)), L(l, 1.25, 1.35, 1.45), L(l, 6, 10, 14)))),

  mk('quality', 'Q-Gate', 'filter', 'uncommon', 7,
    (l) => `drop parts under ${L(l, 10, 18, 28)}, +${L(l, 30, 40, 50)}% value and +${L(l, 8, 12, 16)} each`,
    (b, _c, l) => keep(b, (p) => p.value >= L(l, 10, 18, 28),
      (p) => aff(p, L(l, 1.3, 1.4, 1.5), L(l, 8, 12, 16)))),

  mk('unique', 'Assay', 'filter', 'rare', 9,
    (l) => `keep the first part of each tag, x${L(l, 2, 2.5, 3)} mult and +${L(l, 30, 40, 55)}% value each`,
    (b, _c, l) => {
      const seen = new Set<Tag>();
      const f = L(l, 2, 2.5, 3), v = L(l, 1.3, 1.4, 1.55);
      return keep(b, (p) => {
        const t = tagOf(p);
        if (seen.has(t)) return false;
        seen.add(t);
        return true;
      }, (p) => aff(mulM(p, f), v, 0));
    }),

  mk('skipper', 'Skip Chain', 'filter', 'uncommon', 8,
    (l) => `keep every other part, +${L(l, 45, 60, 80)}% value and +${L(l, 12, 18, 26)} each`,
    (b, _c, l) => keep(b, (_p, i) => i % 2 === 0,
      (p) => aff(p, L(l, 1.45, 1.6, 1.8), L(l, 12, 18, 26)))),

  mk('intake', 'Intake Gate', 'filter', 'common', 5,
    (l) => `keep the first ${L(l, 2, 3, 4)}, +${L(l, 30, 40, 50)}% value and +${L(l, 10, 14, 18)} each`,
    (b, _c, l) => {
      const k = L(l, 2, 3, 4), f = L(l, 1.3, 1.4, 1.5), bump = L(l, 10, 14, 18);
      return keep(b, (_p, i) => i < k, (p) => aff(p, f, bump));
    }),
];

// ===========================================================================
// GENERATIVE — the Wide build's engine. All of them read the batch to decide
// *what* to copy, so none is a blind "add a part" that would commute with the
// positional set. Batch is capped at MAX_BATCH.
// ===========================================================================

const GENERATIVE: MachineDef[] = [
  mk('echo', 'Echo', 'generative', 'common', 6,
    (l) => `copy the first part, x${L(l, 0.6, 0.8, 1)} value`,
    (b, c, l) => {
      if (b.length === 0) return [];
      const src = b[0];
      const out = b.slice();
      out.splice(1, 0, spawn(c, src, src.value * L(l, 0.6, 0.8, 1), src.mult, src.tags));
      return trunc(out);
    }),

  mk('mimic', 'Mimic', 'generative', 'common', 6,
    (l) => `copy the last part, x${L(l, 0.6, 0.8, 1)} value`,
    (b, c, l) => {
      if (b.length === 0) return [];
      const src = b[b.length - 1];
      const out = b.slice();
      out.push(spawn(c, src, src.value * L(l, 0.6, 0.8, 1), src.mult, src.tags));
      return trunc(out);
    }),

  mk('xerox', 'Xerox', 'generative', 'rare', 10,
    (l) => `copy the highest part to the back${L(l, '', '', ' twice')}, at x${L(l, 0.5, 0.75, 0.75)} value`,
    (b, c, l) => {
      const h = hi(b);
      if (h < 0) return [];
      const src = b[h];
      const n = L(l, 1, 1, 2), f = L(l, 0.5, 0.75, 0.75);
      const out = b.slice();
      for (let i = 0; i < n; i++) out.push(spawn(c, src, src.value * f, src.mult, src.tags));
      return trunc(out);
    }),

  mk('scrapper', 'Scrap Feeder', 'generative', 'common', 4,
    (l) => `add a scrap part worth ${L(l, 8, 15, 24)} to the back`,
    (b, c, l) => {
      const src: Part = b.length > 0 ? b[b.length - 1] : { id: 'scrap', def: 'offcut', value: 0, mult: 1, tags: ['scrap'] };
      const out = b.slice();
      out.push(spawn(c, src, L(l, 8, 15, 24), 1, ['scrap']));
      return trunc(out);
    }),

  mk('splitter', 'Splitter', 'generative', 'uncommon', 8,
    () => 'split the highest part into two halves',
    (b, c) => {
      const h = hi(b);
      if (h < 0) return [];
      const src = b[h];
      const half = Math.ceil(src.value / 2);
      const out = b.slice();
      out[h] = setV(src, half);
      out.splice(h + 1, 0, spawn(c, src, half, src.mult, src.tags));
      return trunc(out);
    }),

  mk('budding', 'Budding Vat', 'generative', 'rare', 10,
    (l) => `every volatile part spawns a copy behind it at x${L(l, 0.5, 0.7, 1)} value`,
    (b, c, l) => {
      const f = L(l, 0.5, 0.7, 1);
      const out: Batch = [];
      for (const p of b) {
        out.push(cp(p));
        if (has(p, 'volatile') && out.length < MAX_BATCH) {
          out.push(spawn(c, p, p.value * f, p.mult, p.tags));
        }
      }
      return trunc(out);
    }),

  mk('assembler', 'Assembler', 'generative', 'uncommon', 8,
    (l) => `add a metal part worth ${L(l, 7, 12, 18)} per part in the batch`,
    (b, c, l) => {
      const src: Part = b.length > 0 ? b[0] : { id: 'asm', def: 'billet', value: 0, mult: 1, tags: ['metal'] };
      const out = b.slice();
      out.push(spawn(c, src, L(l, 7, 12, 18) * b.length, 1, ['metal']));
      return trunc(out);
    }),

  mk('overflow', 'Overflow', 'generative', 'rare', 11,
    (l) => `${L(l, 3, 3, 4)} parts or fewer: duplicate every part. Otherwise +${L(l, 10, 16, 24)} last`,
    (b, c, l) => {
      if (b.length === 0) return [];
      if (b.length <= L(l, 3, 3, 4)) {
        const out: Batch = [];
        for (const p of b) {
          out.push(cp(p));
          if (out.length < MAX_BATCH) out.push(spawn(c, p, p.value, p.mult, p.tags));
        }
        return trunc(out);
      }
      return at(b, b.length - 1, (p) => addV(p, L(l, 10, 16, 24)));
    }),

  mk('shadow', 'Shadow Cast', 'generative', 'uncommon', 7,
    (l) => `copy the lowest part to the front at x${L(l, 1.5, 2, 2.5)} mult`,
    (b, c, l) => {
      const o = lo(b);
      if (o < 0) return [];
      const src = b[o];
      const out = b.slice();
      out.unshift(spawn(c, src, src.value, src.mult * L(l, 1.5, 2, 2.5), src.tags));
      return trunc(out);
    }),

  mk('weld', 'Welder', 'generative', 'uncommon', 8,
    (l) => `add a part worth ${L(l, 50, 75, 100)}% of first + last`,
    (b, c, l) => {
      if (b.length === 0) return [];
      const first = b[0], last = b[b.length - 1];
      const out = b.slice();
      out.push(spawn(c, first, (first.value + last.value) * L(l, 0.5, 0.75, 1), 1, [tagOf(first)]));
      return trunc(out);
    }),

  mk('lathe', 'Lathe', 'generative', 'rare', 10,
    (l) => `copy every part with the first part's tag to the back at x${L(l, 0.5, 0.7, 0.9)} value`,
    (b, c, l) => {
      if (b.length === 0) return [];
      const t = tagOf(b[0]), f = L(l, 0.5, 0.7, 0.9);
      const out = b.slice();
      for (const p of b) {
        if (out.length >= MAX_BATCH) break;
        if (has(p, t)) out.push(spawn(c, p, p.value * f, p.mult, p.tags));
      }
      return trunc(out);
    }),
];

// ===========================================================================
// CONDITIONAL — the payoff layer. Every one has an else-branch (R1): an
// inactive conditional that did nothing would commute with all 70+ machines,
// and would also be a dead card in hand.
// ===========================================================================

/** true when values are non-decreasing left to right */
function ascending(b: Batch): boolean {
  for (let i = 1; i < b.length; i++) if (b[i].value < b[i - 1].value) return false;
  return true;
}
function descending(b: Batch): boolean {
  for (let i = 1; i < b.length; i++) if (b[i].value > b[i - 1].value) return false;
  return true;
}

const CONDITIONAL: MachineDef[] = [
  mk('bulk', 'Bulk Run', 'conditional', 'uncommon', 8,
    (l) => `${L(l, 5, 4, 4)}+ parts: x${L(l, 2, 2.4, 3)} mult each, x${L(l, 3, 3.6, 4.5)} for parts over ${L(l, 60, 50, 40)}. Else copy the first part`,
    (b, c, l) => {
      if (b.length >= L(l, 5, 4, 4)) {
        const t = L(l, 60, 50, 40), lowF = L(l, 2, 2.4, 3), hiF = L(l, 3, 3.6, 4.5);
        return all(b, (p) => mulM(p, p.value > t ? hiF : lowF));
      }
      if (b.length === 0) return [];
      const out = b.slice();
      out.splice(1, 0, spawn(c, b[0], b[0].value, b[0].mult, b[0].tags));
      return trunc(out);
    }),
  mk('sparse', 'Short Run', 'conditional', 'uncommon', 8,
    (l) => `2 parts or fewer: +${L(l, 60, 80, 100)}% value and +${L(l, 40, 65, 95)} each. Else the last part is lost`,
    (b, _c, l) => (b.length <= 2
      ? all(b, (p) => aff(p, L(l, 1.6, 1.8, 2), L(l, 40, 65, 95)))
      : b.slice(0, b.length - 1))),

  mk('purity', 'Purity Clamp', 'conditional', 'rare', 11,
    (l) => `all one tag: x${L(l, 2.5, 3.5, 4.5)} mult and +${L(l, 30, 45, 60)}% value each, sorted high to low. Else x${L(l, 1.4, 1.6, 1.8)} mult first`,
    (b, _c, l) => {
      if (b.length === 0) return [];
      if (oneTag(b) === null) return at(b, 0, (p) => mulM(p, L(l, 1.4, 1.6, 1.8)));
      const f = L(l, 2.5, 3.5, 4.5), v = L(l, 1.3, 1.45, 1.6);
      return b.map((p, i) => ({ p, i })).sort((x, y) => (y.p.value - x.p.value) || (x.i - y.i))
        .map((x) => aff(mulM(x.p, f), v, 0));
    }),

  mk('ascend', 'Ascending Check', 'conditional', 'uncommon', 8,
    (l) => `values rising: x${L(l, 2.2, 3, 4)} mult last. Else move the lowest to the front`,
    (b, _c, l) => {
      if (b.length === 0) return [];
      if (ascending(b)) return at(b, b.length - 1, (p) => mulM(p, L(l, 2.2, 3, 4)));
      const o = lo(b);
      const out = b.slice();
      out.splice(o, 1);
      out.unshift(cp(b[o]));
      return out;
    }),

  mk('descend', 'Descending Check', 'conditional', 'uncommon', 8,
    (l) => `values falling: +${L(l, 35, 50, 70)}% value and +${L(l, 25, 40, 60)} each. Else reverse the batch`,
    (b, _c, l) => {
      if (b.length === 0) return [];
      if (descending(b)) return all(b, (p) => aff(p, L(l, 1.35, 1.5, 1.7), L(l, 25, 40, 60)));
      const out: Batch = new Array(b.length);
      for (let i = 0; i < b.length; i++) out[i] = b[b.length - 1 - i];
      return out;
    }),

  mk('fuse', 'Fuse Box', 'conditional', 'uncommon', 8,
    (l) => `first part volatile: x${L(l, 2.5, 3.5, 4.5)} mult last. Else +${L(l, 14, 22, 32)} first`,
    (b, _c, l) => {
      if (b.length === 0) return [];
      return has(b[0], 'volatile')
        ? at(b, b.length - 1, (p) => mulM(p, L(l, 2.5, 3.5, 4.5)))
        : at(b, 0, (p) => addV(p, L(l, 14, 22, 32)));
    }),

  mk('crown', 'Crown Check', 'conditional', 'rare', 10,
    (l) => `first part is the highest: x${L(l, 1.8, 2.2, 2.8)} mult each. Else the highest moves to the front`,
    (b, _c, l) => {
      const h = hi(b);
      if (h < 0) return [];
      return h === 0 ? all(b, (p) => mulM(p, L(l, 1.8, 2.2, 2.8))) : toFront(b, h);
    }),

  mk('parity', 'Parity Lock', 'conditional', 'uncommon', 7,
    (l) => `even count: +${L(l, 20, 30, 40)}% value and +${L(l, 16, 26, 40)} each, swap the halves. Else x${L(l, 2, 2.5, 3)} mult the middle`,
    (b, _c, l) => {
      if (b.length === 0) return [];
      if (b.length % 2 !== 0) return at(b, (b.length - 1) / 2, (p) => mulM(p, L(l, 2, 2.5, 3)));
      const n = L(l, 16, 26, 40), f = L(l, 1.2, 1.3, 1.4), m = b.length / 2;
      const out: Batch = [];
      for (let i = m; i < b.length; i++) out.push(aff(b[i], f, n));
      for (let i = 0; i < m; i++) out.push(aff(b[i], f, n));
      return out;
    }),

  mk('adjacent', 'Chain Check', 'conditional', 'uncommon', 8,
    (l) => `two neighbours share a tag: +${L(l, 20, 32, 48)} each. Else the last takes the first's tag`,
    (b, _c, l) => {
      if (b.length === 0) return [];
      for (let i = 1; i < b.length; i++) {
        if (has(b[i], tagOf(b[i - 1]))) return all(b, (p) => addV(p, L(l, 20, 32, 48)));
      }
      return at(b, b.length - 1, (p) => retag(p, tagOf(b[0])));
    }),

  mk('deficit', 'Deficit Alarm', 'conditional', 'rare', 10,
    (l) => `round score under half quota: x${L(l, 2, 2.5, 3)} mult each and reverse. Else x${L(l, 1.5, 1.8, 2.2)} mult first`,
    (b, c, l) => {
      const behind = c && c.quota > 0 ? c.score < c.quota / 2 : true;
      if (!behind) return at(b, 0, (p) => mulM(p, L(l, 1.5, 1.8, 2.2)));
      const f = L(l, 2, 2.5, 3);
      const out: Batch = new Array(b.length);
      for (let i = 0; i < b.length; i++) out[i] = mulM(b[b.length - 1 - i], f);
      return out;
    }),

  mk('precision_run', 'Tolerance Rig', 'conditional', 'rare', 10,
    (l) => `${L(l, 3, 2, 2)}+ precision parts: x${L(l, 2.2, 2.8, 3.5)} mult each precision. Else the first becomes precision, +${L(l, 12, 20, 30)}`,
    (b, _c, l) => {
      if (b.length === 0) return [];
      return countTag(b, 'precision') >= L(l, 3, 2, 2)
        ? all(b, (p) => (has(p, 'precision') ? mulM(p, L(l, 2.2, 2.8, 3.5)) : cp(p)))
        : at(b, 0, (p) => addV(retag(p, 'precision'), L(l, 12, 20, 30)));
    }),

  mk('threshold', 'Threshold Gate', 'conditional', 'rare', 11,
    (l) => `batch total over ${L(l, 120, 100, 80)}: x${L(l, 1.8, 2.2, 2.6)} mult last, drop the first. Else +${L(l, 20, 30, 40)}% value and +${L(l, 8, 12, 18)} each`,
    (b, _c, l) => {
      if (totalValue(b) <= L(l, 120, 100, 80)) return all(b, (p) => aff(p, L(l, 1.2, 1.3, 1.4), L(l, 8, 12, 18)));
      const hit = at(b, b.length - 1, (p) => mulM(p, L(l, 1.8, 2.2, 2.6)));
      return hit.length <= 1 ? hit : hit.slice(1);
    }),
];

// ===========================================================================
// ECONOMIC — credits are a build. R3: none of these is batch-identity, because
// a credit-only machine would commute with the entire rest of the file.
// Credits are granted through ctx.grantCredits, never by touching RunState.
// ===========================================================================

const ECONOMIC: MachineDef[] = [
  mk('till', 'Till', 'economic', 'common', 5,
    (l) => `${L(l, 1, 2, 3)}c per part. +${L(l, 10, 16, 24)} to the last, then it moves to the front`,
    (b, c, l) => {
      credits(c, L(l, 1, 2, 3) * b.length);
      return toFront(at(b, b.length - 1, (p) => addV(p, L(l, 10, 16, 24))), b.length - 1);
    }),

  mk('broker', 'Broker', 'economic', 'common', 5,
    (l) => `${L(l, 5, 8, 12)}c. x${L(l, 0.5, 0.6, 0.7)} mult the highest, then it moves to the front`,
    (b, c, l) => {
      credits(c, L(l, 5, 8, 12));
      const h = hi(b);
      if (h < 0) return [];
      return toFront(at(b, h, (p) => mulM(p, L(l, 0.5, 0.6, 0.7))), h);
    }),

  mk('payload', 'Payload Levy', 'economic', 'uncommon', 7,
    (l) => `1c per ${L(l, 20, 14, 9)} value of the highest. Halve its mult and send it to the back`,
    (b, c, l) => {
      const h = hi(b);
      if (h < 0) return [];
      credits(c, Math.floor(b[h].value / L(l, 20, 14, 9)));
      return toBack(at(b, h, (p) => mulM(p, 0.5)), h);
    }),

  mk('tariff', 'Tariff', 'economic', 'common', 5,
    (l) => `drop the last part, ${L(l, 6, 10, 15)}c`,
    (b, c, l) => {
      credits(c, L(l, 6, 10, 15));
      if (b.length <= 1) return b.slice();
      return b.slice(0, b.length - 1);
    }),

  mk('smelter', 'Smelter', 'economic', 'uncommon', 7,
    (l) => `drop the lowest part, ${L(l, 4, 7, 10)}c, +${L(l, 10, 16, 24)} to the new lowest`,
    (b, c, l) => {
      credits(c, L(l, 4, 7, 10));
      const o = lo(b);
      if (o < 0) return [];
      const out = b.slice();
      out.splice(o, 1);
      if (out.length === 0) return [addV(b[o], L(l, 10, 16, 24))];
      const o2 = lo(out);
      out[o2] = addV(out[o2], L(l, 10, 16, 24));
      return out;
    }),

  mk('invest', 'Investment', 'economic', 'rare', 10,
    (l) => `each part: +${L(l, 4, 6, 9)}% value and +${L(l, 2, 3, 5)} per 10c held`,
    (b, c, l) => {
      const held = c && Number.isFinite(c.credits) ? Math.max(0, c.credits) : 0;
      const tens = Math.min(Math.floor(held / 10), 25);
      const n = L(l, 2, 3, 5) * tens;
      const f = 1 + L(l, 0.04, 0.06, 0.09) * tens;
      return all(b, (p) => aff(p, f, n));
    }),

  mk('dividend', 'Dividend', 'economic', 'rare', 10,
    (l) => `x mult the first part by 1 + credits/${L(l, 60, 40, 25)} (max x${L(l, 3, 4, 5)}), then it moves to the back`,
    (b, c, l) => {
      const held = c && Number.isFinite(c.credits) ? Math.max(0, c.credits) : 0;
      const f = Math.min(1 + held / L(l, 60, 40, 25), L(l, 3, 4, 5));
      return toBack(at(b, 0, (p) => mulM(p, f)), 0);
    }),

  mk('wage', 'Hazard Pay', 'economic', 'uncommon', 7,
    (l) => `${L(l, 3, 4, 6)}c per volatile part, +${L(l, 14, 22, 34)} each. No volatile: the first part becomes one`,
    (b, c, l) => {
      const n = countTag(b, 'volatile');
      credits(c, L(l, 3, 4, 6) * n);
      if (n === 0) return at(b, 0, (p) => retag(p, 'volatile'));
      const bump = L(l, 14, 22, 34);
      return all(b, (p) => (has(p, 'volatile') ? addV(p, bump) : cp(p)));
    }),

  mk('contract', 'Contract', 'economic', 'uncommon', 7,
    (l) => `3+ parts: ${L(l, 8, 12, 18)}c and drop the first. Else +${L(l, 16, 24, 36)} first`,
    (b, c, l) => {
      if (b.length >= 3) {
        credits(c, L(l, 8, 12, 18));
        return b.slice(1);
      }
      return at(b, 0, (p) => addV(p, L(l, 16, 24, 36)));
    }),

  mk('stipend', 'Stipend', 'economic', 'uncommon', 7,
    (l) => `first shipment of the round: ${L(l, 10, 15, 22)}c, x${L(l, 2, 2.5, 3)} mult last and it moves to the front. Else +${L(l, 25, 35, 50)}% value each`,
    (b, c, l) => {
      const first = !c || !Number.isFinite(c.shipmentIndex) ? true : c.shipmentIndex === 0;
      if (first) {
        credits(c, L(l, 10, 15, 22));
        return toFront(at(b, b.length - 1, (p) => mulM(p, L(l, 2, 2.5, 3))), b.length - 1);
      }
      return all(b, (p) => aff(p, L(l, 1.25, 1.35, 1.5), L(l, 6, 10, 14)));
    }),

  mk('salvage', 'Salvage Line', 'economic', 'common', 5,
    (l) => `${L(l, 2, 3, 5)}c per scrap part, +${L(l, 20, 32, 48)} each. The lowest part becomes scrap`,
    (b, c, l) => {
      credits(c, L(l, 2, 3, 5) * countTag(b, 'scrap'));
      const bump = L(l, 20, 32, 48);
      const out = all(b, (p) => (has(p, 'scrap') ? addV(p, bump) : cp(p)));
      const o = lo(b);
      if (o >= 0) out[o] = retag(out[o], 'scrap');
      return out;
    }),

  mk('bonded', 'Bonded Store', 'economic', 'rare', 11,
    (l) => `1c per ${L(l, 25, 18, 12)} batch value. Sort low to high`,
    (b, c, l) => {
      credits(c, Math.floor(totalValue(b) / L(l, 25, 18, 12)));
      return b.map((p, i) => ({ p, i })).sort((x, y) => (x.p.value - y.p.value) || (x.i - y.i)).map((x) => cp(x.p));
    }),
];

// ===========================================================================
// TRANSMUTATION — rewrites what a part *is*. This archetype is where the Tall
// build lives (`realize`, `absorb`, `siphon`) and where Purity gets its setup
// (`alloy`, `ferment`, `graft`).
// ===========================================================================

const TRANSMUTATION: MachineDef[] = [
  mk('alloy', 'Alloy Bath', 'transmutation', 'common', 6,
    (l) => `all parts become metal, +${L(l, 20, 30, 40)}% value and +${L(l, 8, 14, 22)} each, swap the ends`,
    (b, _c, l) => {
      const n = L(l, 8, 14, 22), f = L(l, 1.2, 1.3, 1.4);
      return swapAt(all(b, (p) => aff(retag(p, 'metal'), f, n)), 0, b.length - 1);
    }),

  mk('ferment', 'Ferment Tank', 'transmutation', 'common', 6,
    (l) => `all parts become organic, x${L(l, 1.4, 1.6, 1.9)} mult the last`,
    (b, _c, l) => {
      const out = all(b, (p) => retag(p, 'organic'));
      if (out.length > 0) out[out.length - 1] = mulM(out[out.length - 1], L(l, 1.4, 1.6, 1.9));
      return out;
    }),

  mk('destabilize', 'Destabiliser', 'transmutation', 'uncommon', 7,
    (l) => `the first ${PARTS(L(l, 1, 2, 3))} become volatile, x${L(l, 1.8, 2.1, 2.4)} mult, and move to the back`,
    (b, _c, l) => {
      const k = Math.min(L(l, 1, 2, 3), b.length), f = L(l, 1.8, 2.1, 2.4);
      const out: Batch = [];
      for (let i = k; i < b.length; i++) out.push(cp(b[i]));
      for (let i = 0; i < k; i++) out.push(mulM(retag(b[i], 'volatile'), f));
      return out;
    }),

  mk('calibrate', 'Calibrator', 'transmutation', 'uncommon', 7,
    (l) => `the last ${PARTS(L(l, 1, 2, 3))} become precision, +${L(l, 16, 26, 38)} each`,
    (b, _c, l) => {
      const k = L(l, 1, 2, 3), n = L(l, 16, 26, 38);
      return all(b, (p, i) => (i >= b.length - k ? addV(retag(p, 'precision'), n) : cp(p)));
    }),

  mk('condense', 'Condenser', 'transmutation', 'rare', 10,
    (l) => `each part: +1 mult per ${L(l, 30, 20, 12)} value, then value becomes ${L(l, 6, 9, 14)}`,
    (b, _c, l) => {
      const d = L(l, 30, 20, 12), v = L(l, 6, 9, 14);
      return all(b, (p) => setV(setM(p, p.mult + p.value / d), v));
    }),

  mk('realize', 'Realiser', 'transmutation', 'legendary', 15,
    (l) => `each part: value x mult, mult becomes ${L(l, 1, 1.2, 1.5)}`,
    (b, _c, l) => { const m = L(l, 1, 1.2, 1.5); return all(b, (p) => setM(setV(p, p.value * p.mult), m)); }),

  mk('equalize', 'Equaliser', 'transmutation', 'uncommon', 8,
    (l) => `every part takes the average value, +${L(l, 6, 10, 16)}`,
    (b, _c, l) => {
      if (b.length === 0) return [];
      const avg = totalValue(b) / b.length + L(l, 6, 10, 16);
      return all(b, (p) => setV(p, avg));
    }),

  mk('siphon', 'Siphon', 'transmutation', 'rare', 10,
    (l) => `the last part takes the first part's value; the first drops to ${L(l, 0, 5, 10)}`,
    (b, _c, l) => {
      if (b.length < 2) return b.slice();
      const out = b.slice();
      out[out.length - 1] = addV(b[b.length - 1], b[0].value);
      out[0] = setV(b[0], L(l, 0, 5, 10));
      return out;
    }),

  mk('absorb', 'Absorber', 'transmutation', 'rare', 11,
    (l) => `the highest part eats the lowest (x${L(l, 1, 1.25, 1.5)} its value) and the lowest is dropped`,
    (b, _c, l) => {
      if (b.length < 2) return b.slice();
      const h = hi(b), o = lo(b);
      if (h === o) return b.slice();
      const out = b.slice();
      out[h] = addV(b[h], b[o].value * L(l, 1, 1.25, 1.5));
      out.splice(o, 1);
      return out;
    }),

  mk('standardize', 'Standardiser', 'transmutation', 'rare', 10,
    (l) => `every part meets the highest halfway in value, x${L(l, 0.5, 0.6, 0.75)} mult each`,
    (b, _c, l) => {
      const h = hi(b);
      if (h < 0) return [];
      const v = b[h].value, f = L(l, 0.5, 0.6, 0.75);
      return all(b, (p) => mulM(setV(p, (p.value + v) / 2), f));
    }),

  mk('graft', 'Grafter', 'transmutation', 'uncommon', 8,
    (l) => `every part takes the tag of the one before it, +${L(l, 25, 35, 45)}% value each`,
    (b, _c, l) => {
      const f = L(l, 1.25, 1.35, 1.45);
      return all(b, (p, i) => aff(i === 0 ? cp(p) : retag(p, tagOf(b[i - 1])), f, 0));
    }),

  mk('invert', 'Inverter', 'transmutation', 'rare', 11,
    (l) => `swap each part's value and mult (mult capped at ${L(l, 12, 20, 30)})`,
    (b, _c, l) => {
      const capM = L(l, 12, 20, 30);
      return all(b, (p) => {
        const q = cp(p);
        q.value = cv(p.mult);
        q.mult = cm(Math.min(p.value, capM));
        return q;
      });
    }),
];

// ===========================================================================
// IDENTITY — the alchemy. These machines rewrite what a part IS: they walk it up
// the tier ladder (Offcut -> Bolt -> Gear -> Pump -> Engine -> Reactor -> Monument),
// fuse two parts into a better one, or vandalise a good part back into scrap for a
// mult payout. This is the archetype the game is *about*; the numbers are the
// scoreboard, the objects are the reason to look at the screen.
//
// They are also, incidentally, the most order-sensitive machines in the file: a
// promotion changes a part's value AND its tag AND which part is now the highest,
// so almost nothing commutes with them.
// ===========================================================================

const IDENTITY: MachineDef[] = [
  mk('foundry', 'Foundry', 'transmutation', 'common', 6,
    (l) => `promote the first ${PARTS(L(l, 1, 2, 2))} one tier`,
    (b, _c, l) => { const k = L(l, 1, 2, 2); return all(b, (p, i) => (i < k ? promote(p, 1) : cp(p))); }),

  mk('kiln', 'Kiln', 'transmutation', 'uncommon', 9,
    (l) => `promote the highest part ${TIERS(L(l, 1, 1, 2))}`,
    (b, _c, l) => {
      const h = hi(b);
      if (h < 0) return [];
      return at(b, h, (p) => promote(p, L(l, 1, 1, 2)));
    }),

  mk('crucible', 'Crucible', 'transmutation', 'uncommon', 9,
    (l) => `fuse the two lowest parts into one, one tier above the better of them${L(l, '', ', +20', ', +50')}`,
    (b, _c, l) => {
      if (b.length < 2) return b.slice();
      const order = b.map((p, i) => ({ p, i })).sort((x, y) => (x.p.value - y.p.value) || (x.i - y.i));
      const a = order[0], z = order[1];
      const better = a.p.value >= z.p.value ? a.p : z.p;
      const fused = addV(promote(setM(better, Math.max(a.p.mult, z.p.mult)), 1), L(l, 0, 20, 50));
      const drop = new Set([a.i, z.i]);
      const out: Batch = [];
      for (let i = 0; i < b.length; i++) {
        if (i === Math.min(a.i, z.i)) out.push(fused);
        else if (!drop.has(i)) out.push(cp(b[i]));
      }
      return out;
    }),

  mk('assembly_line', 'Assembly Line', 'conditional', 'rare', 12,
    (l) => `if every part shares a tag: promote them all ${TIERS(L(l, 1, 1, 2))}. Otherwise nothing`,
    (b, _c, l) => {
      if (b.length === 0 || oneTag(b) === null) return b.slice();
      const n = L(l, 1, 1, 2);
      return all(b, (p) => promote(p, n));
    }),

  mk('corrupter', 'Corrupter', 'transmutation', 'uncommon', 8,
    (l) => `every part becomes an Offcut, x${L(l, 2.5, 3.5, 4.5)} mult each`,
    (b, _c, l) => { const f = L(l, 2.5, 3.5, 4.5); return all(b, (p) => corrupt(p, f)); }),

  mk('catalyst', 'Catalyst', 'transmutation', 'uncommon', 9,
    (l) => `promote every volatile part ${TIERS(L(l, 1, 1, 2))}. No volatile parts: the highest becomes one`,
    (b, _c, l) => {
      const n = L(l, 1, 1, 2);
      if (countTag(b, 'volatile') === 0) {
        const h = hi(b);
        return h < 0 ? [] : at(b, h, (p) => retag(p, 'volatile'));
      }
      return all(b, (p) => (has(p, 'volatile') ? promote(p, n) : cp(p)));
    }),

  mk('escalator', 'Escalator', 'positional', 'uncommon', 8,
    () => 'promote the last part one tier, then it moves to the front',
    (b) => (b.length === 0 ? [] : toFront(at(b, b.length - 1, (p) => promote(p, 1)), b.length - 1))),

  mk('tribute', 'Tribute', 'filter', 'rare', 11,
    (l) => `drop the lowest part, promote the highest ${TIERS(L(l, 1, 1, 2))}`,
    (b, _c, l) => {
      if (b.length < 2) return b.slice();
      const h = hi(b), o = lo(b);
      const out = at(b, h, (p) => promote(p, L(l, 1, 1, 2)));
      out.splice(o, 1);
      return out;
    }),

  mk('chain_forge', 'Chain Forge', 'conditional', 'rare', 11,
    () => 'promote every part worth more than the part before it',
    (b) => all(b, (p, i) => (i > 0 && p.value > b[i - 1].value ? promote(p, 1) : cp(p)))),

  mk('recycler', 'Recycler', 'transmutation', 'common', 6,
    (l) => `promote every scrap part ${TIERS(L(l, 2, 2, 3))}. No scrap: the lowest part is ground into an Offcut`,
    (b, _c, l) => {
      const n = L(l, 2, 2, 3);
      if (countTag(b, 'scrap') === 0) {
        const o = lo(b);
        return o < 0 ? [] : at(b, o, (p) => corrupt(p, 1));
      }
      return all(b, (p) => (has(p, 'scrap') ? promote(p, n) : cp(p)));
    }),

  mk('masterwork', 'Masterwork', 'conditional', 'legendary', 16,
    (l) => `${L(l, 1, 2, 2)} part${L(l, '', 's', 's')} or fewer in the batch: promote every part ${TIERS(L(l, 2, 3, 4))}. Otherwise nothing`,
    (b, _c, l) => {
      const k = L(l, 1, 2, 2), n = L(l, 2, 3, 4);
      return b.length <= k && b.length > 0 ? all(b, (p) => promote(p, n)) : b.slice();
    }),

  mk('pattern_shop', 'Pattern Shop', 'generative', 'rare', 11,
    (l) => `copy the highest part and promote the copy ${TIERS(L(l, 1, 1, 2))}`,
    (b, c, l) => {
      const h = hi(b);
      if (h < 0) return [];
      const src = b[h];
      const up = promote(src, L(l, 1, 1, 2));
      const out = b.slice();
      out.push(spawn(c, up, up.value, up.mult, up.tags));
      out[out.length - 1].def = up.def;
      return trunc(out);
    }),

  mk('gilder', 'Gilder', 'transmutation', 'rare', 10,
    (l) => `promote every part below ${L(l, 20, 40, 70)} value one tier`,
    (b, _c, l) => { const t = L(l, 20, 40, 70); return all(b, (p) => (p.value < t ? promote(p, 1) : cp(p))); }),

  mk('reliquary', 'Reliquary', 'conditional', 'rare', 12,
    (l) => `if a part is Pump tier or better: x${L(l, 2, 2.6, 3.2)} mult the whole batch. Otherwise nothing`,
    (b, _c, l) => {
      let found = false;
      for (const p of b) if (tierOf(p) >= 3) { found = true; break; }
      if (!found) return b.slice();
      const f = L(l, 2, 2.6, 3.2);
      return all(b, (p) => mulM(p, f));
    }),

  mk('teardown', 'Teardown', 'generative', 'uncommon', 8,
    (l) => `the highest part is torn into ${L(l, 2, 3, 3)} Offcuts that keep its mult`,
    (b, c, l) => {
      const h = hi(b);
      if (h < 0) return [];
      const src = b[h];
      const k = L(l, 2, 3, 3);
      const each = Math.ceil(src.value / k) + L(l, 4, 8, 14);
      const out: Batch = [];
      for (let i = 0; i < b.length; i++) {
        if (i !== h) { out.push(cp(b[i])); continue; }
        for (let j = 0; j < k && out.length < MAX_BATCH; j++) {
          const q = spawn(c, src, each, src.mult, TIER_LADDER[0].tags);
          q.def = TIER_LADDER[0].def;
          out.push(q);
        }
      }
      return trunc(out);
    }),

  mk('provenance', 'Provenance', 'arithmetic', 'uncommon', 8,
    (l) => `each part: +${L(l, 12, 18, 25)}% value and +${L(l, 10, 16, 24)} per tier it stands above Offcut`,
    (b, _c, l) => {
      const n = L(l, 10, 16, 24), f = L(l, 1.12, 1.18, 1.25);
      return all(b, (p) => aff(p, f, n * tierOf(p)));
    }),
];

// ===========================================================================
// CONVEYOR — machines that read a part's NEIGHBOUR. These are the most
// order-sensitive designs available (moving one machine changes what every part
// is standing next to) and the most legible on a belt: the thing in front of you
// affects you. If this file ever drifts back toward flat arithmetic, add more of
// these rather than more +n.
// ===========================================================================

const CONVEYOR: MachineDef[] = [
  mk('slipstream', 'Slipstream', 'arithmetic', 'uncommon', 7,
    (l) => `+${L(l, 16, 26, 38)} to every part standing behind the highest one`,
    (b, _c, l) => {
      const n = L(l, 16, 26, 38), h = hi(b);
      if (h < 0) return [];
      return all(b, (p, i) => (i > h ? addV(p, n) : cp(p)));
    }),

  mk('drag', 'Drag Chain', 'arithmetic', 'uncommon', 8,
    (l) => `each part sheds ${L(l, 20, 30, 40)}% of its value onto the next one`,
    (b, _c, l) => {
      const f = L(l, 0.2, 0.3, 0.4);
      const out: Batch = new Array(b.length);
      for (let i = 0; i < b.length; i++) {
        const shed = Math.floor(b[i].value * f);
        const gain = i > 0 ? Math.floor(b[i - 1].value * f) : 0;
        out[i] = addV(b[i], gain - (i < b.length - 1 ? shed : 0));
      }
      return out;
    }),

  mk('metronome', 'Metronome', 'positional', 'uncommon', 7,
    (l) => `one sorting pass: each pair swaps if the second is worth more${L(l, '', ', twice', ', three times')}`,
    (b, _c, l) => {
      let cur = b.slice();
      const passes = L(l, 1, 2, 3);
      for (let k = 0; k < passes; k++) {
        const nxt = cur.slice();
        for (let i = 0; i + 1 < nxt.length; i++) {
          if (nxt[i + 1].value > nxt[i].value) {
            const tmp = nxt[i];
            nxt[i] = nxt[i + 1];
            nxt[i + 1] = tmp;
          }
        }
        cur = nxt;
      }
      return cur.map(cp);
    }),

  mk('contagion', 'Contagion', 'transmutation', 'uncommon', 8,
    (l) => `every part worth less than the one in front of it becomes volatile, x${L(l, 1.4, 1.7, 2)} mult`,
    (b, _c, l) => {
      const f = L(l, 1.4, 1.7, 2);
      return all(b, (p, i) => (i > 0 && p.value < b[i - 1].value ? mulM(retag(p, 'volatile'), f) : cp(p)));
    }),

  mk('handover', 'Handover', 'positional', 'rare', 9,
    (l) => `every part hands ${L(l, 'its mult', 'its mult', 'its mult and 20% of its value')} to the part behind it`,
    (b, _c, l) => {
      if (b.length < 2) return b.slice();
      const bleed = L(l, 0, 0, 0.2);
      const out: Batch = new Array(b.length);
      for (let i = 0; i < b.length; i++) {
        const src = b[(i + b.length - 1) % b.length];
        const q = setM(b[i], src.mult);
        out[i] = bleed > 0 ? addV(q, Math.floor(src.value * bleed)) : q;
      }
      return out;
    }),
];

// ===========================================================================
// GAMBLES — six machines, all of them coin flips, all of them saying so on the tin.
// A run that ends because the Roulette missed is a story you tell someone. A run
// that ends because you mis-ordered eight commuting adders is homework you failed.
// Each takes exactly one draw from ctx.rng at one fixed point, so preview == play.
// ===========================================================================

const GAMBLE: MachineDef[] = [
  mk('roulette', 'Roulette', 'conditional', 'uncommon', 8,
    (l) => `50%: x${L(l, 5, 7, 9)} mult the last part. 50%: nothing`,
    (b, c, l) => (roll(c) < 0.5 ? at(b, b.length - 1, (p) => mulM(p, L(l, 5, 7, 9))) : b.slice())),

  mk('jackpot', 'Jackpot', 'economic', 'uncommon', 8,
    (l) => `1 in 4: ${L(l, 45, 70, 100)}c and x${L(l, 2, 2.5, 3)} mult the last part. Otherwise 2c and +8 first`,
    (b, c, l) => {
      if (roll(c) >= 0.25) { credits(c, 2); return at(b, 0, (p) => addV(p, 8)); }
      credits(c, L(l, 45, 70, 100));
      return at(b, b.length - 1, (p) => mulM(p, L(l, 2, 2.5, 3)));
    }),

  mk('wildcard', 'Wildcard', 'transmutation', 'rare', 11,
    (l) => `${L(l, 30, 40, 55)}%: promote every part one tier. Otherwise every part becomes an Offcut`,
    (b, c, l) => (roll(c) * 100 < L(l, 30, 40, 55)
      ? all(b, (p) => promote(p, 1))
      : all(b, (p) => corrupt(p, 1.5)))),

  mk('dice_press', 'Dice Press', 'arithmetic', 'common', 5,
    (l) => `+1 to +${L(l, 26, 42, 64)} to each part, rolled once. The highest part gets it twice`,
    (b, c, l) => {
      const n = 1 + Math.floor(roll(c) * L(l, 26, 42, 64));
      const out = all(b, (p) => addV(p, n));
      const h = hi(b);
      if (h >= 0) out[h] = addV(out[h], n);
      return out;
    }),

  mk('gremlin', 'Gremlin', 'filter', 'uncommon', 7,
    (l) => `50%: drop the lowest part, x${L(l, 2.5, 3, 3.5)} mult and +20% value the rest. 50%: drop the highest`,
    (b, c, l) => {
      if (b.length < 2) return b.slice();
      if (roll(c) < 0.5) {
        const out = b.slice();
        out.splice(lo(b), 1);
        return all(out, (p) => aff(mulM(p, L(l, 2.5, 3, 3.5)), 1.2, 0));
      }
      const out = b.slice();
      out.splice(hi(b), 1);
      return out;
    }),

  mk('lucky_run', 'Lucky Run', 'generative', 'rare', 11,
    (l) => `1 in ${L(l, 4, 3, 3)}: duplicate the whole batch. Otherwise +${L(l, 6, 10, 16)} last`,
    (b, c, l) => {
      if (b.length === 0) return [];
      if (roll(c) < 1 / L(l, 4, 3, 3)) {
        const out = b.slice();
        for (const p of b) {
          if (out.length >= MAX_BATCH) break;
          out.push(spawn(c, p, p.value, p.mult, p.tags));
        }
        return trunc(out);
      }
      return at(b, b.length - 1, (p) => addV(p, L(l, 6, 10, 16)));
    }),
];

// ===========================================================================
// RETRIGGER — the only machines in this file whose value grows with the LINE
// rather than with the batch.
//
// Why they exist. A shipment is one pass through at most 8 machines. Eight
// machines each worth roughly a doubling bounds a shipment at ~256x, and the
// measurements land exactly there: the biggest number a median winning player
// ever saw was four digits (VERDICT-1 §2.4). That is not a number anyone posts,
// and it is not fixable by making machines stronger — the exponent is the slot
// count, and the slot count is 8.
//
// These four change the exponent. A retrigger asks the ENGINE to run the span of
// machines immediately before it a second (or third) time, so a line of
// 6 multipliers plus a retrigger over the last 3 is worth 2^9, not 2^6. The
// exponent now grows with what the player ACQUIRED, which is the property Balatro's
// scoring has and this game did not.
//
// Three consequences, all deliberate:
//
//  - ORDER MATTERS MORE, NOT LESS. A retrigger is worth exactly the span sitting in
//    front of it. Bought and dropped at the end of a line it repeats whatever is
//    there; moved one slot, it repeats something else. This is the single most
//    order-sensitive object in the set, which is the opposite of what a flat
//    "x10 score" legendary would have been.
//  - THE SCREENSHOT IS THE MACHINE'S OWN ROW. The engine folds the whole loop into
//    the retrigger's stage, so "WHY THE NUMBER MOVED" prints the entire repeat as
//    one enormous bar under the retrigger's name.
//  - REACHABLE BY A BUILD, NOT BY DEFAULT. Measured over 400 planner runs on the
//    shipped tuning: 12.8% of runs acquire any retrigger at all. Those runs finish at
//    a median 12.1x the final quota and a p95 of 995x; the runs that do not finish at
//    1.3x and 7.4x. That is the shape this change is for — a fat right tail, not a
//    new floor. The whole family is worth +2.0pp of planner win rate, which is the
//    number that says it is a ceiling and not a buff.
//
//    KNOWN, MEASURED, NOT FIXED: `graveyard` was acquired 0 times in those 400 runs.
//    So were `realize` and `masterwork`, the two legendaries that predate it, so this
//    is the shop's rarity/price economics and not this machine — `rarityWeight` in
//    engine/run.ts is where it would be fixed and that dial was out of scope here.
//    Every number above is therefore carried by `repeater`, `relay` and
//    `second_shift`; the legendary is currently design, not measurement.
//
// The protocol they speak (`ctx.memo.__repeat` / `__repeat_span`) is documented in
// engine/run.ts under THE REPEAT PROTOCOL. Repeats never nest and the engine caps
// total applications per shipment, so a retrigger cannot run away.
// ===========================================================================

/**
 * Ask the engine to run the `span` machines immediately before this one `passes`
 * more times. A no-op when the requesting machine is first in the line.
 */
function repeat(ctx: RunCtx, span: number, passes: number): void {
  if (!ctx || !ctx.memo) return;
  ctx.memo.__repeat = Math.max(1, Math.floor(passes));
  ctx.memo.__repeat_span = Math.max(1, Math.floor(span));
}

const RETRIGGER: MachineDef[] = [
  // The workhorse. Two machines wide, so it is worth whatever pair the player parks
  // in front of it — and worth almost nothing at the head of the line.
  mk('repeater', 'Repeater', 'positional', 'uncommon', 10,
    (l) => `the ${L(l, 2, 3, 3)} machines before this run again${L(l, '', '', ', twice')}; the last part moves to the front`,
    (b, c, l) => {
      repeat(c, L(l, 2, 3, 3), L(l, 1, 1, 2));
      return b.length > 1 ? toFront(b, b.length - 1) : b.slice();
    }),

  // The cheap one, and the one that teaches the idea. Span 1: it repeats exactly the
  // machine standing in front of it, so the first thing a player learns about a
  // retrigger is that its value IS its neighbour.
  mk('relay', 'Relay', 'positional', 'uncommon', 9,
    (l) => `the machine before this runs again${L(l, '', ', twice', ', twice')}; the first part moves to the back`,
    (b, c, l) => {
      repeat(c, L(l, 1, 1, 2), L(l, 1, 2, 2));
      return b.length > 1 ? toBack(b, 0) : b.slice();
    }),

  // The build. Gated on a single-tag batch, which is a thing the player has to WANT
  // and has a whole archetype's worth of enablers for (alloy, ferment, the sieves,
  // graft). It pays nothing at all to a line that just fills up.
  mk('second_shift', 'Second Shift', 'conditional', 'rare', 11,
    (l) => `all one tag: the ${L(l, 2, 2, 3)} machines before this run again twice. Else +${L(l, 22, 34, 50)} first`,
    (b, c, l) => {
      if (b.length === 0) return [];
      if (oneTag(b) === null) return at(b, 0, (p) => addV(p, L(l, 22, 34, 50)));
      repeat(c, L(l, 2, 2, 3), 2);
      return swapAt(b, 0, b.length - 1);
    }),

  // The ceiling. Legendary, and it reaches back over half a full line — this is the
  // one that produces a number worth showing someone, and it is meant to be the
  // rarest thing a run can be built around.
  mk('graveyard', 'Graveyard Shift', 'positional', 'legendary', 16,
    (l) => `the ${L(l, 3, 4, 5)} machines before this all run again; +${L(l, 14, 22, 34)} to the last part`,
    (b, c, l) => {
      repeat(c, L(l, 3, 4, 5), 1);
      if (b.length === 0) return [];
      return at(b, b.length - 1, (p) => addV(p, L(l, 14, 22, 34)));
    }),
];

// ===========================================================================
// export
// ===========================================================================

export const MACHINES: MachineDef[] = [
  ...ARITHMETIC,
  ...POSITIONAL,
  ...FILTER,
  ...GENERATIVE,
  ...CONDITIONAL,
  ...ECONOMIC,
  ...TRANSMUTATION,
  ...IDENTITY,
  ...CONVEYOR,
  ...GAMBLE,
  ...RETRIGGER,
];

/**
 * The five archetypal winning builds this set is designed to support, each with
 * >= 8 machines. This is a design assertion — the benchmark (G3) is what decides
 * whether all five are actually viable. It is exported so the content test can
 * check the counts and so the sim can label a run's build.
 */
export const BUILD_SUPPORT: Record<string, string[]> = {
  // one enormous object: concentrate value into a part, promote it, then multiply it
  tall: ['hoist', 'xerox', 'absorb', 'siphon', 'realize', 'condense', 'topcut', 'crown',
    'doubler', 'stamp', 'tithe', 'intake', 'quality', 'trim', 'purge', 'threshold',
    'kiln', 'tribute', 'masterwork', 'sparse', 'crucible', 'graveyard'],
  // many small parts: spawn bodies, then pay per body
  wide: ['echo', 'mimic', 'budding', 'assembler', 'overflow', 'shadow', 'weld', 'lathe',
    'scrapper', 'splitter', 'press', 'tally', 'bulk', 'equalize', 'standardize', 'cascade',
    'parity', 'teardown', 'lucky_run', 'corrupter'],
  // single-tag batches: cheap setup, enormous conditional payoff
  purity: ['alloy', 'ferment', 'graft', 'purity', 'sieve_metal', 'sieve_organic',
    'sieve_volatile', 'sieve_precision', 'unique', 'adjacent', 'kinship', 'precision_run',
    'lathe', 'destabilize', 'calibrate', 'tag_sort', 'assembly_line', 'catalyst', 'corrupter',
    'second_shift'],
  // arrange the batch, then cash the arrangement in
  sorting: ['sort_asc', 'sort_desc', 'reverse', 'rot_left', 'rot_right', 'swap_ends',
    'pair_swap', 'halves', 'interleave', 'tag_sort', 'ascend', 'descend', 'crown',
    'ratchet', 'cascade', 'mirror_add', 'sink', 'bonded', 'graft', 'chain_forge', 'escalator',
    'metronome', 'handover', 'drag', 'slipstream', 'repeater', 'relay', 'graveyard'],
  // credits are the score: buy the curve instead of out-scoring it
  economy: ['till', 'broker', 'payload', 'tariff', 'smelter', 'invest', 'dividend', 'wage',
    'contract', 'stipend', 'salvage', 'bonded', 'jackpot'],
  // alchemy: walk junk up the tier ladder until a Monument comes off the belt
  ladder: ['foundry', 'kiln', 'crucible', 'assembly_line', 'catalyst', 'escalator',
    'tribute', 'chain_forge', 'recycler', 'masterwork', 'pattern_shop', 'gilder',
    'reliquary', 'teardown', 'provenance', 'wildcard', 'corrupter', 'salvage'],
};

export const MACHINES_BY_DEF: Map<string, MachineDef> = new Map(MACHINES.map((m) => [m.def, m]));
