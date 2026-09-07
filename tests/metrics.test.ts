// TAKT — tests for the gate instrument.
//
// The gate decides whether the project ships. These tests exist to prove three
// things: that every threshold in docs/bench/BENCHMARK.md is actually checked,
// that a broken game is caught and correctly diagnosed, and that no degenerate
// input can make the instrument throw or — worse — silently pass.

import test from 'node:test';
import assert from 'node:assert/strict';

import type { Archetype } from '../src/engine/types.ts';
import type { BotName, RunRecord, TierMetrics } from '../src/sim/telemetry.ts';
import {
  BOT_TIERS,
  MIN_RUNS_PER_TIER,
  aggregate,
  median,
  normalizedEntropy,
  percentile,
  winCount,
} from '../src/sim/metrics.ts';
import type { Bound } from '../src/sim/gate.ts';
import {
  METRIC_IDS,
  NOT_MEASURED,
  annotate,
  evaluateGate,
  thresholdDistance,
  wilson95,
} from '../src/sim/gate.ts';
import { renderMarkdown } from '../src/sim/report.ts';

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const ARCHETYPES: Archetype[] = [
  'arithmetic', 'positional', 'filter', 'generative', 'conditional', 'economic', 'transmutation',
];
const MACHINE_POOL: string[] = Array.from({ length: 20 }, (_, i) => `mach.${i}`);

const HEALTHY_LOSS_WEIGHTS = [0.06, 0.09, 0.14, 0.17, 0.17, 0.15, 0.12, 0.10];
const WALL_LOSS_WEIGHTS = [0.05, 0.05, 0.55, 0.10, 0.08, 0.07, 0.05, 0.05];

interface TierOpts {
  n: number;
  winRate: number;
  rich?: boolean;                                  // emit G2/G6 sample arrays
  lossWeights?: number[];
  archetypesFor?: (winIdx: number) => Archetype[];
  machinesFor?: (winIdx: number) => string[];
  decisions?: number;
  winSeconds?: number;
  quota?: number;
  tailExponent?: number;
  reorderGain?: number;
  optChangedRate?: number;
  closeRate?: number;
  finalScoreOverride?: number;
}

const defaultArchetypes = (w: number): Archetype[] =>
  [ARCHETYPES[w % 7], ARCHETYPES[(w + 1) % 7], ARCHETYPES[(w + 2) % 7]];

const defaultMachines = (w: number): string[] =>
  Array.from({ length: 5 }, (_, j) => MACHINE_POOL[(w * 5 + j) % MACHINE_POOL.length]);

/** Deterministic synthetic runs. No RNG: every assertion below is reproducible. */
function makeTier(bot: BotName, o: TierOpts): RunRecord[] {
  const n = o.n;
  const wins = Math.round(n * o.winRate);
  const losses = n - wins;
  const weights = o.lossWeights ?? HEALTHY_LOSS_WEIGHTS;
  const wsum = weights.reduce((a, b) => a + b, 0);
  const cum: number[] = [];
  let acc = 0;
  for (const w of weights) { acc += w / wsum; cum.push(acc); }

  const quota = o.quota ?? 1000;
  const exp = o.tailExponent ?? 1.35;
  const decisions = o.decisions ?? 180;
  const winSeconds = o.winSeconds ?? 1500;
  const archFor = o.archetypesFor ?? defaultArchetypes;
  const machFor = o.machinesFor ?? defaultMachines;

  const reorder = o.rich ? Array.from({ length: 12 }, () => o.reorderGain ?? 30) : [];
  const changedTrue = Math.round(12 * (o.optChangedRate ?? 0.6));
  const changed = o.rich ? Array.from({ length: 12 }, (_, i) => i < changedTrue) : [];
  const closeCount = Math.round(25 * (o.closeRate ?? 0.32));
  const margins = o.rich ? Array.from({ length: 25 }, (_, i) => (i < closeCount ? 5 : 25)) : [];

  const out: RunRecord[] = [];
  let lossIdx = 0;
  let winIdx = 0;
  for (let i = 0; i < n; i++) {
    const won = i < wins;
    let endShift = 8;
    if (!won) {
      const f = (lossIdx + 0.5) / Math.max(1, losses);
      let s = 0;
      while (s < weights.length - 1 && f > cum[s]) s++;
      endShift = s + 1;
      lossIdx++;
    }
    const w = won ? winIdx++ : i;
    const u = (i + 0.5) / n;
    const finalScore = o.finalScoreOverride ?? Math.round(quota * Math.pow(1 / (1 - u), exp));

    out.push({
      bot,
      seed: i,
      won,
      endShift,
      endRound: 3,
      decisions,
      estSeconds: won ? winSeconds : 600,
      machines: machFor(w),
      archetypes: archFor(w),
      finalScore,
      finalQuota: quota,
      reorderGainPct: reorder,
      optOrderChanged: changed,
      decisionMarginPct: margins,
    });
  }
  return out;
}

interface Scenario {
  n?: number;
  random?: Partial<TierOpts>;
  greedy?: Partial<TierOpts>;
  planner?: Partial<TierOpts>;
  oracle?: Partial<TierOpts>;
}

/** A game that clears every bar in BENCHMARK.md, with per-tier overrides. */
function metricsFor(s: Scenario = {}): TierMetrics[] {
  const n = s.n ?? MIN_RUNS_PER_TIER;
  const recs: RunRecord[] = [
    ...makeTier('random', { n, winRate: 0.01, ...s.random }),
    ...makeTier('greedy', { n, winRate: 0.15, ...s.greedy }),
    ...makeTier('planner', { n, winRate: 0.50, rich: true, ...s.planner }),
    ...makeTier('oracle', { n, winRate: 0.75, ...s.oracle }),
  ];
  return aggregate(recs);
}

const EXTERNAL = { nonCommutativePairRate: 0.72 };
const FIXED_DATE = new Date('2026-09-07T12:00:00Z');

function gateFor(s: Scenario = {}, external = EXTERNAL) {
  return evaluateGate(metricsFor(s), 7, 'abc1234', external, FIXED_DATE);
}

function valueOf(report: ReturnType<typeof evaluateGate>, id: string): number | string {
  const r = report.results.find((x) => x.id === id);
  assert.ok(r !== undefined, `missing metric ${id}`);
  return (r as { value: number | string }).value;
}

// ---------------------------------------------------------------------------
// numeric primitives
// ---------------------------------------------------------------------------

test('percentile: exclusive linear interpolation between order statistics', () => {
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(percentile([1, 2, 3], 0.5), 2);
  assert.equal(percentile([10, 20], 0.25), 10);      // h <= 1 clamps to the minimum
  assert.equal(percentile([10, 20], 0.99), 20);      // h >= n clamps to the maximum
  const hundred = Array.from({ length: 100 }, (_, i) => i + 1);
  assert.ok(Math.abs(percentile(hundred, 0.95) - 95.95) < 1e-9);
  assert.ok(Math.abs(percentile(hundred, 0.99) - 99.99) < 1e-9);
  assert.equal(percentile([7], 0.9), 7);
  assert.ok(Number.isNaN(percentile([], 0.5)));
});

test('median: unsorted input, empty input', () => {
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.ok(Number.isNaN(median([])));
});

test('normalized Shannon entropy', () => {
  assert.equal(normalizedEntropy({}), 0);
  assert.equal(normalizedEntropy({ a: 1 }), 0, 'k <= 1 must be 0');
  assert.equal(normalizedEntropy({ a: 1, b: 0 }), 0, 'zero shares do not count toward k');
  assert.ok(Math.abs(normalizedEntropy({ a: 0.5, b: 0.5 }) - 1) < 1e-12);
  assert.ok(Math.abs(normalizedEntropy({ a: 0.9, b: 0.1 }) - 0.4690) < 1e-3);
  // unnormalized shares (presence rates summing above 1) renormalize first
  assert.ok(Math.abs(normalizedEntropy({ a: 0.6, b: 0.6, c: 0.6 }) - 1) < 1e-12);
});

test('wilson95: known values and degenerate inputs', () => {
  const a = wilson95(50, 100);
  assert.ok(Math.abs(a.lo - 0.40383) < 1e-4);
  assert.ok(Math.abs(a.hi - 0.59617) < 1e-4);
  const b = wilson95(0, 100);
  assert.ok(b.lo >= 0 && b.lo < 1e-12);
  assert.ok(b.hi > 0 && b.hi < 0.05, 'zero successes still has an upper bound');
  const none = wilson95(0, 0);
  assert.deepEqual(none, { lo: 0, hi: 1 }, 'no data must be maximally uncertain');
  const all = wilson95(100, 100);
  assert.equal(all.hi, 1);
  assert.ok(Number.isFinite(wilson95(5, -3).lo));
});

test('thresholdDistance: relative distance to the violated bound', () => {
  assert.equal(thresholdDistance({ kind: 'gte', lo: 2.5 } as Bound, 3), 0, 'passing is distance 0');
  assert.ok(Math.abs(thresholdDistance({ kind: 'gte', lo: 2.5 } as Bound, 2) - 0.2) < 1e-12);
  assert.ok(Math.abs(thresholdDistance({ kind: 'lte', hi: 0.35 } as Bound, 0.55) - 0.5714285) < 1e-6);
  assert.ok(Math.abs(thresholdDistance({ kind: 'lt', hi: 0.02 } as Bound, 0.03) - 0.5) < 1e-12);
  // ranges measure to the nearer (violated) bound
  assert.ok(Math.abs(thresholdDistance({ kind: 'range', lo: 0.4, hi: 0.6 } as Bound, 0.2) - 0.5) < 1e-12);
  assert.ok(Math.abs(thresholdDistance({ kind: 'range', lo: 0.4, hi: 0.6 } as Bound, 0.9) - 0.5) < 1e-12);
  // the "0 such machines" bound has no denominator: absolute count is used
  assert.equal(thresholdDistance({ kind: 'zero' } as Bound, 3), 3);
  assert.ok(Number.isNaN(thresholdDistance({ kind: 'gte', lo: 1 } as Bound, NaN)));
});

// ---------------------------------------------------------------------------
// coverage: every metric in BENCHMARK.md is checked
// ---------------------------------------------------------------------------

test('every G-metric in BENCHMARK.md appears in the report, in spec order', () => {
  const expected = [
    'G1.1', 'G1.2', 'G1.3', 'G1.4', 'G1.5', 'G1.6',
    'G2.1', 'G2.2', 'G2.3',
    'G3.1', 'G3.2', 'G3.3', 'G3.4',
    'G4.1', 'G4.2', 'G4.3',
    'G5.1', 'G5.2',
    'G6.1',
    'G7.1', 'G7.2',
  ];
  assert.deepEqual([...METRIC_IDS], expected);
  const report = gateFor();
  assert.deepEqual(report.results.map((r) => r.id), expected);
  for (const r of report.results) {
    assert.equal(typeof r.threshold, 'string');
    assert.ok(r.threshold.length > 0, `${r.id} has no threshold string`);
    assert.equal(typeof r.pass, 'boolean');
  }
});

// ---------------------------------------------------------------------------
// scenario 1 — a clearly passing game
// ---------------------------------------------------------------------------

test('a clearly-passing game passes the gate cleanly', () => {
  const report = gateFor();
  assert.deepEqual(report.failing, [], 'no metric should fail');
  assert.equal(report.gatePass, true);
  assert.equal(report.weakest, null);
  assert.equal(report.date, '2026-09-07');
  assert.equal(report.commit, 'abc1234');
  assert.equal(report.iteration, 7);

  const ann = annotate(report);
  const marginal = report.results.filter((r) => ann.get(r.id)?.marginal).map((r) => r.id);
  assert.deepEqual(marginal, [], 'a clean pass should have no marginal rows');

  const md = renderMarkdown(report);
  assert.match(md, /^## Iteration 7 — 2026-09-07 — abc1234$/m);
  assert.match(md, /^GATE: PASS \(0 failing: none\)$/m);
  assert.match(md, /^Weakest metric: none\.$/m);
  assert.doesNotMatch(md, /UNDERSAMPLED/);
  assert.doesNotMatch(md, /MARGINAL/);
  for (const id of METRIC_IDS) {
    assert.match(md, new RegExp(`^${id.replace('.', '\\.')} .* PASS`, 'm'), `${id} row missing`);
  }
});

// ---------------------------------------------------------------------------
// scenario 2 — a dominant strategy (G3 fails)
// ---------------------------------------------------------------------------

test('a dominant strategy is caught by G3.1 and named as weakest', () => {
  // Every winning run takes `arithmetic`; the second archetype varies.
  const report = gateFor({
    planner: {
      archetypesFor: (w) => ['arithmetic', ARCHETYPES[(w % 6) + 1]],
    },
  });
  assert.deepEqual(report.failing, ['G3.1']);
  assert.equal(report.gatePass, false);
  assert.equal(report.weakest, 'G3.1');
  assert.equal(valueOf(report, 'G3.1'), 1, 'arithmetic appears in 100% of wins');

  const md = renderMarkdown(report);
  assert.match(md, /^G3\.1 100\.00% FAIL/m);
  assert.match(md, /^GATE: FAIL \(1 failing: G3\.1\)$/m);
  assert.match(md, /^Weakest metric: G3\.1 — next loop targets this\.$/m);
});

test('a single overtuned machine is caught by G3.4', () => {
  const report = gateFor({
    planner: {
      machinesFor: (w) => ['mach.autotaken', MACHINE_POOL[w % MACHINE_POOL.length]],
    },
  });
  assert.ok(report.failing.includes('G3.4'));
  assert.equal(valueOf(report, 'G3.4'), 1, 'exactly one machine is in >60% of wins');
  assert.equal(report.gatePass, false);
});

// ---------------------------------------------------------------------------
// scenario 3 — a shallow game where planner ~ greedy (G1.5 fails)
// ---------------------------------------------------------------------------

test('a shallow game (planner ~ greedy) is caught by G1.5 and named as weakest', () => {
  const report = gateFor({
    greedy: { winRate: 0.22 },
    planner: { winRate: 0.45, rich: true },
  });
  assert.deepEqual(report.failing, ['G1.5']);
  assert.equal(report.gatePass, false);
  assert.equal(report.weakest, 'G1.5');
  const ratio = valueOf(report, 'G1.5') as number;
  assert.ok(Math.abs(ratio - 0.45 / 0.22) < 1e-9);
  assert.match(renderMarkdown(report), /^G1\.5 2\.05× FAIL/m);
});

// ---------------------------------------------------------------------------
// scenario 4 — a difficulty wall (G4.2 fails)
// ---------------------------------------------------------------------------

test('a difficulty wall is caught by G4.2 and named as weakest', () => {
  const report = gateFor({
    planner: { rich: true, lossWeights: WALL_LOSS_WEIGHTS },
  });
  assert.deepEqual(report.failing, ['G4.2']);
  assert.equal(report.gatePass, false);
  assert.equal(report.weakest, 'G4.2');
  const share = valueOf(report, 'G4.2') as number;
  assert.ok(share > 0.5 && share < 0.6, `expected ~55% of losses on one shift, got ${share}`);
});

test('weakest picks the failing metric with the largest relative distance', () => {
  // G4.2 is 55% against a 35% bound (rel. 0.571); G3.1 is 100% against a 55%
  // bound (rel. 0.818). G3.1 must win.
  const report = gateFor({
    planner: {
      rich: true,
      lossWeights: WALL_LOSS_WEIGHTS,
      archetypesFor: (w) => ['arithmetic', ARCHETYPES[(w % 6) + 1]],
    },
  });
  assert.deepEqual(report.failing.sort(), ['G3.1', 'G4.2']);
  assert.equal(report.weakest, 'G3.1');
});

// ---------------------------------------------------------------------------
// statistical honesty
// ---------------------------------------------------------------------------

test('an undersampled tier forces FAIL regardless of metric values', () => {
  const report = gateFor({ n: 1000 });
  assert.deepEqual(report.failing, [], 'every metric still passes on its own');
  assert.equal(report.gatePass, false, 'but the gate must not pass on thin data');

  const md = renderMarkdown(report);
  assert.match(md, /^⚠ UNDERSAMPLED \(n=1000\) — tier `random`/m);
  assert.match(md, /^⚠ UNDERSAMPLED \(n=1000\) — tier `planner`/m);
  assert.equal((md.match(/⚠ UNDERSAMPLED \(n=1000\)/g) ?? []).length, 4);
  assert.match(md, /GATE FORCED TO FAIL/);
  assert.match(md, /^GATE: FAIL \(0 failing: none\) — forced FAIL on sample size/m);
});

test('a win rate whose interval straddles its bound is rendered MARGINAL', () => {
  // 40.1% planner win rate at n=20000: the 95% Wilson interval contains 40%.
  const report = gateFor({ planner: { winRate: 0.401, rich: true } });
  const ann = annotate(report);
  assert.equal(ann.get('G1.3')?.marginal, true);
  assert.equal(ann.get('G4.1')?.marginal, true);
  assert.equal(report.results.find((r) => r.id === 'G1.3')?.pass, true, 'boolean pass is unchanged');

  const md = renderMarkdown(report);
  assert.match(md, /^G1\.3 40\.10% PASS MARGINAL/m);
  assert.match(md, /\*\*MARGINAL \(2\): G1\.3, G4\.1\*\*/);
});

test('a comfortable win rate is not marked marginal', () => {
  const report = gateFor({ planner: { winRate: 0.50, rich: true } });
  const ann = annotate(report);
  assert.equal(ann.get('G1.3')?.marginal, false);
  assert.equal(ann.get('G1.5')?.marginal, false);
  assert.equal(ann.get('G1.6')?.marginal, false);
});

test('G2.3 is NOT MEASURED and fails when the content harness supplies nothing', () => {
  const report = evaluateGate(metricsFor(), 7, 'abc1234', {}, FIXED_DATE);
  assert.deepEqual(report.failing, ['G2.3']);
  assert.equal(valueOf(report, 'G2.3'), NOT_MEASURED);
  assert.equal(report.gatePass, false);
  // no measured failure exists, so the unmeasured metric becomes weakest
  assert.equal(report.weakest, 'G2.3');
  const md = renderMarkdown(report);
  assert.match(md, /\*\*NOT MEASURED \(1\): G2\.3\*\*/);
  assert.match(md, /^G2\.3 n\/a \(not measured\) FAIL/m);
});

test('a below-threshold non-commutativity measurement fails G2.3', () => {
  const report = gateFor({}, { nonCommutativePairRate: 0.41 });
  assert.deepEqual(report.failing, ['G2.3']);
  assert.equal(valueOf(report, 'G2.3'), 0.41);
});

// ---------------------------------------------------------------------------
// robustness — none of this may throw, and none of it may pass
// ---------------------------------------------------------------------------

test('zero records: four tiers, no throw, gate fails', () => {
  const tiers = aggregate([]);
  assert.equal(tiers.length, 4);
  assert.deepEqual(tiers.map((t) => t.bot), [...BOT_TIERS]);
  for (const t of tiers) {
    assert.equal(t.runs, 0);
    assert.equal(t.winRate, 0);
    assert.equal(winCount(t), 0);
  }
  const report = evaluateGate(tiers, 1, 'deadbee', {}, FIXED_DATE);
  assert.equal(report.gatePass, false);
  assert.ok(report.failing.length > 0);
  assert.ok(report.weakest);
  const md = renderMarkdown(report);
  assert.match(md, /⚠ UNDERSAMPLED \(n=0\)/);
  assert.match(md, /^GATE: FAIL/m);
  // nothing may be reported as a numeric success out of thin air
  for (const r of report.results) {
    if (r.pass) {
      assert.notEqual(r.value, NOT_MEASURED);
    }
  }
});

test('zero wins: diversity, snowball and session metrics report NOT MEASURED, never PASS', () => {
  const tiers = aggregate(makeTier('planner', { n: 100, winRate: 0, rich: true }));
  const p = tiers.find((t) => t.bot === 'planner') as TierMetrics;
  assert.equal(p.winRate, 0);
  assert.deepEqual(p.archetypeWinShare, {});
  assert.equal(p.archetypeEntropy, 0);
  assert.ok(Number.isNaN(p.medianEstSeconds), 'no winning run has a wall-clock estimate');

  const report = evaluateGate(tiers, 1, 'c0ffee', EXTERNAL, FIXED_DATE);
  for (const id of ['G3.1', 'G3.2', 'G3.3', 'G3.4', 'G7.2']) {
    const r = report.results.find((x) => x.id === id);
    assert.equal(r?.pass, false, `${id} must not pass with zero wins`);
    assert.equal(r?.value, NOT_MEASURED, `${id} must be reported as unmeasured`);
  }
  assert.equal(report.gatePass, false);
  assert.equal(typeof renderMarkdown(report), 'string');
});

test('zero greedy wins makes G1.5 undefined, not infinitely good', () => {
  const report = gateFor({ greedy: { winRate: 0 } });
  assert.equal(valueOf(report, 'G1.5'), NOT_MEASURED);
  assert.equal(report.results.find((r) => r.id === 'G1.5')?.pass, false);
});

test('empty sample arrays inside records: G2/G6 report NOT MEASURED', () => {
  const tiers = aggregate(makeTier('planner', { n: 50, winRate: 0.5, rich: false }));
  const p = tiers.find((t) => t.bot === 'planner') as TierMetrics;
  assert.ok(Number.isNaN(p.medianReorderGainPct));
  assert.ok(Number.isNaN(p.optOrderChangedRate));
  assert.ok(Number.isNaN(p.closeCallRate));
  const report = evaluateGate(tiers, 1, 'x', EXTERNAL, FIXED_DATE);
  for (const id of ['G2.1', 'G2.2', 'G6.1']) {
    assert.equal(report.results.find((r) => r.id === id)?.value, NOT_MEASURED);
    assert.equal(report.results.find((r) => r.id === id)?.pass, false);
  }
});

test('all-identical values: no division blowups, no accidental pass', () => {
  const flat = aggregate(makeTier('planner', { n: 500, winRate: 0.5, rich: true, finalScoreOverride: 1000 }));
  const p = flat.find((t) => t.bot === 'planner') as TierMetrics;
  assert.equal(p.p50FinalScore, 1000);
  assert.equal(p.p99OverP50, 1);
  assert.equal(p.p95FinalRatio, 1);
  const r1 = evaluateGate(flat, 1, 'x', EXTERNAL, FIXED_DATE);
  assert.equal(r1.results.find((r) => r.id === 'G5.2')?.pass, false);
  assert.equal(r1.results.find((r) => r.id === 'G5.1')?.pass, false);

  // all-zero scores: p50 is 0, so p99/p50 is undefined rather than Infinity
  const zero = aggregate(makeTier('planner', { n: 500, winRate: 0.5, rich: true, finalScoreOverride: 0 }));
  const z = zero.find((t) => t.bot === 'planner') as TierMetrics;
  assert.ok(Number.isNaN(z.p99OverP50));
  const r2 = evaluateGate(zero, 1, 'x', EXTERNAL, FIXED_DATE);
  assert.equal(r2.results.find((r) => r.id === 'G5.2')?.value, NOT_MEASURED);
  assert.equal(r2.results.find((r) => r.id === 'G5.2')?.pass, false);
});

test('malformed records do not throw and do not produce passes', () => {
  const junk = [
    null,
    undefined,
    {},
    { bot: 'planner' },
    { bot: 'not-a-bot', won: true },
    {
      bot: 'planner', seed: NaN, won: true, endShift: NaN, endRound: 0, decisions: NaN,
      estSeconds: Infinity, machines: null, archetypes: 'nope', finalScore: NaN,
      finalQuota: 0, reorderGainPct: null, optOrderChanged: 'yes', decisionMarginPct: [NaN, 'x'],
    },
    {
      bot: 'planner', seed: 1, won: false, endShift: 99, endRound: 1, decisions: -5,
      estSeconds: -1, machines: [1, 2], archetypes: [null], finalScore: -10,
      finalQuota: -1, reorderGainPct: ['a'], optOrderChanged: [1, 0], decisionMarginPct: [],
    },
  ] as unknown as RunRecord[];

  const tiers = aggregate(junk);
  assert.equal(tiers.length, 4);
  const p = tiers.find((t) => t.bot === 'planner') as TierMetrics;
  assert.equal(p.runs, 3, 'only records with a known bot name are counted');
  assert.equal(p.lossShiftHistogram.length, 8);
  assert.equal(p.lossShiftHistogram.reduce((a, b) => a + b, 0), 2, 'both losses land in range');
  for (const v of Object.values(p.archetypeWinShare)) assert.ok(Number.isFinite(v));

  const report = evaluateGate(tiers, 1, 'junk', EXTERNAL, FIXED_DATE);
  assert.equal(report.gatePass, false);
  assert.equal(typeof renderMarkdown(report), 'string');
});

test('a malformed GateReport still renders without throwing', () => {
  assert.equal(typeof renderMarkdown({} as never), 'string');
  assert.equal(typeof renderMarkdown(null as never), 'string');
  assert.equal(typeof renderMarkdown({ results: null, tiers: null } as never), 'string');
});

test('evaluateGate tolerates missing and duplicated tiers', () => {
  const only = aggregate(makeTier('planner', { n: 10, winRate: 0.5, rich: true }))
    .filter((t) => t.bot === 'planner');
  const report = evaluateGate([...only, ...only], 1, 'x', EXTERNAL, FIXED_DATE);
  assert.equal(report.tiers.length, 4);
  assert.deepEqual(report.tiers.map((t) => t.bot), [...BOT_TIERS]);
  assert.equal(report.gatePass, false);
});

test('20,000+ records per tier aggregate without throwing', () => {
  const tiers = metricsFor();
  for (const t of tiers) assert.equal(t.runs, MIN_RUNS_PER_TIER);
  const p = tiers.find((t) => t.bot === 'planner') as TierMetrics;
  assert.equal(p.medianDecisions, 180);
  assert.equal(p.medianEstSeconds, 1500);
  assert.equal(p.medianReorderGainPct, 30);
  assert.ok(Math.abs(p.optOrderChangedRate - 7 / 12) < 1e-12);
  assert.ok(Math.abs(p.closeCallRate - 8 / 25) < 1e-12);
  assert.ok(Math.abs(p.archetypeEntropy - 1) < 1e-3, 'seven evenly-used archetypes');
});

// ---------------------------------------------------------------------------
// verdict format
// ---------------------------------------------------------------------------

test('rendered markdown carries the mandated verdict skeleton', () => {
  const report = gateFor({ planner: { rich: true, lossWeights: WALL_LOSS_WEIGHTS } });
  const md = renderMarkdown(report);
  const lines = md.split('\n');
  assert.equal(lines[0], '## Iteration 7 — 2026-09-07 — abc1234');
  assert.ok(lines.some((l) => /^G1\.1 \S+ (PASS|FAIL)/.test(l)));
  assert.ok(lines.some((l) => /^GATE: (PASS|FAIL) \(\d+ failing: .+\)/.test(l)));
  assert.ok(lines.some((l) => /^Weakest metric: (G\d\.\d — next loop targets this\.|none\.)$/.test(l)));
  // every metric gets exactly one row
  for (const id of METRIC_IDS) {
    const rows = lines.filter((l) => l.startsWith(`${id} `));
    assert.equal(rows.length, 1, `${id} should have exactly one row`);
  }
  // the honest limitation travels with the verdict
  assert.match(md, /does not predict chart position/);
});
