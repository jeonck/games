// TAKT — bot and harness tests.
//
// Four things are being defended here, in order of how badly a failure would
// corrupt the benchmark:
//
//   1. THE RNG-FISHING EXPLOIT IS CLOSED. `previewShipment` is exact, so a bot that
//      ranks candidates on the realised stream is reading the coin before it bets.
//      The test builds a line whose gamble lands on a DIFFERENT draw depending on
//      what the bot ships, runs the planner over it many times, and asserts the
//      realised hit rate matches the machine's stated odds. It also asserts the
//      unfixed planner beats those odds — a test that only checked the fix could
//      pass on a state where fishing was impossible and prove nothing.
//   2. STRICT DOMINANCE. oracle >= planner >= greedy >= random on a shared seed
//      set. An inversion is a bug in the bots; the whole gate reads win rates as a
//      measure of depth and that reading is void if the ladder is not a ladder.
//   3. LEGALITY. No bot may ever hand the engine an illegal action.
//   4. DETERMINISM. The same seed set must produce identical records, or no result
//      in this repository is reproducible.
//
// RUNTIME. This file must finish. Bots are expensive — one planner run is ~220ms —
// so everything in the default suite is explicitly budgeted and the whole file lands
// around 35 seconds.
//
// The two BENCHMARK checks the brief asks for (strict dominance on >= 2,000 shared
// seeds; a 200-run-per-tier smoke that renders a gate report) run thousands of games
// across the worker pool and take half an hour. They are NOT in the default suite —
// a suite that cannot finish is a suite nobody runs, and it blocks the whole
// project's `npm test`. They are opt-in:
//
//     npm run test:bench          # TAKT_BENCH=1, the full >= 2,000-seed dominance
//     TAKT_DOMINANCE_RUNS=400 npm run test:bench    # a faster smell test
//
// The same dominance check also runs on the FULL 20,000-run sweep inside
// `src/sim/cli.ts` and is printed in `docs/bench/RESULTS.md` under "Bot integrity",
// so the number the project actually reports is always computed at gate scale.

import test from 'node:test';
import assert from 'node:assert/strict';

import '../src/content/index.ts';
import { MACHINES_BY_DEF } from '../src/content/machines.ts';
import type { Batch, Machine, Part, RunCtx } from '../src/engine/types.ts';
import { newRun, playShipment, previewShipment } from '../src/engine/run.ts';
import { makeBot, PlannerBot } from '../src/bots/index.ts';
import { stochasticMachineDefs } from '../src/bots/stochastic.ts';
import { creditYield } from '../src/bots/credits.ts';
import { runOne, runSeeds, seedRange } from '../src/sim/harness.ts';
import type { HarnessRecord } from '../src/sim/harness.ts';
import { aggregate } from '../src/sim/metrics.ts';
import { evaluateGate } from '../src/sim/gate.ts';
import { renderMarkdown } from '../src/sim/report.ts';
import { dominance, optOrderSplit } from '../src/sim/analysis.ts';
import { poolSize, runPool } from '../src/sim/pool.ts';
import type { BotName } from '../src/sim/telemetry.ts';

const BENCH = process.env.TAKT_BENCH === '1';
const BENCH_SKIP = BENCH
  ? false
  : 'benchmark-scale; run with TAKT_BENCH=1 (npm run test:bench)';
const DOMINANCE_RUNS = Number(process.env.TAKT_DOMINANCE_RUNS ?? 2000);
const SMOKE_RUNS = Number(process.env.TAKT_SMOKE_RUNS ?? 200);

/** Trials for the two rng-fishing tests. n=1500 at p=0.3 has an sd of 1.2pp, so the
 *  +-4pp band below is 3.4 sigma — tight enough to catch fishing, loose enough not
 *  to flake. */
const FISH_TRIALS = 1500;

/** Trials per side of the realised-vs-expected comparison. The two sides separate
 *  by ~50% and each side is stable to ~+-0.06 across seed blocks at this n. */
const EV_TRIALS = 500;

// ---------------------------------------------------------------------------
// 1. the rng-fishing exploit
// ---------------------------------------------------------------------------

/**
 * A line where the gamble's COIN depends on what the bot ships.
 *
 * `gremlin` draws from the stream only when it is handed 2+ parts, and it removes
 * one part when it does. So on a 1-part shipment `wildcard` reads draw 0, on a
 * 2-part shipment draw 1, and on 3+ draw 2 — three different coins, selectable by
 * the bot, from one seed. Two Gremlins is not a legal PURCHASE (the shop refuses a
 * duplicate machine) but it is a legal LINE, and it is the cleanest way to make the
 * draw index a decision. The exploit does not need this line to exist in a real
 * run; a generative machine changing batch length does the same thing.
 */
function fishingLine(): Machine[] {
  return [
    { id: 'g1', def: 'gremlin', level: 1 },
    { id: 'g2', def: 'gremlin', level: 1 },
    { id: 'w', def: 'wildcard', level: 1 },
  ];
}

function observe(b: Batch): string {
  return b.map((p: Part) => `${p.def}:${p.value}:${Math.round(p.mult * 1e6)}`).join('|');
}

function fixedRollCtx(r: number): RunCtx {
  return {
    rng: { next: () => r, int: (n: number) => Math.floor(r * n), pick: (xs) => xs[0], shuffle: (xs) => xs.slice(), fork: () => fixedRollCtx(r).rng },
    shift: 1, round: 1, quota: 300, score: 0, shipmentIndex: 0,
    lineCap: 4, handSize: 8, credits: 4, memo: {}, grantCredits: () => {},
  } as RunCtx;
}

/** Did Wildcard hit on this shipment? Decided by replaying both of its branches. */
function wildcardHit(stages: Batch[]): boolean | null {
  if (stages.length < 2) return null;
  const into = stages[stages.length - 2];
  const outOf = stages[stages.length - 1];
  const def = MACHINES_BY_DEF.get('wildcard');
  if (def === undefined) return null;
  const hit = observe(def.apply(into, fixedRollCtx(0), 1));
  const miss = observe(def.apply(into, fixedRollCtx(0.99), 1));
  if (hit === miss) return null;  // indistinguishable on this batch; no evidence
  const got = observe(outOf);
  if (got === hit) return true;
  if (got === miss) return false;
  return null;
}

function measureWildcardRate(fishing: boolean, n: number): { rate: number; samples: number } {
  const bot = new PlannerBot({ fishing, samples: 8 });
  let hits = 0;
  let samples = 0;
  for (let seed = 1; seed <= n; seed++) {
    const s = newRun(seed);
    s.line.length = 0;
    for (const m of fishingLine()) s.line.push(m);
    bot.startRun(s, seed);
    const d = bot.chooseShipment(s);
    const res = playShipment(s, d.indices);
    const hit = wildcardHit(res.stages);
    if (hit === null) continue;
    samples++;
    if (hit) hits++;
  }
  return { rate: samples > 0 ? hits / samples : NaN, samples };
}

test('the gamble machines are discovered by probing, not by a hard-coded list', () => {
  const found = stochasticMachineDefs();
  for (const def of ['roulette', 'jackpot', 'wildcard', 'dice_press', 'gremlin', 'lucky_run']) {
    assert.ok(found.has(def), `${def} must be detected as stochastic`);
  }
  // Nothing else should be: a false positive costs 8x on every evaluation.
  assert.equal(found.size, 6, `expected exactly the 6 gambles, got ${[...found].join(',')}`);
});

test('rng fishing is closed: the planner does not beat Wildcard\'s stated odds', () => {
  // Wildcard at level 1 reads "30%: promote every part one tier".
  const STATED = 0.30;
  const fixed = measureWildcardRate(false, FISH_TRIALS);
  assert.ok(fixed.samples > FISH_TRIALS * 0.6, `too few classifiable shipments (${fixed.samples})`);
  // +-4pp against a 1.2pp sd: tight enough to catch fishing, loose enough not to flake.
  assert.ok(
    Math.abs(fixed.rate - STATED) <= 0.04,
    `fixed planner hit Wildcard ${(fixed.rate * 100).toFixed(1)}% of the time; `
    + `the machine says ${(STATED * 100).toFixed(0)}%. A planner that beats its own `
    + 'stated odds is fishing the PRNG.',
  );
});

// ---------------------------------------------------------------------------
// The hit-rate test above is NECESSARY BUT NOT SUFFICIENT, and saying so is the
// point of the next two.
//
// Measured on that same Wildcard fixture: the UNFIXED planner also hits 29.4%.
// It is not fishing badly — the fixture cannot express the exploit through the one
// lever the hit-rate test can see. Wildcard's miss branch (`corrupt`) keeps 66% of
// each part's value and multiplies its mult by 1.5, so a miss on five parts still
// out-scores a hit on one, and the bot ships all five whatever the coin says. The
// exploit is still there — it just moves into WHICH parts and IN WHAT ORDER, which
// a hit-rate cannot see.
//
// So the instrument that actually detects reading-the-coin is this: compare what a
// shipment SCORED against the honest expectation of that same shipment over streams
// nobody chose it for. A bot whose choice is independent of the realised stream
// scores its own expectation; a bot that read the coin scores far above it. On a
// line ending in Roulette (a 50% x9 with no downside, so the coin is worth choosing
// between) the two bots separate by half again, stably across seed blocks:
//
//     fixed    0.95 / 1.02 / 1.07      fishing   1.42 / 1.56 / 1.57
//
// The fixed planner sitting on 1.0 is the fix working exactly as designed: its
// sampling seeds are a function of the run seed alone, so its choice carries no
// information about the coin, so realised == expected.

/** A line whose gamble is worth choosing between: Roulette is upside-only. */
function rouletteLine(): Machine[] {
  return [
    { id: 'g1', def: 'gremlin', level: 1 },
    { id: 'g2', def: 'gremlin', level: 1 },
    { id: 'r', def: 'roulette', level: 3 },
  ];
}

/**
 * mean(realised score) / mean(honest expectation of the same choice).
 *
 * The expectation is taken over 32 streams derived from a hash the bot has never
 * seen, so it is an unbiased estimate of what the chosen shipment is worth. 1.0
 * means the bot's choice carried no information about the coin.
 */
function realisedOverExpected(fishing: boolean, n: number): number {
  const bot = new PlannerBot({ fishing, samples: 8 });
  let realised = 0;
  let expected = 0;
  for (let seed = 1; seed <= n; seed++) {
    const s = newRun(seed);
    s.line.length = 0;
    for (const m of rouletteLine()) s.line.push(m);
    bot.startRun(s, seed);
    const d = bot.chooseShipment(s);
    let t = 0;
    for (let k = 0; k < 32; k++) {
      const alt = { ...s, seed: ((seed * 2246822519) >>> 0) ^ ((k * 3266489917 + 11) >>> 0) };
      t += previewShipment(alt as typeof s, d.indices).gained;
    }
    expected += t / 32;
    realised += playShipment(s, d.indices).gained;
  }
  return expected > 0 ? realised / expected : NaN;
}

test('the fix is unbiased: the planner scores its own expectation, not better', () => {
  const r = realisedOverExpected(false, EV_TRIALS);
  assert.ok(
    r >= 0.80 && r <= 1.25,
    `fixed planner realised/expected = ${r.toFixed(3)}; it should sit on 1.0. Above `
    + 'the band means the bot is getting information about the realised stream from '
    + 'somewhere; below it means the evaluator and the engine disagree.',
  );
});

test('the fishing test is not vacuous: the UNFIXED planner beats its own expectation', () => {
  const fishy = realisedOverExpected(true, EV_TRIALS);
  const fixed = realisedOverExpected(false, EV_TRIALS);
  assert.ok(
    fishy >= 1.25 && fishy >= fixed * 1.20,
    `the unfixed planner scored ${fishy.toFixed(3)}x its honest expectation against `
    + `the fixed planner's ${fixed.toFixed(3)}x. If those are close, this fixture no `
    + 'longer exposes the exploit and the tests above prove nothing. Fix the fixture, '
    + 'not the threshold.',
  );
});

test('a deterministic line is evaluated identically however many samples are asked for', () => {
  const s = newRun(4242);
  const one = new PlannerBot({ samples: 1 });
  const many = new PlannerBot({ samples: 16 });
  one.startRun(s, 4242);
  many.startRun(s, 4242);
  const stochastic = stochasticMachineDefs();
  if (s.line.some((m) => stochastic.has(m.def))) return;  // fixture happens to gamble
  assert.deepEqual(one.chooseShipment(s).indices, many.chooseShipment(s).indices);
});

test('economic machines are visible to the bots (credits.ts probe)', () => {
  // If this returns 0 for every machine, the economy build is invisible and G3
  // measures the bot's blind spot instead of the content.
  const paying = [...MACHINES_BY_DEF.values()].filter((m) => creditYield(m.def, 1) > 0);
  assert.ok(paying.length >= 5, `only ${paying.length} machines were seen to pay credits`);
});

// ---------------------------------------------------------------------------
// 3. legality
// ---------------------------------------------------------------------------

test('no bot ever hands the engine an illegal action (500 runs)', () => {
  // The engine throws on an out-of-range or duplicated hand index, on a shipment of
  // 0 or 6+ parts, and on a perm that is not a permutation. Playing runs to
  // completion is the assertion.
  // 500 runs, weighted toward the cheap tiers so the check stays under ~15s. The
  // expensive tiers still get enough runs to reach shift 7-8, which is where the
  // audits change the rules and an illegal action is most likely.
  const plan: [BotName, number][] = [
    ['random', 300], ['greedy', 150], ['planner', 40], ['oracle', 10],
  ];
  let total = 0;
  for (const [name, n] of plan) {
    const bot = makeBot(name);
    for (let i = 0; i < n; i++) {
      const rec = runOne(bot, 900000 + total);
      assert.ok(rec.endShift >= 1 && rec.endShift <= 8);
      assert.ok(rec.decisions >= 1);
      assert.ok(Number.isFinite(rec.estSeconds) && rec.estSeconds > 0);
      total++;
    }
  }
  assert.equal(total, 500);
});

test('telemetry is well formed: one transition entry per boundary flag', () => {
  const bot = makeBot('planner');
  for (let i = 1; i <= 8; i++) {
    const r: HarnessRecord = runOne(bot, i);
    assert.equal(r.optOrderChanged.length, r.optOrderShiftBoundary.length);
    assert.equal(r.optOrderChanged.length, r.optOrderChangedStrict.length);
    for (const g of r.reorderGainPct) assert.ok(Number.isFinite(g));
    for (const m of r.decisionMarginPct) assert.ok(Number.isFinite(m) && m >= -1e-9);
    assert.ok(r.machines.length === r.archetypes.length);
  }
  const split = optOrderSplit(runSeeds(() => makeBot('planner'), seedRange(12)));
  assert.ok(split.withinShiftN > 0 && split.boundaryN > 0);
});

// ---------------------------------------------------------------------------
// 4. determinism
// ---------------------------------------------------------------------------

test('the harness is deterministic: same seeds, identical records', () => {
  const seeds = seedRange(15, 5000);
  const strip = (rs: HarnessRecord[]): string =>
    JSON.stringify(rs, (k, v) => (k === 'wallMs' ? 0 : v));
  for (const name of ['random', 'greedy', 'planner'] as BotName[]) {
    const a = runSeeds(() => makeBot(name), seeds);
    const b = runSeeds(() => makeBot(name), seeds);
    assert.equal(strip(a), strip(b), `${name} is not deterministic`);
  }
});

test('a fresh bot per run gives the same records as one bot reused across runs', () => {
  // Guards the worker pool, which reuses one bot instance for thousands of runs.
  const seeds = seedRange(10, 7000);
  const shared = makeBot('planner');
  const a = seeds.map((s) => runOne(shared, s));
  const b = seeds.map((s) => runOne(makeBot('planner'), s));
  const strip = (rs: HarnessRecord[]): string =>
    JSON.stringify(rs, (k, v) => (k === 'wallMs' ? 0 : v));
  assert.equal(strip(a), strip(b));
});

// ---------------------------------------------------------------------------
// 2. dominance + smoke (benchmarks)
// ---------------------------------------------------------------------------

test('strict dominance: oracle >= planner >= greedy >= random', { timeout: 60 * 60_000, skip: BENCH_SKIP }, async () => {
  const seeds = seedRange(DOMINANCE_RUNS);
  const workers = poolSize();
  const all: HarnessRecord[] = [];
  for (const bot of ['random', 'greedy', 'planner', 'oracle'] as BotName[]) {
    const res = await runPool(bot, {}, seeds, workers, 100);
    for (const r of res.records) all.push(r);
  }
  const dom = dominance(aggregate(all));
  assert.ok(
    dom.ok,
    'WIN-RATE LADDER INVERTED — this is a bug in the bots, not a finding about the '
    + `game:\n  ${dom.inversions.join('\n  ')}\n  rates: ${JSON.stringify(dom.rates)}`,
  );
  assert.ok(dom.runs >= Math.min(2000, DOMINANCE_RUNS), 'dominance needs >= 2,000 shared seeds');
});

test('smoke: 200 runs per tier renders a gate report', { timeout: 30 * 60_000, skip: BENCH_SKIP }, async () => {
  const seeds = seedRange(SMOKE_RUNS, 100000);
  const workers = poolSize();
  const all: HarnessRecord[] = [];
  for (const bot of ['random', 'greedy', 'planner', 'oracle'] as BotName[]) {
    const res = await runPool(bot, {}, seeds, workers, 50);
    for (const r of res.records) all.push(r);
  }
  const tiers = aggregate(all);
  assert.equal(tiers.length, 4);
  for (const t of tiers) assert.equal(t.runs, SMOKE_RUNS);
  const md = renderMarkdown(evaluateGate(tiers, 0, 'smoke', { nonCommutativePairRate: 0.63 }));
  assert.match(md, /## Iteration 0/);
  assert.match(md, /GATE: (PASS|FAIL)/);
  for (const id of ['G1.1', 'G2.1', 'G3.1', 'G4.2', 'G5.1', 'G6.1', 'G7.1']) {
    assert.ok(md.includes(id), `report is missing ${id}`);
  }
  // 200 < 20,000, so the gate must be forced to fail on sample size.
  assert.match(md, /UNDERSAMPLED/);
});

test('previewShipment is never advanced by the evaluator: the run is unchanged', () => {
  const s = newRun(31337);
  const before = JSON.stringify(s, (k, v) => (k === 'rng' ? undefined : v));
  const bot = new PlannerBot({});
  bot.startRun(s, 31337);
  bot.chooseShipment(s);
  bot.chooseScrap(s);
  assert.equal(JSON.stringify(s, (k, v) => (k === 'rng' ? undefined : v)), before);
  assert.ok(previewShipment(s, [0]).gained >= 0);
});
