// TAKT — gate metrics. Pure aggregation over the frozen telemetry schema.
//
// This file is an instrument. If it is wrong, every conclusion the project
// draws from the gate is wrong. Two rules govern every decision in here:
//
//   1. Never throw. These functions run on 20,000+ records per tier at hour six
//      of an unattended loop. A crash destroys the run.
//   2. When a quantity cannot be measured, produce a value that FAILS the gate,
//      never one that passes it. An over-permissive gate is worse than a
//      wrong-but-strict one.
//
// ---------------------------------------------------------------------------
// UNIT CONTRACT (harness authors: read this)
// ---------------------------------------------------------------------------
//   RunRecord.reorderGainPct[]     percentage POINTS. 25 means "+25% score".
//   RunRecord.decisionMarginPct[]  percentage POINTS. 10 means "2nd best scores
//                                  10% below best", i.e. (best-2nd)/best*100.
//   TierMetrics.medianReorderGainPct   percentage points.
//   TierMetrics.*Rate                  fractions in [0,1].
//
// The `Pct` suffix is taken at face value. If a harness emits fractions (0.25)
// where points (25) are expected, G2.1 measures 0.25 against a bound of 25 and
// FAILS. The mistake is loud and safe in that direction; the reverse convention
// would silently turn 25 into a pass against a bound of 0.25. That asymmetry is
// why this convention was chosen.
//
// ---------------------------------------------------------------------------
// THE NaN SENTINEL
// ---------------------------------------------------------------------------
// TierMetrics is frozen and its fields are plain `number`, so there is nowhere
// to record "no samples existed". NaN is used, deliberately, as that sentinel
// (medianReorderGainPct, optOrderChangedRate, closeCallRate, medianEstSeconds,
// p99OverP50). evaluateGate() converts any non-finite metric value into an
// explicit, visible FAIL — "not measured" is never "passed".

import type { BotName, RunRecord, TierMetrics } from './telemetry.ts';

/** Tier order is fixed: every report always contains all four, even at 0 runs. */
export const BOT_TIERS: readonly BotName[] = ['random', 'greedy', 'planner', 'oracle'];

/** Shifts per run (mirrors SHIFTS_PER_RUN in engine/types.ts; duplicated to
 *  avoid a runtime dependency on a file another agent is editing). */
export const SHIFT_COUNT = 8;

/** Gate rule 2: "The gate runs on >= 20,000 simulated runs per bot tier." */
export const MIN_RUNS_PER_TIER = 20000;

/** G6.1: "2nd-best within 10% of best" -> decisionMarginPct <= 10. */
export const CLOSE_CALL_MARGIN_PCT = 10;

// --------------------------------------------------------------------------
// numeric helpers
// --------------------------------------------------------------------------

function num(x: unknown): number {
  return typeof x === 'number' && Number.isFinite(x) ? x : NaN;
}

/** Finite numbers out of a value that may not even be an array. */
function finiteNums(xs: unknown): number[] {
  if (!Array.isArray(xs)) return [];
  const out: number[] = [];
  for (const v of xs) {
    const n = num(v);
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

/**
 * Percentile by linear interpolation between order statistics, using the
 * EXCLUSIVE method (Hyndman-Fan type 6, a.k.a. Excel PERCENTILE.EXC):
 *
 *   h = p * (n + 1);  x[floor(h)] + (h - floor(h)) * (x[floor(h)+1] - x[floor(h)])
 *
 * with 1-based order statistics, clamped to the extremes when h falls outside
 * [1, n]. At p = 0.5 this is the conventional median for both parities.
 *
 * `sorted` must be ascending. Empty input returns NaN (the no-sample sentinel).
 */
export function percentile(sorted: readonly number[], p: number): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  if (n === 1) return sorted[0];
  if (!Number.isFinite(p)) return NaN;
  const q = Math.min(1, Math.max(0, p));
  const h = q * (n + 1);
  if (h <= 1) return sorted[0];
  if (h >= n) return sorted[n - 1];
  const lo = Math.floor(h);
  const frac = h - lo;
  return sorted[lo - 1] + frac * (sorted[lo] - sorted[lo - 1]);
}

/** Median of an unsorted list. Returns NaN for an empty list. */
export function median(xs: readonly number[]): number {
  if (xs.length === 0) return NaN;
  const s = xs.slice().sort((a, b) => a - b);
  return percentile(s, 0.5);
}

/**
 * Normalized Shannon entropy over a share distribution, per the spec:
 * H / log(k), where k is the number of entries with nonzero share and H is
 * computed over the shares renormalized to sum to 1. k <= 1 yields 0.
 */
export function normalizedEntropy(shares: Record<string, number>): number {
  const vals: number[] = [];
  for (const key of Object.keys(shares)) {
    const v = num(shares[key]);
    if (Number.isFinite(v) && v > 0) vals.push(v);
  }
  const k = vals.length;
  if (k <= 1) return 0;
  let total = 0;
  for (const v of vals) total += v;
  if (!(total > 0)) return 0;
  let h = 0;
  for (const v of vals) {
    const p = v / total;
    if (p > 0) h -= p * Math.log(p);
  }
  const e = h / Math.log(k);
  if (!Number.isFinite(e)) return 0;
  return Math.min(1, Math.max(0, e));
}

/** Presence rate of each key across a set of runs: (#runs containing key) / #runs.
 *  Duplicates within one run are collapsed — "appearing in X% of wins". */
function presenceShare(runs: readonly RunRecord[], pick: (r: RunRecord) => unknown): Record<string, number> {
  const out: Record<string, number> = {};
  const n = runs.length;
  if (n === 0) return out;
  const counts = new Map<string, number>();
  const seen = new Set<string>();
  for (const r of runs) {
    seen.clear();
    const list = pick(r);
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      if (typeof raw !== 'string' || raw.length === 0) continue;
      if (seen.has(raw)) continue;
      seen.add(raw);
      counts.set(raw, (counts.get(raw) ?? 0) + 1);
    }
  }
  for (const [key, c] of counts) out[key] = c / n;
  return out;
}

// --------------------------------------------------------------------------
// aggregate
// --------------------------------------------------------------------------

/**
 * Fold raw run records into one TierMetrics per bot tier.
 *
 * All four tiers are always returned, in BOT_TIERS order, even when no records
 * exist for them — a missing tier must surface as `runs: 0` (and therefore as
 * UNDERSAMPLED + FAIL downstream), never as a silently skipped metric.
 *
 * Records whose `bot` is not a known tier are ignored.
 */
export function aggregate(records: RunRecord[]): TierMetrics[] {
  const byBot = new Map<BotName, RunRecord[]>();
  for (const b of BOT_TIERS) byBot.set(b, []);
  if (Array.isArray(records)) {
    for (const r of records) {
      if (!r || typeof r !== 'object') continue;
      const bucket = byBot.get(r.bot as BotName);
      if (bucket) bucket.push(r);
    }
  }
  return BOT_TIERS.map((b) => tierMetrics(b, byBot.get(b) as RunRecord[]));
}

function tierMetrics(bot: BotName, rs: readonly RunRecord[]): TierMetrics {
  const runs = rs.length;
  const wins: RunRecord[] = [];
  const decisions: number[] = [];
  const winSeconds: number[] = [];
  const finalScores: number[] = [];
  const finalRatios: number[] = [];
  const lossShiftHistogram: number[] = new Array(SHIFT_COUNT).fill(0);
  const reorderGains: number[] = [];
  let optChangedTrue = 0;
  let optChangedTotal = 0;
  let closeCalls = 0;
  let marginSamples = 0;

  for (const r of rs) {
    const won = r.won === true;
    if (won) {
      wins.push(r);
      const s = num(r.estSeconds);
      if (Number.isFinite(s)) winSeconds.push(s);
    } else {
      // Clamp rather than drop: losing a loss understates concentration, and
      // G4.2/G4.3 exist to catch concentration.
      const raw = num(r.endShift);
      const shift = Number.isFinite(raw) ? Math.min(SHIFT_COUNT, Math.max(1, Math.round(raw))) : 1;
      lossShiftHistogram[shift - 1] += 1;
    }

    const d = num(r.decisions);
    decisions.push(Number.isFinite(d) ? d : 0);

    const score = num(r.finalScore);
    finalScores.push(Number.isFinite(score) ? score : 0);

    const quota = num(r.finalQuota);
    finalRatios.push(Number.isFinite(score) && Number.isFinite(quota) && quota > 0 ? score / quota : 0);

    for (const g of finiteNums(r.reorderGainPct)) reorderGains.push(g);

    if (Array.isArray(r.optOrderChanged)) {
      for (const c of r.optOrderChanged) {
        if (typeof c !== 'boolean') continue;
        optChangedTotal += 1;
        if (c) optChangedTrue += 1;
      }
    }

    for (const m of finiteNums(r.decisionMarginPct)) {
      marginSamples += 1;
      if (m <= CLOSE_CALL_MARGIN_PCT) closeCalls += 1;
    }
  }

  const sortedScores = finalScores.slice().sort((a, b) => a - b);
  const sortedRatios = finalRatios.slice().sort((a, b) => a - b);
  const p50FinalScore = runs > 0 ? percentile(sortedScores, 0.5) : 0;
  const p95FinalRatio = runs > 0 ? percentile(sortedRatios, 0.95) : 0;
  const p99FinalScore = runs > 0 ? percentile(sortedScores, 0.99) : NaN;
  // p50 <= 0 makes the ratio meaningless. NaN (-> FAIL), never Infinity (-> pass).
  const p99OverP50 =
    Number.isFinite(p50FinalScore) && p50FinalScore > 0 && Number.isFinite(p99FinalScore)
      ? p99FinalScore / p50FinalScore
      : NaN;

  const archetypeWinShare = presenceShare(wins, (r) => r.archetypes);
  const machineWinShare = presenceShare(wins, (r) => r.machines);

  return {
    bot,
    runs,
    winRate: runs > 0 ? wins.length / runs : 0,
    medianDecisions: runs > 0 ? median(decisions) : 0,
    // Median over WINNING runs: G7.2 asks for "median winning-run wall-clock".
    // No wins -> NaN -> G7.2 FAILS rather than reporting a plausible number.
    medianEstSeconds: winSeconds.length > 0 ? median(winSeconds) : NaN,
    lossShiftHistogram,
    p50FinalScore: Number.isFinite(p50FinalScore) ? p50FinalScore : 0,
    p95FinalRatio: Number.isFinite(p95FinalRatio) ? p95FinalRatio : 0,
    p99OverP50,
    archetypeWinShare,
    machineWinShare,
    archetypeEntropy: normalizedEntropy(archetypeWinShare),
    medianReorderGainPct: reorderGains.length > 0 ? median(reorderGains) : NaN,
    optOrderChangedRate: optChangedTotal > 0 ? optChangedTrue / optChangedTotal : NaN,
    closeCallRate: marginSamples > 0 ? closeCalls / marginSamples : NaN,
  };
}

/** Number of winning runs a tier represents (TierMetrics carries no raw count). */
export function winCount(t: TierMetrics): number {
  if (!t || !Number.isFinite(t.runs) || !Number.isFinite(t.winRate)) return 0;
  return Math.round(t.runs * t.winRate);
}

/** Number of losing runs, taken from the loss histogram (its own source of truth). */
export function lossCount(t: TierMetrics): number {
  if (!t || !Array.isArray(t.lossShiftHistogram)) return 0;
  let s = 0;
  for (const v of t.lossShiftHistogram) {
    const n = num(v);
    if (Number.isFinite(n)) s += n;
  }
  return s;
}
