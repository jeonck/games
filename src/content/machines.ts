// TAKT — machine content.
//
// DESIGN RULE #1: order must matter. A set of flat `+n each` / `xn each` machines is a
// dead game: every pair commutes, the planner bot ties the greedy bot, G1.5 and G2.3
// fail and the product claim ("the order of your machines IS the game") is a lie.
//
// Four rules were followed while writing this file, and the commutativity test in
// `tests/content.test.ts` is what enforces them:
//
//  R1  No machine is the identity on a >=2-part batch. Conditionals all have an
//      else-branch, so an inactive condition never turns a machine into a no-op
//      (a no-op commutes with everything).
//  R2  Every machine that writes `mult` picks its targets by *value* or by *position*.
//      A machine that multiplies every part's mult unconditionally commutes with every
//      machine that only writes `value` — the two fields are independent.
//  R3  Economic machines always have a batch-side effect. A machine that only grants
//      credits is batch-identity and therefore commutes with all 70+ others.
//  R4  Purely permutation-invariant, value-blind machines are kept to a handful; they
//      are the only ones that commute with the positional archetype.
//
// Everything here is pure: `apply` never mutates `batch` or any `Part` in it, and always
// returns a fresh array. Randomness would come from ctx.rng, but *no machine uses it* —
// the line is fully deterministic so that bot preview == play, which is what makes the
// 20k-run benchmark meaningful.

import type {
  Archetype, Batch, MachineDef, Part, Rarity, RunCtx, Tag,
} from '../engine/types.ts';

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
    (l) => `+${L(l, 4, 7, 11)} each`,
    (b, _c, l) => { const n = L(l, 4, 7, 11); return all(b, (p) => addV(p, n)); }),

  mk('stamp', 'Stamp', 'arithmetic', 'common', 4,
    (l) => `+${L(l, 14, 24, 38)} first`,
    (b, _c, l) => at(b, 0, (p) => addV(p, L(l, 14, 24, 38)))),

  mk('capstone', 'Capstone', 'arithmetic', 'common', 4,
    (l) => `+${L(l, 14, 24, 38)} last`,
    (b, _c, l) => at(b, b.length - 1, (p) => addV(p, L(l, 14, 24, 38)))),

  mk('doubler', 'Doubler', 'arithmetic', 'common', 6,
    (l) => `x${L(l, 2, 2.5, 3)} mult first`,
    (b, _c, l) => at(b, 0, (p) => mulM(p, L(l, 2, 2.5, 3)))),

  mk('tailspin', 'Tailspin', 'arithmetic', 'common', 6,
    (l) => `x${L(l, 2, 2.5, 3)} mult last`,
    (b, _c, l) => at(b, b.length - 1, (p) => mulM(p, L(l, 2, 2.5, 3)))),

  mk('cascade', 'Cascade', 'arithmetic', 'uncommon', 7,
    (l) => `+${L(l, 4, 7, 11)} x position each`,
    (b, _c, l) => { const n = L(l, 4, 7, 11); return all(b, (p, i) => addV(p, n * i)); }),

  mk('tally', 'Tally', 'arithmetic', 'common', 5,
    (l) => `+${L(l, 3, 5, 8)} per part, each`,
    (b, _c, l) => { const n = L(l, 3, 5, 8) * b.length; return all(b, (p) => addV(p, n)); }),

  mk('kinship', 'Kinship', 'arithmetic', 'uncommon', 7,
    (l) => `+${L(l, 6, 10, 15)} each per part sharing the first part's tag`,
    (b, _c, l) => {
      if (b.length === 0) return [];
      const n = L(l, 6, 10, 15) * countTag(b, tagOf(b[0]));
      return all(b, (p) => addV(p, n));
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
    (l) => `-${L(l, 8, 7, 6)} each, x${L(l, 2, 2.6, 3.2)} mult highest`,
    (b, _c, l) => {
      const h = hi(b);
      const cut = L(l, 8, 7, 6);
      const out = all(b, (p) => addV(p, -cut));
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
    (l) => `drop the lowest ${L(l, 1, 1, 2)}, +${L(l, 10, 18, 22)} each`,
    (b, _c, l) => {
      const k = L(l, 1, 1, 2), bump = L(l, 10, 18, 22);
      if (b.length <= k) return all(b, (p) => addV(p, bump));
      const order = b.map((p, i) => ({ p, i })).sort((x, y) => (x.p.value - y.p.value) || (x.i - y.i));
      const drop = new Set(order.slice(0, k).map((x) => x.i));
      const out: Batch = [];
      for (let i = 0; i < b.length; i++) if (!drop.has(i)) out.push(addV(b[i], bump));
      return out;
    }),

  mk('topcut', 'Top Cut', 'filter', 'uncommon', 7,
    (l) => `keep the top ${L(l, 2, 3, 4)} by value, x${L(l, 1.5, 1.6, 1.8)} mult each`,
    (b, _c, l) => {
      const k = L(l, 2, 3, 4), f = L(l, 1.5, 1.6, 1.8);
      if (b.length <= k) return all(b, (p) => mulM(p, f));
      const order = b.map((p, i) => ({ p, i })).sort((x, y) => (y.p.value - x.p.value) || (x.i - y.i));
      const win = new Set(order.slice(0, k).map((x) => x.i));
      const out: Batch = [];
      for (let i = 0; i < b.length; i++) if (win.has(i)) out.push(mulM(b[i], f));
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
    (l) => `keep only metal, +${L(l, 12, 20, 30)} each`,
    (b, _c, l) => keep(b, (p) => has(p, 'metal'), (p) => addV(p, L(l, 12, 20, 30)))),

  mk('sieve_volatile', 'Blast Sieve', 'filter', 'uncommon', 7,
    (l) => `keep only volatile, x${L(l, 2, 2.6, 3.2)} mult each`,
    (b, _c, l) => keep(b, (p) => has(p, 'volatile'), (p) => mulM(p, L(l, 2, 2.6, 3.2)))),

  mk('sieve_organic', 'Organic Sieve', 'filter', 'common', 6,
    (l) => `keep only organic, +${L(l, 16, 26, 40)} each`,
    (b, _c, l) => keep(b, (p) => has(p, 'organic'), (p) => addV(p, L(l, 16, 26, 40)))),

  mk('sieve_precision', 'Gauge', 'filter', 'uncommon', 7,
    (l) => `keep only precision, x${L(l, 1.8, 2.2, 2.8)} mult and +${L(l, 8, 12, 18)} each`,
    (b, _c, l) => keep(b, (p) => has(p, 'precision'),
      (p) => addV(mulM(p, L(l, 1.8, 2.2, 2.8)), L(l, 8, 12, 18)))),

  mk('quality', 'Q-Gate', 'filter', 'uncommon', 7,
    (l) => `drop parts under ${L(l, 10, 18, 28)}, +${L(l, 10, 16, 24)} each`,
    (b, _c, l) => keep(b, (p) => p.value >= L(l, 10, 18, 28), (p) => addV(p, L(l, 10, 16, 24)))),

  mk('unique', 'Assay', 'filter', 'rare', 9,
    (l) => `keep the first part of each tag, x${L(l, 2, 2.5, 3)} mult each`,
    (b, _c, l) => {
      const seen = new Set<Tag>();
      const f = L(l, 2, 2.5, 3);
      return keep(b, (p) => {
        const t = tagOf(p);
        if (seen.has(t)) return false;
        seen.add(t);
        return true;
      }, (p) => mulM(p, f));
    }),

  mk('skipper', 'Skip Chain', 'filter', 'uncommon', 8,
    (l) => `keep every other part, +${L(l, 18, 30, 45)} each`,
    (b, _c, l) => keep(b, (_p, i) => i % 2 === 0, (p) => addV(p, L(l, 18, 30, 45)))),

  mk('intake', 'Intake Gate', 'filter', 'common', 5,
    (l) => `keep the first ${L(l, 2, 3, 4)}, +${L(l, 12, 16, 22)} each`,
    (b, _c, l) => {
      const k = L(l, 2, 3, 4), bump = L(l, 12, 16, 22);
      return keep(b, (_p, i) => i < k, (p) => addV(p, bump));
    }),
];
