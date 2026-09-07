import test from 'node:test';
import assert from 'node:assert/strict';

import type { Batch, MachineDef, Machine, Part, RunState } from '../src/engine/types.ts';
import { PARTS_PER_SHIPMENT, ROUNDS_PER_SHIFT, SHIFTS_PER_RUN, SHIPMENTS_PER_ROUND, MAX_LINE_CAP } from '../src/engine/types.ts';
import type { AuditDef, PartDef, Registry } from '../src/content/registry.ts';
import { buildRegistry, setRegistry } from '../src/content/registry.ts';
import {
  PLACEHOLDER_AUDITS, PLACEHOLDER_BLUEPRINTS, PLACEHOLDER_MACHINES, PLACEHOLDER_PARTS,
  installPlaceholder,
} from '../src/content/placeholder.ts';
import {
  MAX_MACHINE_LEVEL, QUOTA_BASE, buy, newRun, nextRound, previewShipment, playShipment,
  quotaFor, reorderLine, reroll, rollShop, roundCleared, runMemo, scrapParts,
} from '../src/engine/run.ts';

const base = installPlaceholder();

// --- api.ts conformance ----------------------------------------------------
// A compile-time assertion that run.ts implements exactly the frozen declarations.
// (tsc checks this; at runtime the annotation is stripped and only the presence
// check below survives.)
import type * as Api from '../src/engine/api.ts';
import * as Run from '../src/engine/run.ts';

const _conforms: {
  newRun: typeof Api.newRun;
  quotaFor: typeof Api.quotaFor;
  previewShipment: typeof Api.previewShipment;
  playShipment: typeof Api.playShipment;
  scrapParts: typeof Api.scrapParts;
  reorderLine: typeof Api.reorderLine;
  rollShop: typeof Api.rollShop;
  buy: typeof Api.buy;
  reroll: typeof Api.reroll;
  nextRound: typeof Api.nextRound;
  roundCleared: typeof Api.roundCleared;
} = Run;

test('run.ts exports every function declared in api.ts', () => {
  for (const name of [
    'newRun', 'quotaFor', 'previewShipment', 'playShipment', 'scrapParts',
    'reorderLine', 'rollShop', 'buy', 'reroll', 'nextRound', 'roundCleared',
  ]) {
    assert.equal(typeof (Run as Record<string, unknown>)[name], 'function', name);
  }
  assert.ok(_conforms.newRun !== undefined);
});

function usePlaceholder(): void { setRegistry(base); }

/** RunState minus the RNG closure — this is what "byte-identical run" means here. */
function snap(s: RunState): string {
  return JSON.stringify(s, (k, v) => (k === 'rng' ? undefined : v));
}

function line(defs: string[], levels?: number[]): Machine[] {
  return defs.map((d, i) => ({ id: `t${i}`, def: d, level: levels ? levels[i] : 1 }));
}

// ---------------------------------------------------------------------------
test('quotaFor is monotonic in each argument and matches the documented curve', () => {
  usePlaceholder();
  assert.equal(quotaFor(1, 1), QUOTA_BASE);
  for (let sh = 1; sh <= SHIFTS_PER_RUN; sh++) {
    for (let r = 1; r <= ROUNDS_PER_SHIFT; r++) {
      const q = quotaFor(sh, r);
      assert.ok(Number.isInteger(q) && q > 0, `quota(${sh},${r}) = ${q}`);
      if (r > 1) assert.ok(q > quotaFor(sh, r - 1), `round monotonicity at shift ${sh}`);
      if (sh > 1) assert.ok(q > quotaFor(sh - 1, r), `shift monotonicity at round ${r}`);
    }
  }
  // Steep enough that G5's 20x-final-quota tail is a real ceiling, not a rounding error.
  assert.ok(quotaFor(8, 3) / quotaFor(1, 1) > 50);
  // Out-of-range arguments clamp instead of exploding.
  assert.equal(quotaFor(0, 0), quotaFor(1, 1));
  assert.equal(quotaFor(99, 99), quotaFor(SHIFTS_PER_RUN, ROUNDS_PER_SHIFT));
});

test('newRun is deterministic in the seed and well-formed', () => {
  usePlaceholder();
  const a = newRun(4242);
  const b = newRun(4242);
  assert.equal(snap(a), snap(b));
  assert.notEqual(snap(newRun(4243)), snap(a));

  assert.equal(a.shift, 1);
  assert.equal(a.round, 1);
  assert.equal(a.score, 0);
  assert.equal(a.quota, quotaFor(1, 1));
  assert.equal(a.hand.length, a.handSize);
  assert.equal(a.crate.length, 20);
  assert.equal(a.hand.length + a.drawPile.length + a.discard.length, a.crate.length);
  assert.ok(a.line.length > 0 && a.line.length <= a.lineCap);
  assert.equal(a.over, false);
  assert.equal(new Set(a.crate.map((p) => p.id)).size, a.crate.length, 'part ids unique');
});

// ---------------------------------------------------------------------------
// Purity — the load-bearing property.
// ---------------------------------------------------------------------------

/** A machine that does everything a buggy content machine could do. */
const VANDAL: MachineDef = {
  def: 'vandal', name: 'Vandal', archetype: 'arithmetic', rarity: 'common', cost: 5,
  text: () => 'writes through its input on purpose',
  apply: (batch, ctx) => {
    for (const p of batch) {
      p.value += 1000;
      p.mult *= 9;
      p.tags.push('scrap');
      p.id = 'clobbered';
    }
    ctx.memo.vandalised = (ctx.memo.vandalised ?? 0) + 1;
    ctx.grantCredits(99);
    ctx.rng.next();
    return batch;
  },
};

function vandalRegistry(): Registry {
  return buildRegistry({
    machines: [...PLACEHOLDER_MACHINES, VANDAL],
    parts: PLACEHOLDER_PARTS,
    blueprints: PLACEHOLDER_BLUEPRINTS,
    audits: PLACEHOLDER_AUDITS,
    starterCrate: [...Array(20).fill('stub_ingot')],
    starterLine: ['stub_add', 'vandal'],
  });
}

test('previewShipment leaves a structurally identical RunState', () => {
  usePlaceholder();
  const s = newRun(1001);
  const before = snap(s);
  for (let i = 0; i < 50; i++) previewShipment(s, [0, 1, 2, 3, 4]);
  assert.equal(snap(s), before);
});

test('previewShipment cannot be corrupted by a machine that mutates its input', () => {
  setRegistry(vandalRegistry());
  try {
    const s = newRun(1002);
    const before = snap(s);
    const handCopy = s.hand.map((p) => ({ ...p, tags: p.tags.slice() }));

    const res = previewShipment(s, [0, 1, 2]);
    assert.ok(res.gained > 0);

    assert.equal(snap(s), before, 'RunState unchanged');
    for (let i = 0; i < s.hand.length; i++) {
      assert.deepEqual(s.hand[i], handCopy[i], `hand part ${i} untouched`);
      assert.deepEqual(s.hand[i].tags, handCopy[i].tags, `hand part ${i} tags untouched`);
    }
    // The crate holds the same Part objects as the hand; check them too.
    for (const p of s.crate) {
      assert.ok(!p.tags.includes('scrap'));
      assert.notEqual(p.id, 'clobbered');
    }
  } finally { usePlaceholder(); }
});

test('previewShipment does not grant credits or write the live memo', () => {
  setRegistry(vandalRegistry());
  try {
    const s = newRun(1003);
    const credits = s.credits;
    for (let i = 0; i < 20; i++) previewShipment(s, [0, 1]);
    assert.equal(s.credits, credits);
    assert.deepEqual(runMemo(s), {});

    // ...but playShipment does both.
    playShipment(s, [0, 1]);
    assert.ok(s.credits >= credits + 99, 'granted credits landed');
    assert.equal(runMemo(s).vandalised, 1);
  } finally { usePlaceholder(); }
});

test('previewShipment does not advance the run RNG', () => {
  usePlaceholder();
  const a = newRun(1004);
  const b = newRun(1004);
  for (let i = 0; i < 500; i++) {
    previewShipment(a, [i % 3, (i % 3) + 3], line(['stub_reverse', 'stub_add']));
  }
  for (let i = 0; i < 20; i++) assert.equal(a.rng.next(), b.rng.next());
});

test('previewShipment predicts playShipment exactly', () => {
  usePlaceholder();
  const s = newRun(1005);
  for (let n = 0; n < SHIPMENTS_PER_ROUND && !s.over; n++) {
    const idx = [0, 1, 2, 3, 4];
    const pre = previewShipment(s, idx);
    const played = playShipment(s, idx);
    assert.equal(played.gained, pre.gained);
    assert.equal(played.scoreAfter, pre.scoreAfter);
    assert.equal(played.cleared, pre.cleared);
  }
});

test('the line override does not touch s.line, and the entry batch is copied', () => {
  usePlaceholder();
  const s = newRun(1006);
  const owned = s.line.map((m) => m.def);
  const res = previewShipment(s, [0, 1, 2], line(['stub_reverse', 'stub_add', 'stub_add']));
  assert.deepEqual(s.line.map((m) => m.def), owned);
  assert.equal(res.stages.length, 4);
  for (let i = 0; i < 3; i++) {
    assert.notEqual(res.stages[0][i], s.hand[i], 'entry parts are copies, not aliases');
    assert.notEqual(res.stages[0][i].tags, s.hand[i].tags, 'tag arrays are copies too');
  }
  assert.equal(res.stages[res.stages.length - 1].length >= 0, true);
});

test('rejects illegal selections', () => {
  usePlaceholder();
  const s = newRun(1007);
  assert.throws(() => previewShipment(s, []), RangeError);
  assert.throws(() => previewShipment(s, [0, 1, 2, 3, 4, 5]), RangeError);
  assert.throws(() => previewShipment(s, [0, 0]), RangeError);
  assert.throws(() => previewShipment(s, [-1]), RangeError);
  assert.throws(() => previewShipment(s, [s.hand.length]), RangeError);
  assert.equal(PARTS_PER_SHIPMENT, 5);
});

// ---------------------------------------------------------------------------
// Ordering is the product.
// ---------------------------------------------------------------------------

/** two hand indices whose parts score differently, so order can be observed */
function distinctPair(s: RunState): [number, number] {
  for (let i = 0; i < s.hand.length; i++) {
    for (let j = i + 1; j < s.hand.length; j++) {
      if (s.hand[i].value * s.hand[i].mult !== s.hand[j].value * s.hand[j].mult) return [i, j];
    }
  }
  throw new Error('no distinct pair in hand');
}

test('machine order and part order both change the result', () => {
  usePlaceholder();
  const s = newRun(1008);
  const [i, j] = distinctPair(s);

  // reverse o pressFirst != pressFirst o reverse
  const ab = previewShipment(s, [i, j], line(['stub_reverse', 'stub_double_first'], [1, 3]));
  const ba = previewShipment(s, [i, j], line(['stub_double_first', 'stub_reverse'], [3, 1]));
  assert.notEqual(ab.gained, ba.gained, 'A(B(x)) != B(A(x))');

  // the order of the parts inside the batch matters too
  const l = line(['stub_double_first'], [3]);
  const f = previewShipment(s, [i, j], l);
  const g = previewShipment(s, [j, i], l);
  assert.notEqual(f.gained, g.gained, 'batch order matters');
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

function scriptedRun(seed: number): RunState {
  const s = newRun(seed);
  for (let step = 0; step < 60 && !s.over; step++) {
    if (roundCleared(s)) {
      const shop = rollShop(s);
      for (let k = 0; k < shop.items.length; k++) if (buy(s, shop, 0)) break;
      const shop2 = reroll(s, shop);
      buy(s, shop2, 0);
      nextRound(s);
      if (s.line.length > 1) {
        reorderLine(s, s.line.map((_, i) => (s.line.length - 1 - i)));
      }
      continue;
    }
    if (s.scrapsLeft > 0 && step % 5 === 4) { scrapParts(s, [0, 1]); continue; }
    const n = Math.min(PARTS_PER_SHIPMENT, s.hand.length);
    if (n === 0) break;
    playShipment(s, Array.from({ length: n }, (_, i) => i));
  }
  return s;
}

test('same seed, same scripted actions => byte-identical run', () => {
  usePlaceholder();
  for (const seed of [1, 7, 99, 123456, 0xdeadbeef]) {
    const a = scriptedRun(seed);
    const b = scriptedRun(seed);
    assert.equal(snap(a), snap(b), `seed ${seed}`);
  }
});

test('different seeds diverge', () => {
  usePlaceholder();
  const seen = new Set<string>();
  for (let seed = 1; seed <= 12; seed++) seen.add(snap(scriptedRun(seed)));
  assert.ok(seen.size > 1);
});

// ---------------------------------------------------------------------------
// Draw / discard
// ---------------------------------------------------------------------------

test('played parts discard, hand refills, and the discard reshuffles when the pile empties', () => {
  usePlaceholder();
  const s = newRun(2001);
  s.quota = 1e9; // never clear; keep shipping
  let reshuffled = false;
  for (let n = 0; n < SHIPMENTS_PER_ROUND; n++) {
    const before = s.drawPile.length;
    playShipment(s, [0, 1, 2, 3, 4]);
    assert.equal(s.hand.length, Math.min(s.handSize, s.crate.length));
    assert.equal(s.hand.length + s.drawPile.length + s.discard.length, s.crate.length);
    if (s.drawPile.length > before) reshuffled = true;
  }
  assert.equal(s.shipmentsLeft, 0);
  assert.ok(reshuffled, 'discard was shuffled back into the draw pile');
  assert.equal(s.over, true, 'running out of shipments below quota ends the run');
});

test('sticky parts return to hand instead of the discard', () => {
  usePlaceholder();
  const stickyParts: PartDef[] = [
    ...PLACEHOLDER_PARTS,
    {
      def: 'glue', name: 'Glue', value: 4, mult: 1, tags: ['organic'],
      rarity: 'common', cost: 3, sticky: true,
    },
  ];
  setRegistry(buildRegistry({
    machines: PLACEHOLDER_MACHINES, parts: stickyParts,
    blueprints: PLACEHOLDER_BLUEPRINTS, audits: PLACEHOLDER_AUDITS,
    starterCrate: [...Array(4).fill('glue'), ...Array(16).fill('stub_ingot')],
    starterLine: ['stub_add'],
  }));
  try {
    const s = newRun(2002);
    s.quota = 1e9;
    const stickyIdx = s.hand.findIndex((p) => p.sticky === true);
    assert.ok(stickyIdx >= 0, 'a sticky part was dealt');
    const stickyId = s.hand[stickyIdx].id;
    const other = s.hand.findIndex((p) => p.sticky !== true);
    playShipment(s, [stickyIdx, other]);
    assert.ok(s.hand.some((p) => p.id === stickyId), 'sticky part is still in hand');
    assert.ok(!s.discard.some((p) => p.id === stickyId), 'sticky part is not in the discard');
  } finally { usePlaceholder(); }
});

test('scrapParts costs a scrap, refills the hand, and scores nothing', () => {
  usePlaceholder();
  const s = newRun(2003);
  const score = s.score;
  scrapParts(s, [0, 1, 2]);
  assert.equal(s.score, score);
  assert.equal(s.scrapsLeft, 2);
  assert.equal(s.hand.length, s.handSize);
  assert.equal(s.discard.length, 3);
  scrapParts(s, [0]); scrapParts(s, [0]);
  assert.equal(s.scrapsLeft, 0);
  const before = snap(s);
  scrapParts(s, [0]); // no scraps left: a no-op, not an error
  assert.equal(snap(s), before);
  assert.throws(() => { s.scrapsLeft = 1; scrapParts(s, [0, 0]); }, RangeError);
});

// ---------------------------------------------------------------------------
// Line
// ---------------------------------------------------------------------------

test('reorderLine applies the permutation and rejects non-permutations', () => {
  usePlaceholder();
  const s = newRun(3001);
  while (s.line.length < 3) s.line.push({ id: `x${s.line.length}`, def: 'stub_reverse', level: 1 });
  const before = s.line.map((m) => m.id);
  const d0 = s.decisions;
  reorderLine(s, [2, 0, 1]);
  assert.deepEqual(s.line.map((m) => m.id), [before[2], before[0], before[1]]);
  assert.equal(s.decisions, d0 + 1);
  reorderLine(s, [0, 1, 2]); // identity is not a decision
  assert.equal(s.decisions, d0 + 1);
  assert.throws(() => reorderLine(s, [0, 1]), RangeError);
  assert.throws(() => reorderLine(s, [0, 0, 1]), RangeError);
  assert.throws(() => reorderLine(s, [0, 1, 3]), RangeError);
});

// ---------------------------------------------------------------------------
// Shop
// ---------------------------------------------------------------------------

test('rollShop offers five priced items and never a duplicate of an owned unique', () => {
  usePlaceholder();
  for (let seed = 0; seed < 60; seed++) {
    const s = newRun(seed);
    s.credits = 500;
    const shop = rollShop(s);
    assert.ok(shop.items.length > 0 && shop.items.length <= 5);
    assert.ok(shop.rerollCost > 0);
    const owned = new Set(s.line.map((m) => m.def));
    const seenM = new Set<string>();
    for (const it of shop.items) {
      assert.ok(it.cost >= 1, 'priced');
      assert.ok(Number.isInteger(it.cost), 'integer price');
      if (it.kind === 'machine') {
        assert.ok(!owned.has(it.def), `offered owned machine ${it.def}`);
        assert.ok(!seenM.has(it.def), 'duplicate machine in one shop');
        seenM.add(it.def);
      }
      if (it.kind === 'upgrade') {
        assert.ok(it.target !== undefined && s.line[it.target] !== undefined);
        assert.ok(s.line[it.target].level < MAX_MACHINE_LEVEL);
      }
    }
  }
});

test('buy debits credits, respects lineCap, and is refused when unaffordable', () => {
  usePlaceholder();
  const s = newRun(3002);
  s.credits = 0;
  const shop = rollShop(s);
  assert.equal(buy(s, shop, 0), false, 'cannot buy with no credits');
  assert.equal(buy(s, shop, 99), false, 'bad index');
  s.credits = 1000;
  const n = shop.items.length;
  const cost = shop.items[0].cost;
  assert.equal(buy(s, shop, 0), true);
  assert.equal(s.credits, 1000 - cost);
  assert.equal(shop.items.length, n - 1, 'bought item leaves the shop');
});

test('lineslot escalates and caps at 8; upgrade caps at level 3', () => {
  usePlaceholder();
  const s = newRun(3003);
  s.credits = 10000;
  const costs: number[] = [];
  while (s.lineCap < MAX_LINE_CAP) {
    const shop: { items: any[]; rerollCost: number } = { items: [], rerollCost: 3 };
    let it: any;
    for (let g = 0; g < 500 && it === undefined; g++) {
      const roll = rollShop(s);
      it = roll.items.find((x) => x.kind === 'lineslot');
    }
    assert.ok(it !== undefined, `a lineslot was offered at cap ${s.lineCap}`);
    shop.items.push(it);
    costs.push(it.cost);
    assert.equal(buy(s, shop as any, 0), true);
  }
  assert.equal(s.lineCap, MAX_LINE_CAP);
  for (let i = 1; i < costs.length; i++) assert.ok(costs[i] > costs[i - 1], 'cost escalates');
  // At the cap the shop stops offering slots.
  for (let g = 0; g < 50; g++) {
    assert.equal(rollShop(s).items.some((x) => x.kind === 'lineslot'), false);
  }

  const m = s.line[0];
  for (let lvl = 1; lvl < MAX_MACHINE_LEVEL; lvl++) {
    const shop = { items: [{ kind: 'upgrade', def: m.def, cost: 1, target: 0 }], rerollCost: 3 };
    assert.equal(buy(s, shop as any, 0), true);
  }
  assert.equal(m.level, MAX_MACHINE_LEVEL);
  const shop = { items: [{ kind: 'upgrade', def: m.def, cost: 1, target: 0 }], rerollCost: 3 };
  assert.equal(buy(s, shop as any, 0), false, 'no level 4');
});

test('reroll debits credits and escalates its own cost', () => {
  usePlaceholder();
  const s = newRun(3004);
  s.credits = 100;
  let shop = rollShop(s);
  const c0 = s.credits;
  const r0 = shop.rerollCost;
  shop = reroll(s, shop);
  assert.equal(s.credits, c0 - r0);
  assert.ok(shop.rerollCost > r0);
  s.credits = 0;
  const same = reroll(s, shop);
  assert.equal(same, shop, 'unaffordable reroll is a no-op');
});

// ---------------------------------------------------------------------------
// Round / run flow
// ---------------------------------------------------------------------------

test('clearing a round pays credits once and nextRound walks the whole run', () => {
  usePlaceholder();
  const s = newRun(4001);
  const path: string[] = [];
  for (let i = 0; i < SHIFTS_PER_RUN * ROUNDS_PER_SHIFT + 2 && !s.over; i++) {
    path.push(`${s.shift}.${s.round}`);
    s.score = s.quota;         // pretend it was cleared
    nextRound(s);
  }
  assert.equal(s.over, true);
  assert.equal(s.won, true);
  assert.equal(path.length, SHIFTS_PER_RUN * ROUNDS_PER_SHIFT);
  assert.equal(path[0], '1.1');
  assert.equal(path[path.length - 1], `${SHIFTS_PER_RUN}.${ROUNDS_PER_SHIFT}`);
  assert.ok(s.shift >= 1 && s.shift <= SHIFTS_PER_RUN);
});

test('failing a round ends the run', () => {
  usePlaceholder();
  const s = newRun(4002);
  nextRound(s); // quota not met
  assert.equal(s.over, true);
  assert.equal(s.won, false);
  assert.throws(() => playShipment(s, [0]), /run is over/);
});

test('round start resets counters, memo and the deck', () => {
  usePlaceholder();
  const s = newRun(4003);
  runMemo(s).x = 5;
  s.score = s.quota;
  playShipment(s, [0]);
  const creditsAfterClear = s.credits;
  playShipment(s, [0]); // extra shipment after clearing pays nothing more
  assert.equal(s.credits, creditsAfterClear);
  nextRound(s);
  assert.equal(s.round, 2);
  assert.equal(s.score, 0);
  assert.equal(s.shipmentsLeft, SHIPMENTS_PER_ROUND);
  assert.equal(s.scrapsLeft, 3);
  assert.deepEqual(runMemo(s), {});
  assert.equal(s.discard.length, 0);
  assert.equal(s.hand.length + s.drawPile.length, s.crate.length);
});

// ---------------------------------------------------------------------------
// Audits
// ---------------------------------------------------------------------------

test('round 3 applies the audit quota multiplier, its modify hook and its allow hook', () => {
  usePlaceholder();
  const s = newRun(5001);
  // Walk to shift 6 round 3, whose stub audit disables positional machines.
  while (!(s.shift === 6 && s.round === ROUNDS_PER_SHIFT) && !s.over) {
    s.score = s.quota;
    nextRound(s);
  }
  const audit = PLACEHOLDER_AUDITS[5];
  assert.equal(s.quota, Math.round(quotaFor(6, 3) * audit.quotaMult));
  assert.ok(s.quota > quotaFor(6, 3));

  // stub_double_first is positional, so this round it is a pass-through: the line
  // scores exactly as if it were empty.
  const press = line(['stub_double_first'], [3]);
  assert.equal(previewShipment(s, [0, 1, 2], press).gained, previewShipment(s, [0, 1, 2], []).gained);

  // A non-audit round is not affected: the same machine is live there.
  const t = newRun(5001);
  assert.equal(t.quota, quotaFor(1, 1));
  assert.notEqual(previewShipment(t, [0, 1, 2], press).gained, previewShipment(t, [0, 1, 2], []).gained);
  assert.equal(previewShipment(t, [0, 1, 2], line(['stub_add'])).stages.length, 2);
  // An audit round appends the scored (post-audit) stage.
  assert.equal(previewShipment(s, [0, 1, 2], line(['stub_add'])).stages.length, 3);
});

test('an audit that halves big batches shows up in the score', () => {
  usePlaceholder();
  const s = newRun(5002);
  while (!(s.shift === 4 && s.round === ROUNDS_PER_SHIFT) && !s.over) {
    s.score = s.quota;
    nextRound(s);
  }
  const l = line(['stub_add'], [1]);
  const small = previewShipment(s, [0, 1, 2], l).gained;
  const big = previewShipment(s, [0, 1, 2, 3], l).gained;
  const bigRaw = previewShipment(newRun(5002), [0, 1, 2, 3], l).gained;
  assert.ok(small > 0 && big > 0);
  assert.ok(big < bigRaw, 'the 4-part batch was halved');
});

// ---------------------------------------------------------------------------
// A whole run, driven greedily, never throws and always terminates.
// ---------------------------------------------------------------------------

test('a greedy bot can drive a run to termination without throwing', () => {
  usePlaceholder();
  for (let seed = 0; seed < 40; seed++) {
    const s = newRun(seed);
    let steps = 0;
    while (!s.over && steps++ < 4000) {
      if (roundCleared(s)) {
        let shop = rollShop(s);
        for (let i = shop.items.length - 1; i >= 0; i--) buy(s, shop, i);
        nextRound(s);
        continue;
      }
      // best 1..5 part prefix of a value-sorted hand
      const order = s.hand.map((_, i) => i)
        .sort((a, b) => s.hand[b].value * s.hand[b].mult - s.hand[a].value * s.hand[a].mult);
      let best: number[] = [order[0]];
      let bestGain = -1;
      for (let k = 1; k <= Math.min(PARTS_PER_SHIPMENT, order.length); k++) {
        const pick = order.slice(0, k);
        const g = previewShipment(s, pick).gained;
        if (g > bestGain) { bestGain = g; best = pick; }
      }
      playShipment(s, best);
    }
    assert.equal(s.over, true, `seed ${seed} terminated`);
    assert.ok(s.decisions > 0);
  }
});
