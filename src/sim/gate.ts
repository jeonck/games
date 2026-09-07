// TAKT — the gate. Turns TierMetrics into a PASS/FAIL verdict against every
// threshold in docs/bench/BENCHMARK.md.
//
// Design rules, in priority order:
//   1. Every G-metric in BENCHMARK.md appears in GateReport.results, always, in
//      spec order. A metric that cannot be computed appears as an explicit
//      "not measured" FAIL. Metrics are never dropped.
//   2. Nothing throws.
//   3. Any ambiguity resolves toward FAIL. A gate that passes on data it did
//      not have is worse than no gate.
//
// GateReport itself is frozen (src/sim/telemetry.ts). Everything the renderer
// needs beyond those four fields — units, confidence intervals, marginality,
// distance-from-threshold — is derived here by annotate(), so gate.ts stays the
// single source of truth for thresholds and report.ts stays a pure formatter.

import type { BotName, GateReport, GateResult, TierMetrics } from './telemetry.ts';
import { BOT_TIERS, MIN_RUNS_PER_TIER, lossCount, winCount } from './metrics.ts';

export { MIN_RUNS_PER_TIER };

/**
 * Measurements the run harness cannot derive from RunRecord[].
 *
 * G2.3 (non-commutative machine pairs) is a property of the CONTENT SET, not of
 * any run: it is measured by the content harness over random (machine, machine,
 * batch) triples. If it is not supplied, G2.3 is reported as NOT MEASURED and
 * FAILS. There is no default value — assuming a content set is non-commutative
 * is exactly the assumption this gate exists to test.
 */
export interface ExternalMeasurements {
  /** G2.3: fraction in [0,1] of random machine pairs where A(B(x)) != B(A(x)). */
  nonCommutativePairRate?: number;
}

export type MetricFormat =
  | 'fraction'   // 0..1, rendered as a percentage
  | 'percent'    // already percentage points
  | 'ratio'      // "x times"
  | 'pp'         // percentage-point difference
  | 'count'      // integer count
  | 'entropy'    // 0..1, rendered raw
  | 'minutes';

type BoundKind = 'lt' | 'lte' | 'gte' | 'range' | 'zero';

export interface Bound {
  kind: BoundKind;
  /** lower bound for 'gte' and 'range' */
  lo?: number;
  /** upper bound for 'lt', 'lte' and 'range' */
  hi?: number;
}

interface MetricSpec {
  id: string;
  label: string;
  threshold: string;
  format: MetricFormat;
  bound: Bound;
  /** Returns NaN when the quantity has no samples -> reported as NOT MEASURED. */
  value: (c: Ctx) => number;
}

interface Ctx {
  tier: (b: BotName) => TierMetrics;
  external: ExternalMeasurements;
}

const EMPTY_TIER = (bot: BotName): TierMetrics => ({
  bot,
  runs: 0,
  winRate: 0,
  medianDecisions: 0,
  medianEstSeconds: NaN,
  lossShiftHistogram: [],
  p50FinalScore: 0,
  p95FinalRatio: 0,
  p99OverP50: NaN,
  archetypeWinShare: {},
  machineWinShare: {},
  archetypeEntropy: 0,
  medianReorderGainPct: NaN,
  optOrderChangedRate: NaN,
  closeCallRate: NaN,
});

function n(x: unknown): number {
  return typeof x === 'number' && Number.isFinite(x) ? x : NaN;
}

/** Largest presence share in a share map, or NaN when the map is empty. */
function maxShare(shares: Record<string, number>): number {
  let m = NaN;
  for (const k of Object.keys(shares ?? {})) {
    const v = n(shares[k]);
    if (!Number.isFinite(v)) continue;
    if (!Number.isFinite(m) || v > m) m = v;
  }
  return m;
}

function countAtLeast(shares: Record<string, number>, bound: number): number {
  let c = 0;
  for (const k of Object.keys(shares ?? {})) {
    const v = n(shares[k]);
    if (Number.isFinite(v) && v >= bound) c += 1;
  }
  return c;
}

function countAbove(shares: Record<string, number>, bound: number): number {
  let c = 0;
  for (const k of Object.keys(shares ?? {})) {
    const v = n(shares[k]);
    if (Number.isFinite(v) && v > bound) c += 1;
  }
  return c;
}

// --------------------------------------------------------------------------
// The gate itself. One entry per row of BENCHMARK.md, in file order.
// --------------------------------------------------------------------------
//
// Tier attribution (documented because the spec tables do not always say it):
//   G2, G3, G4, G5, G6, G7 are all read off the `planner` tier. The planner is
//   the reference "competent human" tier: G1.3 pins its win rate to 40-60%, so
//   it is the only tier whose distributions describe the experience the game
//   actually ships. Cheap tiers emit empty G2/G6 sample arrays by design.

const SPECS: MetricSpec[] = [
  // ---- G1 skill gap ----
  {
    id: 'G1.1', label: 'random win rate', threshold: '< 2%', format: 'fraction',
    bound: { kind: 'lt', hi: 0.02 },
    value: (c) => c.tier('random').winRate,
  },
  {
    id: 'G1.2', label: 'greedy win rate', threshold: '8% – 25%', format: 'fraction',
    bound: { kind: 'range', lo: 0.08, hi: 0.25 },
    value: (c) => c.tier('greedy').winRate,
  },
  {
    id: 'G1.3', label: 'planner win rate', threshold: '40% – 60%', format: 'fraction',
    bound: { kind: 'range', lo: 0.40, hi: 0.60 },
    value: (c) => c.tier('planner').winRate,
  },
  {
    id: 'G1.4', label: 'oracle win rate', threshold: '65% – 88%', format: 'fraction',
    bound: { kind: 'range', lo: 0.65, hi: 0.88 },
    value: (c) => c.tier('oracle').winRate,
  },
  {
    id: 'G1.5', label: 'planner / greedy win-rate ratio', threshold: '≥ 2.5×', format: 'ratio',
    bound: { kind: 'gte', lo: 2.5 },
    // A greedy win rate of 0 makes the ratio undefined, not infinite. Reporting
    // "infinitely better than nothing" as a pass would be a lie about a game
    // whose greedy tier never wins.
    value: (c) => {
      const g = n(c.tier('greedy').winRate);
      const p = n(c.tier('planner').winRate);
      if (!Number.isFinite(g) || !Number.isFinite(p) || g <= 0) return NaN;
      return p / g;
    },
  },
  {
    id: 'G1.6', label: 'oracle − planner win rate', threshold: '≥ 10 percentage points', format: 'pp',
    bound: { kind: 'gte', lo: 10 },
    value: (c) => {
      const o = n(c.tier('oracle').winRate);
      const p = n(c.tier('planner').winRate);
      if (!Number.isFinite(o) || !Number.isFinite(p)) return NaN;
      return (o - p) * 100;
    },
  },

  // ---- G2 ordering is load-bearing ----
  {
    id: 'G2.1', label: 'median score gain from optimal reorder', threshold: '≥ 25%', format: 'percent',
    bound: { kind: 'gte', lo: 25 },
    value: (c) => n(c.tier('planner').medianReorderGainPct),
  },
  {
    id: 'G2.2', label: 'rounds where optimal ordering changed', threshold: '≥ 50%', format: 'fraction',
    bound: { kind: 'gte', lo: 0.50 },
    value: (c) => n(c.tier('planner').optOrderChangedRate),
  },
  {
    id: 'G2.3', label: 'non-commutative machine pairs', threshold: '≥ 60%', format: 'fraction',
    bound: { kind: 'gte', lo: 0.60 },
    // Not derivable from RunRecord[]; supplied by the content harness or NOT MEASURED.
    value: (c) => n(c.external?.nonCommutativePairRate),
  },

  // ---- G3 build diversity ----
  {
    id: 'G3.1', label: 'most-used archetype share of planner wins', threshold: '≤ 55%', format: 'fraction',
    bound: { kind: 'lte', hi: 0.55 },
    // Zero wins means zero evidence of diversity, not perfect diversity.
    value: (c) => (winCount(c.tier('planner')) > 0 ? maxShare(c.tier('planner').archetypeWinShare) : NaN),
  },
  {
    id: 'G3.2', label: 'archetypes appearing in ≥ 15% of wins', threshold: '≥ 5', format: 'count',
    bound: { kind: 'gte', lo: 5 },
    value: (c) => (winCount(c.tier('planner')) > 0 ? countAtLeast(c.tier('planner').archetypeWinShare, 0.15) : NaN),
  },
  {
    id: 'G3.3', label: 'normalized Shannon entropy over archetype usage', threshold: '≥ 0.80', format: 'entropy',
    bound: { kind: 'gte', lo: 0.80 },
    value: (c) => (winCount(c.tier('planner')) > 0 ? n(c.tier('planner').archetypeEntropy) : NaN),
  },
  {
    id: 'G3.4', label: 'machine defs in > 60% of wins', threshold: '0 such machines', format: 'count',
    bound: { kind: 'zero' },
    value: (c) => (winCount(c.tier('planner')) > 0 ? countAbove(c.tier('planner').machineWinShare, 0.60) : NaN),
  },

  // ---- G4 tension curve ----
  {
    id: 'G4.1', label: 'planner win rate (tension)', threshold: '40% – 60%', format: 'fraction',
    bound: { kind: 'range', lo: 0.40, hi: 0.60 },
    value: (c) => c.tier('planner').winRate,
  },
  {
    id: 'G4.2', label: 'largest share of losses in one shift', threshold: '≤ 35%', format: 'fraction',
    bound: { kind: 'lte', hi: 0.35 },
    value: (c) => {
      const t = c.tier('planner');
      const total = lossCount(t);
      if (!(total > 0)) return NaN;
      let m = 0;
      for (const v of t.lossShiftHistogram) {
        const x = n(v);
        if (Number.isFinite(x) && x > m) m = x;
      }
      return m / total;
    },
  },
  {
    id: 'G4.3', label: 'losses in shifts 1–2', threshold: '≤ 20%', format: 'fraction',
    bound: { kind: 'lte', hi: 0.20 },
    value: (c) => {
      const t = c.tier('planner');
      const total = lossCount(t);
      if (!(total > 0)) return NaN;
      const h = t.lossShiftHistogram;
      const early = (n(h?.[0]) || 0) + (n(h?.[1]) || 0);
      return early / total;
    },
  },

  // ---- G5 snowball ceiling ----
  {
    id: 'G5.1', label: 'p95 final score / final quota', threshold: '≥ 20×', format: 'ratio',
    bound: { kind: 'gte', lo: 20 },
    value: (c) => (c.tier('planner').runs > 0 ? n(c.tier('planner').p95FinalRatio) : NaN),
  },
  {
    id: 'G5.2', label: 'p99 / p50 final score', threshold: '≥ 50×', format: 'ratio',
    bound: { kind: 'gte', lo: 50 },
    value: (c) => (c.tier('planner').runs > 0 ? n(c.tier('planner').p99OverP50) : NaN),
  },

  // ---- G6 decisions are non-obvious ----
  {
    id: 'G6.1', label: 'shipments where 2nd-best is within 10% of best', threshold: '20% – 45%', format: 'fraction',
    bound: { kind: 'range', lo: 0.20, hi: 0.45 },
    value: (c) => n(c.tier('planner').closeCallRate),
  },

  // ---- G7 session shape ----
  {
    id: 'G7.1', label: 'median planner run length', threshold: '120 – 260 decisions', format: 'count',
    bound: { kind: 'range', lo: 120, hi: 260 },
    value: (c) => (c.tier('planner').runs > 0 ? n(c.tier('planner').medianDecisions) : NaN),
  },
  {
    id: 'G7.2', label: 'median winning-run wall clock', threshold: '15 – 35 min', format: 'minutes',
    bound: { kind: 'range', lo: 15, hi: 35 },
    value: (c) => {
      const s = n(c.tier('planner').medianEstSeconds);
      return Number.isFinite(s) ? s / 60 : NaN;
    },
  },
];

/** Every metric id the gate reports, in BENCHMARK.md order. */
export const METRIC_IDS: readonly string[] = SPECS.map((s) => s.id);

export const NOT_MEASURED = 'n/a (not measured)';

// --------------------------------------------------------------------------
// comparison + distance
// --------------------------------------------------------------------------

function passes(b: Bound, v: number): boolean {
  switch (b.kind) {
    case 'lt': return v < (b.hi as number);
    case 'lte': return v <= (b.hi as number);
    case 'gte': return v >= (b.lo as number);
    case 'range': return v >= (b.lo as number) && v <= (b.hi as number);
    case 'zero': return v === 0;
    default: return false;
  }
}

function rel(overshoot: number, bound: number): number {
  const b = Math.abs(bound);
  return b > 0 ? overshoot / b : Math.abs(overshoot);
}

/**
 * How far a failing value sits from the bound it violates, as a relative
 * distance |value - bound| / |bound|. For a range, distance is measured to the
 * nearer (i.e. the violated) bound. For the "0 such machines" bound there is no
 * meaningful denominator, so the absolute count is used — a count of 1 scores
 * 1.0, the same as being 100% off a numeric bound.
 *
 * Returns 0 for a passing value.
 */
export function thresholdDistance(b: Bound, v: number): number {
  if (!Number.isFinite(v)) return NaN;
  if (passes(b, v)) return 0;
  switch (b.kind) {
    case 'lt':
    case 'lte':
      return rel(v - (b.hi as number), b.hi as number);
    case 'gte':
      return rel((b.lo as number) - v, b.lo as number);
    case 'range':
      return v < (b.lo as number)
        ? rel((b.lo as number) - v, b.lo as number)
        : rel(v - (b.hi as number), b.hi as number);
    case 'zero':
      return Math.abs(v);
    default:
      return NaN;
  }
}

// --------------------------------------------------------------------------
// Wilson score interval
// --------------------------------------------------------------------------

const Z95 = 1.959963984540054;

export interface Interval { lo: number; hi: number }

/**
 * 95% Wilson score interval for a binomial proportion. n <= 0 yields the
 * completely uninformative [0, 1] — which straddles every threshold and so
 * marks the metric MARGINAL, which is the honest answer for no data.
 */
export function wilson95(successes: number, total: number): Interval {
  if (!Number.isFinite(total) || total <= 0) return { lo: 0, hi: 1 };
  const k = Math.min(Math.max(Number.isFinite(successes) ? successes : 0, 0), total);
  const p = k / total;
  const z2 = Z95 * Z95;
  const denom = 1 + z2 / total;
  const centre = (p + z2 / (2 * total)) / denom;
  const half = (Z95 / denom) * Math.sqrt((p * (1 - p)) / total + z2 / (4 * total * total));
  return { lo: Math.max(0, centre - half), hi: Math.min(1, centre + half) };
}

/** Newcombe's hybrid-score interval for a difference of two proportions. */
function diffInterval(a: Interval, pa: number, b: Interval, pb: number): Interval {
  const lo = pa - pb - Math.sqrt((pa - a.lo) ** 2 + (b.hi - pb) ** 2);
  const hi = pa - pb + Math.sqrt((a.hi - pa) ** 2 + (pb - b.lo) ** 2);
  return { lo, hi };
}

/** Conservative interval for a ratio of two proportions, from their own intervals. */
function ratioInterval(a: Interval, b: Interval): Interval {
  const lo = b.hi > 0 ? a.lo / b.hi : 0;
  const hi = b.lo > 0 ? a.hi / b.lo : Infinity;
  return { lo, hi };
}

function bounds(b: Bound): number[] {
  switch (b.kind) {
    case 'lt':
    case 'lte': return [b.hi as number];
    case 'gte': return [b.lo as number];
    case 'range': return [b.lo as number, b.hi as number];
    default: return [];
  }
}

function straddles(ci: Interval, bs: readonly number[]): boolean {
  for (const b of bs) if (ci.lo <= b && b <= ci.hi) return true;
  return false;
}

// --------------------------------------------------------------------------
// annotations for the renderer
// --------------------------------------------------------------------------

export interface MetricAnnotation {
  id: string;
  label: string;
  format: MetricFormat;
  /** relative distance from the violated bound; 0 when passing, NaN when unmeasured */
  distance: number;
  /** 95% interval on the underlying proportion, when the metric is one */
  ci: Interval | null;
  /** interval units: 'fraction' intervals render as percentages, others raw */
  ciFormat: MetricFormat | null;
  /** the interval straddles a threshold bound: the verdict is inside the noise */
  marginal: boolean;
  measured: boolean;
  /** true when `distance` is an absolute count rather than a relative fraction
   *  (the "0 such machines" bound has no denominator) */
  absoluteDistance: boolean;
}

const SPEC_BY_ID = new Map<string, MetricSpec>(SPECS.map((s) => [s.id, s]));

/**
 * Everything the renderer needs that GateReport (frozen) cannot carry:
 * units, confidence intervals, marginality and distance-from-threshold.
 *
 * MARGINAL is computed for every metric whose value is a win rate (G1.1-G1.4,
 * G4.1) plus the two derived comparisons G1.5 and G1.6, using conservative
 * intervals. A metric is MARGINAL when its 95% interval contains a threshold
 * bound — i.e. the verdict would flip inside sampling noise. Marginality never
 * changes the boolean pass; it changes how loudly the row is reported.
 */
export function annotate(report: GateReport): Map<string, MetricAnnotation> {
  const out = new Map<string, MetricAnnotation>();
  const tiers = new Map<BotName, TierMetrics>();
  for (const b of BOT_TIERS) tiers.set(b, EMPTY_TIER(b));
  for (const t of report?.tiers ?? []) {
    if (t && tiers.has(t.bot)) tiers.set(t.bot, t);
  }
  const tier = (b: BotName): TierMetrics => tiers.get(b) as TierMetrics;
  const ciOf = (b: BotName): Interval => {
    const t = tier(b);
    return wilson95(winCount(t), t.runs);
  };

  const winRateMetric: Record<string, BotName> = {
    'G1.1': 'random', 'G1.2': 'greedy', 'G1.3': 'planner', 'G1.4': 'oracle', 'G4.1': 'planner',
  };

  for (const res of report?.results ?? []) {
    const spec = SPEC_BY_ID.get(res.id);
    if (!spec) continue;
    const measured = typeof res.value === 'number' && Number.isFinite(res.value);
    const v = measured ? (res.value as number) : NaN;
    let ci: Interval | null = null;
    let ciFormat: MetricFormat | null = null;

    const wrTier = winRateMetric[res.id];
    if (wrTier) {
      ci = ciOf(wrTier);
      ciFormat = 'fraction';
    } else if (res.id === 'G1.5') {
      ci = ratioInterval(ciOf('planner'), ciOf('greedy'));
      ciFormat = 'ratio';
    } else if (res.id === 'G1.6') {
      const o = ciOf('oracle');
      const p = ciOf('planner');
      const d = diffInterval(o, tier('oracle').winRate, p, tier('planner').winRate);
      ci = { lo: d.lo * 100, hi: d.hi * 100 };
      ciFormat = 'pp';
    }

    out.set(res.id, {
      id: res.id,
      label: spec.label,
      format: spec.format,
      distance: measured ? thresholdDistance(spec.bound, v) : NaN,
      ci,
      ciFormat,
      marginal: ci !== null && straddles(ci, bounds(spec.bound)),
      measured,
      absoluteDistance: spec.bound.kind === 'zero',
    });
  }
  return out;
}

/** Tiers that did not meet the >= 20,000-run rule, in tier order. */
export function undersampledTiers(tiers: readonly TierMetrics[]): TierMetrics[] {
  const byBot = new Map<BotName, TierMetrics>();
  for (const b of BOT_TIERS) byBot.set(b, EMPTY_TIER(b));
  for (const t of tiers ?? []) if (t && byBot.has(t.bot)) byBot.set(t.bot, t);
  return BOT_TIERS
    .map((b) => byBot.get(b) as TierMetrics)
    .filter((t) => !(Number.isFinite(t.runs) && t.runs >= MIN_RUNS_PER_TIER));
}

// --------------------------------------------------------------------------
// evaluateGate
// --------------------------------------------------------------------------

/**
 * Render the verdict.
 *
 * gatePass requires BOTH that every metric passes AND that all four tiers were
 * run at >= MIN_RUNS_PER_TIER. A gate passed on thin data is not passed.
 *
 * `weakest` is the failing metric furthest from its threshold by relative
 * distance. Metrics that could not be measured have no distance; they are
 * eligible only when no failing metric has a measurable one, in which case the
 * first such metric in BENCHMARK order is named (the instrument is what needs
 * fixing before the game does). Ties are broken by BENCHMARK order, so the
 * verdict is deterministic.
 */
export function evaluateGate(
  tiers: TierMetrics[],
  iteration: number,
  commit: string,
  external: ExternalMeasurements = {},
  now: Date = new Date(),
): GateReport {
  const byBot = new Map<BotName, TierMetrics>();
  for (const b of BOT_TIERS) byBot.set(b, EMPTY_TIER(b));
  for (const t of tiers ?? []) if (t && byBot.has(t.bot)) byBot.set(t.bot, t);
  const orderedTiers = BOT_TIERS.map((b) => byBot.get(b) as TierMetrics);

  const ctx: Ctx = {
    tier: (b) => byBot.get(b) as TierMetrics,
    external: external ?? {},
  };

  const results: GateResult[] = [];
  const distances = new Map<string, number>();

  for (const spec of SPECS) {
    let raw = NaN;
    try {
      raw = spec.value(ctx);
    } catch {
      raw = NaN; // an instrument that throws is an instrument that measured nothing
    }
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      results.push({ id: spec.id, value: NOT_MEASURED, threshold: spec.threshold, pass: false });
      distances.set(spec.id, NaN);
      continue;
    }
    const pass = passes(spec.bound, raw);
    results.push({ id: spec.id, value: raw, threshold: spec.threshold, pass });
    distances.set(spec.id, thresholdDistance(spec.bound, raw));
  }

  const failing = results.filter((r) => !r.pass).map((r) => r.id);

  let weakest: string | null = null;
  let best = -Infinity;
  for (const id of failing) {
    const d = distances.get(id);
    if (typeof d === 'number' && Number.isFinite(d) && d > best) {
      best = d;
      weakest = id;
    }
  }
  if (weakest === null && failing.length > 0) weakest = failing[0];

  const undersampled = undersampledTiers(orderedTiers).length > 0;
  const gatePass = failing.length === 0 && !undersampled;

  const iter = Number.isFinite(iteration) ? iteration : 0;
  const date = Number.isFinite(now?.getTime?.()) ? now.toISOString().slice(0, 10) : 'unknown-date';

  return {
    iteration: iter,
    date,
    commit: typeof commit === 'string' && commit.length > 0 ? commit : 'unknown',
    tiers: orderedTiers,
    results,
    gatePass,
    failing,
    weakest,
  };
}
