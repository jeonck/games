import test from 'node:test';
import assert from 'node:assert/strict';

import type { Batch, MachineDef, Part, RunCtx, Tag } from '../src/engine/types.ts';
import { ALL_ARCHETYPES, ALL_TAGS, PARTS_PER_SHIPMENT } from '../src/engine/types.ts';
import { makeRng } from '../src/engine/rng.ts';
import { MACHINES, BUILD_SUPPORT, MAX_BATCH } from '../src/content/machines.ts';
import { PARTS, PARTS_BY_DEF, STARTER_CRATE, TIER_LADDER } from '../src/content/parts.ts';
import { BLUEPRINTS } from '../src/content/blueprints.ts';
import { AUDITS } from '../src/content/audits.ts';
import { getRegistry, measureNonCommutativity } from '../src/content/index.ts';
import { newRun, nextRound, playShipment, previewShipment, reorderLine, rollShop, buy, roundCleared } from '../src/engine/run.ts';

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

function ctx(seed: number, over: Partial<RunCtx> = {}): RunCtx {
  const c: RunCtx = {
    rng: makeRng(seed),
    shift: 3, round: 2, quota: 900, score: 250, shipmentIndex: 1,
    lineCap: 5, handSize: 8, credits: 24,
    memo: {},
    grantCredits(_n: number): void { /* counted by the caller when it cares */ },
    ...over,
  };
  return c;
}

/**
 * Batches are built from REAL part defs, because that is what a shipment is: 1..5
 * parts off the crate, sometimes already chewed on by machines upstream. A generator
 * of uniform-random numbers would be measuring a game nobody plays.
 */
function randBatch(rng: ReturnType<typeof makeRng>, min: number, max: number): Batch {
  const n = min + rng.int(max - min + 1);
  const out: Batch = [];
  // a third of shipments are tag-focused, the way a player who is building Purity ships
  const focus = rng.next() < 0.33 ? rng.pick(ALL_TAGS) : null;
  const pool = focus === null ? PARTS : PARTS.filter((p) => p.tags.indexOf(focus) >= 0);
  for (let i = 0; i < n; i++) {
    const d = rng.pick(pool.length > 0 ? pool : PARTS);
    // upstream machines inflate values and mults, so sample those too
    const boost = [1, 1, 1, 2, 4, 9][rng.int(6)];
    out.push({
      id: `p${i}`,
      def: d.def,
      value: Math.floor(d.value * boost),
      mult: d.mult * [1, 1, 1, 2, 3][rng.int(5)],
      tags: d.tags,
    });
  }
  return out;
}

function deepFreeze(b: Batch): Batch {
  for (const p of b) { Object.freeze(p.tags); Object.freeze(p); }
  return Object.freeze(b) as Batch;
}

const snap = (b: Batch): string => JSON.stringify(b);

/** what a downstream machine (or the scorer) can actually observe about a batch */
const observable = (b: Batch): string =>
  b.map((p) => `${p.def}:${p.value}:${Math.round(p.mult * 1e6)}:${p.tags.join(',')}`).join('|');

const LEVELS = [1, 2, 3];

// ---------------------------------------------------------------------------
// 1. shape of the set
// ---------------------------------------------------------------------------

test('content: floors from the spec are met', () => {
  assert.ok(MACHINES.length >= 60, `machines: ${MACHINES.length}`);
  assert.ok(PARTS.length >= 20, `parts: ${PARTS.length}`);
  assert.ok(BLUEPRINTS.length >= 12, `blueprints: ${BLUEPRINTS.length}`);
  assert.equal(AUDITS.length, 8);
});

test('content: no duplicate def ids anywhere', () => {
  for (const [what, defs] of [
    ['machine', MACHINES.map((m) => m.def)],
    ['part', PARTS.map((p) => p.def)],
    ['blueprint', BLUEPRINTS.map((b) => b.def)],
    ['audit', AUDITS.map((a) => a.def)],
  ] as [string, string[]][]) {
    assert.equal(new Set(defs).size, defs.length, `duplicate ${what} def`);
  }
});

test('content: every archetype has at least 8 machines', () => {
  const n = new Map<string, number>();
  for (const m of MACHINES) n.set(m.archetype, (n.get(m.archetype) ?? 0) + 1);
  for (const a of ALL_ARCHETYPES) {
    assert.ok((n.get(a) ?? 0) >= 8, `archetype ${a}: ${n.get(a) ?? 0} machines, need 8`);
  }
});

test('content: at least 4 parts carry each tag', () => {
  for (const t of ALL_TAGS) {
    const n = PARTS.filter((p) => p.tags.indexOf(t) >= 0).length;
    assert.ok(n >= 4, `tag ${t}: ${n} parts`);
  }
});

test('content: five winning builds each have 8+ machines, all of which exist', () => {
  const byDef = new Map(MACHINES.map((m) => [m.def, m]));
  const builds = Object.keys(BUILD_SUPPORT);
  assert.ok(builds.length >= 5, `builds: ${builds.length}`);
  for (const b of builds) {
    const defs = BUILD_SUPPORT[b];
    assert.ok(defs.length >= 8, `build ${b}: ${defs.length} machines`);
    for (const d of defs) assert.ok(byDef.has(d), `build ${b} references unknown machine ${d}`);
  }
});

test('content: rule text is present, terse and level-parameterised', () => {
  for (const m of MACHINES) {
    for (const l of LEVELS) {
      const t = m.text(l);
      assert.equal(typeof t, 'string');
      assert.ok(t.length > 0, `${m.def}: empty text`);
      // this is a phone screen, not a rulebook
      assert.ok(t.length <= 120, `${m.def} L${l}: rule text is ${t.length} chars — too long`);
      assert.ok(!/undefined|NaN/.test(t), `${m.def} L${l}: broken text "${t}"`);
    }
  }
});

test('content: the tier ladder is a real, ascending chain of real parts', () => {
  assert.ok(TIER_LADDER.length >= 5);
  for (let i = 0; i < TIER_LADDER.length; i++) {
    assert.ok(PARTS_BY_DEF.has(TIER_LADDER[i].def), `ladder rung ${TIER_LADDER[i].def} is not a part`);
    if (i > 0) assert.ok(TIER_LADDER[i].value > TIER_LADDER[i - 1].value, 'ladder must ascend');
  }
});

test('content: the registry installs and the starter crate/line resolve', () => {
  const reg = getRegistry();
  assert.equal(reg.machines.size, MACHINES.length);
  assert.equal(reg.audits.length, 8);
  for (const d of STARTER_CRATE) assert.ok(PARTS_BY_DEF.has(d), `starter part ${d} missing`);
});

// ---------------------------------------------------------------------------
// 2. purity — apply() may not touch what it is handed
// ---------------------------------------------------------------------------

test('machines: apply is pure — a frozen batch is never mutated', () => {
  const rng = makeRng(4242);
  for (const m of MACHINES) {
    for (let t = 0; t < 25; t++) {
      const b = randBatch(rng, 0, 6);
      const before = snap(b);
      deepFreeze(b);
      for (const l of LEVELS) m.apply(b, ctx(1000 + t), l);
      assert.equal(snap(b), before, `${m.def} mutated its input`);
    }
  }
});

test('audits: modify is pure and leaves a scoreable batch', () => {
  const rng = makeRng(77);
  for (const a of AUDITS) {
    for (let t = 0; t < 40; t++) {
      const b = randBatch(rng, 0, 6);
      const before = snap(b);
      deepFreeze(b);
      const out = a.modify(b, ctx(t));
      assert.equal(snap(b), before, `audit ${a.def} mutated its input`);
      for (const p of out) {
        assert.ok(Number.isFinite(p.value) && p.value >= 0, `audit ${a.def} bad value`);
        assert.ok(Number.isFinite(p.mult) && p.mult >= 0, `audit ${a.def} bad mult`);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// 3. totality — no throw, no NaN, no Infinity, no negatives, ever
// ---------------------------------------------------------------------------

test('machines: apply is total over 200 random batches x every machine x levels 1-3', () => {
  const rng = makeRng(31337);
  const batches: Batch[] = [];
  for (let i = 0; i < 200; i++) batches.push(randBatch(rng, 0, 8));

  for (const m of MACHINES) {
    for (let i = 0; i < batches.length; i++) {
      for (const l of LEVELS) {
        let out: Batch;
        try {
          out = m.apply(batches[i], ctx(i * 7 + l), l);
        } catch (e) {
          assert.fail(`${m.def} L${l} threw on batch ${i}: ${(e as Error).message}`);
        }
        assert.ok(Array.isArray(out), `${m.def} did not return an array`);
        assert.ok(out.length <= MAX_BATCH, `${m.def} returned ${out.length} parts`);
        for (const p of out) {
          assert.ok(Number.isFinite(p.value), `${m.def} L${l}: value ${p.value}`);
          assert.ok(Number.isInteger(p.value), `${m.def} L${l}: non-integer value ${p.value}`);
          assert.ok(p.value >= 0, `${m.def} L${l}: negative value ${p.value}`);
          assert.ok(Number.isFinite(p.mult) && p.mult >= 0, `${m.def} L${l}: mult ${p.mult}`);
          assert.ok(typeof p.id === 'string' && p.id.length > 0, `${m.def}: bad id`);
          assert.ok(typeof p.def === 'string' && p.def.length > 0, `${m.def}: bad def`);
          assert.ok(Array.isArray(p.tags) && p.tags.length > 0, `${m.def}: bad tags`);
        }
      }
    }
  }
});

test('machines: extreme inputs stay finite', () => {
  const huge: Batch = [
    { id: 'a', def: 'monument', value: 1e8, mult: 900, tags: ['precision'] },
    { id: 'b', def: 'dust', value: 0, mult: 0, tags: ['scrap'] },
    { id: 'c', def: 'bolt', value: 7, mult: 1, tags: ['metal', 'volatile'] },
  ];
  for (const m of MACHINES) {
    for (const l of LEVELS) {
      const out = m.apply(huge, ctx(9, { credits: 999999, score: 1e9 }), l);
      for (const p of out) {
        assert.ok(Number.isFinite(p.value) && p.value >= 0, `${m.def}: ${p.value}`);
        assert.ok(Number.isFinite(p.mult) && p.mult >= 0, `${m.def}: mult ${p.mult}`);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// 4. THE ONE THAT MATTERS — non-commutativity (gate G2.3, threshold 60%)
// ---------------------------------------------------------------------------
//
// For 2,000 random ordered pairs of distinct machines and a random batch, how often
// is A(B(x)) different from B(A(x))? Below 60% the product claim — that machine order
// is the game — is not true and this test is supposed to say so out loud.
//
// Batch sizes 2..5: a shipment is 1..PARTS_PER_SHIPMENT parts, and on a 1-part batch
// every positional machine is the identity BY DEFINITION, so measuring there measures
// the batch size, not the content. The 1..5 figure is printed too, unmassaged.

test('machines: >= 60% of machine pairs are non-commutative (G2.3)', () => {
  // measured by the content set itself (src/content/index.ts) so that this assertion
  // and the number the gate report prints are the same number
  const m = measureNonCommutativity({ trials: 4000 });
  console.log(`\n  non-commutative pairs: ${(100 * m.rate).toFixed(2)}% ` +
    `(${m.trials} pairs, batches of ${m.minParts}-${m.maxParts} parts)`);
  console.log(`  including 1-part batches: ${(100 * m.withSingletons).toFixed(2)}%\n`);
  assert.ok(m.rate >= 0.6, `only ${(100 * m.rate).toFixed(2)}% of machine pairs are ` +
    'non-commutative — the content set is too commutative and ordering does not carry the game');
});

test('machines: order-sensitivity is broad, not carried by a few machines', () => {
  // every machine must fail to commute with at least a third of its partners; a
  // machine that commutes with everything is a machine whose position never matters
  const rng = makeRng(5150);
  const weak: string[] = [];
  for (const A of MACHINES) {
    let differ = 0;
    const TRIALS = 60;
    for (let t = 0; t < TRIALS; t++) {
      let B = MACHINES[rng.int(MACHINES.length)];
      while (B.def === A.def) B = MACHINES[rng.int(MACHINES.length)];
      const b = randBatch(rng, 2, PARTS_PER_SHIPMENT);
      const la = 1 + rng.int(3), lb = 1 + rng.int(3);
      const s = 3000 + t;
      if (observable(A.apply(B.apply(b, ctx(s), lb), ctx(s), la))
        !== observable(B.apply(A.apply(b, ctx(s), la), ctx(s), lb))) differ++;
    }
    if (differ / TRIALS < 0.25) weak.push(`${A.def} (${(100 * differ / TRIALS).toFixed(0)}%)`);
  }
  // The gambles and the big whiff-conditionals are allowed to sit here: a machine that
  // does nothing most of the time commutes most of the time, and that is a design
  // choice, not a bug. Anything beyond a handful means the set has gone flat.
  assert.ok(weak.length <= 6, `too many order-insensitive machines: ${weak.join(', ')}`);
});

// ---------------------------------------------------------------------------
// 5. randomness contract — preview must equal play
// ---------------------------------------------------------------------------

test('machines: rng machines are reproducible from the shipment seed (preview == play)', () => {
  // The engine reseeds ctx.rng per shipment from (seed, shift, round, shipmentIndex),
  // so the same batch through the same line must give the same answer every time.
  const rng = makeRng(8080);
  for (const m of MACHINES) {
    for (let t = 0; t < 10; t++) {
      const b = randBatch(rng, 1, 5);
      const seed = 55_000 + t;
      const a = observable(m.apply(b, ctx(seed), 2));
      const c = observable(m.apply(b, ctx(seed), 2));
      assert.equal(a, c, `${m.def} is not reproducible from a fixed shipment seed`);
    }
  }
});

test('machines: gambles are a small minority of the set', () => {
  // a machine is a gamble if two different shipment seeds can disagree
  const rng = makeRng(6060);
  const gambles: string[] = [];
  for (const m of MACHINES) {
    let varies = false;
    for (let t = 0; t < 24 && !varies; t++) {
      const b = randBatch(rng, 2, 5);
      const a = observable(m.apply(b, ctx(t * 977 + 1), 2));
      const c = observable(m.apply(b, ctx(t * 977 + 500), 2));
      if (a !== c) varies = true;
    }
    if (varies) gambles.push(m.def);
  }
  assert.ok(gambles.length <= 8, `too many random machines: ${gambles.join(', ')}`);
  assert.ok(gambles.length >= 3, 'a game with no luck in it is a game where every loss is your fault');
});

// ---------------------------------------------------------------------------
// 6. the alchemy — promotion must actually change what a part IS
// ---------------------------------------------------------------------------

test('machines: promotion machines rewrite part identity, not just numbers', () => {
  const b: Batch = [
    { id: 'a', def: 'rivet', value: 6, mult: 1, tags: ['metal'] },
    { id: 'b', def: 'dust', value: 2, mult: 1, tags: ['scrap'] },
    { id: 'c', def: 'gasket', value: 11, mult: 1, tags: ['organic'] },
  ];
  const promoters = ['foundry', 'kiln', 'recycler', 'escalator', 'gilder', 'crucible'];
  const byDef = new Map(MACHINES.map((m) => [m.def, m]));
  const ladder = new Set(TIER_LADDER.map((t) => t.def));
  for (const d of promoters) {
    const m = byDef.get(d) as MachineDef;
    const out = m.apply(b, ctx(11), 2);
    const changed = out.some((p, i) => p.def !== (b[i] ? b[i].def : ''));
    assert.ok(changed, `${d} did not change any part's identity`);
    for (const p of out) {
      assert.ok(PARTS_BY_DEF.has(p.def) || ladder.has(p.def),
        `${d} produced a part def nothing knows about: ${p.def}`);
    }
  }
});

test('machines: a run of promotions turns junk into a Monument', () => {
  // the screenshot moment, asserted: Dust in, top of the ladder out
  const byDef = new Map(MACHINES.map((m) => [m.def, m]));
  let b: Batch = [{ id: 'a', def: 'dust', value: 2, mult: 1, tags: ['scrap'] }];
  const line = ['foundry', 'foundry', 'foundry', 'foundry', 'foundry', 'foundry'];
  for (const d of line) b = (byDef.get(d) as MachineDef).apply(b, ctx(3), 1);
  assert.equal(b.length, 1);
  assert.equal(b[0].def, TIER_LADDER[TIER_LADDER.length - 1].def);
  assert.ok(b[0].value >= TIER_LADDER[TIER_LADDER.length - 1].value);
});

// ---------------------------------------------------------------------------
// 7. audits
// ---------------------------------------------------------------------------

test('audits: eight of them, ramping, each one answerable', () => {
  assert.equal(AUDITS.length, 8);
  for (let i = 1; i < AUDITS.length; i++) {
    assert.ok(AUDITS[i].quotaMult >= AUDITS[i - 1].quotaMult,
      `audit ${i + 1} is softer than audit ${i}`);
  }
  assert.equal(AUDITS[0].quotaMult, 1, 'shift 1 should be gentle');
  for (const a of AUDITS) {
    assert.ok(a.text.length > 0 && a.text.length <= 90, `audit ${a.def}: text too long`);
    assert.ok(a.quotaMult > 0);
  }
});

test('audits: each one actually invalidates something', () => {
  const rng = makeRng(1234);
  for (const a of AUDITS) {
    let bites = false;
    for (let t = 0; t < 60 && !bites; t++) {
      const b = randBatch(rng, 2, 5);
      if (observable(a.modify(b, ctx(t))) !== observable(b)) bites = true;
      for (const m of MACHINES) if (!a.allow(m)) bites = true;
    }
    assert.ok(bites, `audit ${a.def} never changes anything`);
  }
});

test('audits: no audit disables more than one archetype', () => {
  for (const a of AUDITS) {
    const off = ALL_ARCHETYPES.filter((arch) =>
      MACHINES.filter((m) => m.archetype === arch).every((m) => !a.allow(m)));
    assert.ok(off.length <= 1, `audit ${a.def} switches off ${off.join(', ')}`);
  }
});

// ---------------------------------------------------------------------------
// 8. blueprints
// ---------------------------------------------------------------------------

test('blueprints: onRoundStart is idempotent for the stats it owns', () => {
  // it runs once per round AND on purchase; a blueprint that incremented handSize
  // would silently grow it all run
  for (const bp of BLUEPRINTS) {
    const state = {
      seed: 1, rng: makeRng(1), shift: 2, round: 1, quota: 1000, score: 0,
      shipmentsLeft: 4, scrapsLeft: 3, credits: 10, line: [], lineCap: 4,
      crate: [] as Part[], drawPile: [] as Part[], hand: [] as Part[], discard: [] as Part[],
      blueprints: [{ id: 'b1', def: bp.def }], handSize: 8, over: false, won: false, decisions: 0,
    };
    if (bp.onRoundStart === undefined) continue;
    bp.onRoundStart(state as never);
    const afterOne = state.handSize;
    bp.onRoundStart(state as never);
    assert.equal(state.handSize, afterOne, `${bp.def} changes handSize every time it runs`);
    assert.ok(state.handSize >= 3 && state.handSize <= 16, `${bp.def}: handSize ${state.handSize}`);
    assert.ok(state.quota >= 1, `${bp.def}: quota went to ${state.quota}`);
  }
});

test('parts: every part is scoreable and priced', () => {
  for (const p of PARTS) {
    assert.ok(Number.isInteger(p.value) && p.value >= 0, `${p.def}: value ${p.value}`);
    assert.ok(p.mult > 0 && Number.isFinite(p.mult), `${p.def}: mult ${p.mult}`);
    assert.ok(p.tags.length > 0, `${p.def}: no tags`);
    assert.ok(p.cost > 0, `${p.def}: cost ${p.cost}`);
    assert.ok(p.name.length > 0);
  }
});

// ---------------------------------------------------------------------------
// 9. integration — the set has to survive contact with the actual engine
// ---------------------------------------------------------------------------

test('content: a real run plays through several rounds without falling over', () => {
  for (const seed of [1, 2, 7, 99, 12345]) {
    const s = newRun(seed);
    assert.ok(s.hand.length > 0, 'no opening hand');
    assert.ok(s.line.length > 0, 'no opening line');

    for (let round = 0; round < 6 && !s.over; round++) {
      while (s.shipmentsLeft > 0) {
        const n = Math.min(PARTS_PER_SHIPMENT, s.hand.length);
        if (n === 0) break;
        const idx: number[] = [];
        for (let i = 0; i < n; i++) idx.push(i);
        // reordering is free and always legal — exercise it
        if (s.line.length > 1) {
          const perm = s.line.map((_m, i) => i).reverse();
          reorderLine(s, perm);
        }
        const pre = previewShipment(s, idx);
        const res = playShipment(s, idx);
        assert.equal(pre.gained, res.gained, 'preview did not predict play');
        assert.ok(Number.isFinite(res.gained) && res.gained >= 0, `bad score ${res.gained}`);
        // one stage per machine, plus the entry batch, plus the audit's rewrite on round 3
        assert.ok(res.stages.length >= s.line.length + 1, 'missing line stages');
        if (roundCleared(s)) break;
      }
      const shop = rollShop(s);
      assert.ok(shop.items.length > 0);
      for (let i = 0; i < shop.items.length; i++) if (buy(s, shop, i)) break;
      nextRound(s);
    }
  }
});

test('content: the line is worth more in some orders than others', () => {
  // the product claim, checked end to end: take a real run, try every ordering of the
  // line on one hand, and assert the best is meaningfully better than the worst
  const s = newRun(4242);
  const idx = [0, 1, 2, 3].filter((i) => i < s.hand.length);
  const perms: number[][] = [];
  const walk = (left: number[], acc: number[]): void => {
    if (left.length === 0) { perms.push(acc); return; }
    for (let i = 0; i < left.length; i++) {
      walk(left.filter((_x, k) => k !== i), acc.concat(left[i]));
    }
  };
  walk(s.line.map((_m, i) => i), []);
  let best = -1;
  let worst = Infinity;
  for (const p of perms) {
    const line = p.map((i) => s.line[i]);
    const g = previewShipment(s, idx, line).gained;
    if (g > best) best = g;
    if (g < worst) worst = g;
  }
  assert.ok(best > worst, 'every ordering of the opening line scores the same — ordering is not load-bearing');
});
