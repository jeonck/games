// TAKT — measurements the frozen gate does not carry.
//
// Three reasons something lives here rather than in metrics.ts/gate.ts (which this
// agent must not modify):
//
//  1. AMENDMENT A1 REACHED BENCHMARK.md BUT NOT gate.ts. The gate file still scores
//     G2.2 against the pre-amendment "≥ 50%" and has no G2.4 at all. The harness
//     emits enough telemetry for both readings (one entry per round transition,
//     each flagged as a shift boundary or not) and computes the amended pair here,
//     alongside the number gate.ts will print, so the discrepancy is visible in the
//     report instead of silently deciding the verdict.
//  2. LOSSES BY ROUND TYPE AND BY AUDIT. RunRecord carries `endRound` and
//     `endShift`, so which audit killed a run is recoverable — and if the Audit
//     round is where runs die, "losses per shift" (G4.2) is measuring the wrong
//     axis entirely.
//  3. SEARCH COVERAGE. The gate has no opinion on how much of the search space the
//     planner actually looked at, and the reader needs it to know whether the
//     planner is the "skilled human" the gate assumes.

import type { RunRecord, TierMetrics } from './telemetry.ts';
import type { HarnessRecord } from './harness.ts';
import { BOT_TIERS, median } from './metrics.ts';
import { ROUNDS_PER_SHIFT, SHIFTS_PER_RUN } from '../engine/types.ts';

export interface OptOrderSplit {
  /** transitions inside a shift (round 1->2, 2->3) — the amended G2.2 axis */
  withinShiftRate: number;
  withinShiftN: number;
  /** transitions across a shift boundary (round 3 -> next shift round 1) — G2.4 */
  boundaryRate: number;
  boundaryN: number;
  /** every transition, which is what gate.ts's G2.2 currently reads */
  allRate: number;
  allN: number;
  /** the same three, comparing the FULL def sequence instead of relative order */
  strictWithinShiftRate: number;
  strictBoundaryRate: number;
  strictAllRate: number;
}

export function optOrderSplit(records: readonly HarnessRecord[]): OptOrderSplit {
  let wn = 0; let wt = 0; let bn = 0; let bt = 0;
  let swn = 0; let sbn = 0;
  for (const r of records) {
    const flags = Array.isArray(r.optOrderShiftBoundary) ? r.optOrderShiftBoundary : [];
    const changed = Array.isArray(r.optOrderChanged) ? r.optOrderChanged : [];
    const strict = Array.isArray(r.optOrderChangedStrict) ? r.optOrderChangedStrict : [];
    for (let i = 0; i < changed.length; i++) {
      const boundary = flags[i] === true;
      if (boundary) { bt++; if (changed[i]) bn++; if (strict[i]) sbn++; }
      else { wt++; if (changed[i]) wn++; if (strict[i]) swn++; }
    }
  }
  const all = wt + bt;
  return {
    withinShiftRate: wt > 0 ? wn / wt : NaN,
    withinShiftN: wt,
    boundaryRate: bt > 0 ? bn / bt : NaN,
    boundaryN: bt,
    allRate: all > 0 ? (wn + bn) / all : NaN,
    allN: all,
    strictWithinShiftRate: wt > 0 ? swn / wt : NaN,
    strictBoundaryRate: bt > 0 ? sbn / bt : NaN,
    strictAllRate: all > 0 ? (swn + sbn) / all : NaN,
  };
}

export interface RoundTypeLosses {
  /** index 0 = round 1, 1 = round 2, 2 = the Audit */
  counts: number[];
  shares: number[];
  total: number;
}

export function roundTypeLosses(records: readonly RunRecord[]): RoundTypeLosses {
  const counts = [0, 0, 0];
  let total = 0;
  for (const r of records) {
    if (r.won === true) continue;
    const rd = Math.min(ROUNDS_PER_SHIFT, Math.max(1, Math.round(r.endRound)));
    counts[rd - 1] += 1;
    total += 1;
  }
  return { counts, shares: counts.map((c) => (total > 0 ? c / total : NaN)), total };
}

export interface AuditStat {
  shift: number;
  def: string;
  name: string;
  /** runs that reached this Audit round at all */
  attempts: number;
  /** runs that died on it */
  losses: number;
  /** losses / attempts */
  killRate: number;
  /** losses on this audit as a share of ALL losses */
  shareOfLosses: number;
}

/**
 * Per-audit kill rates. A run reached shift S's Audit if it got past S round 2 —
 * i.e. it ended later than S, or it ended ON S round 3.
 */
export function auditStats(
  records: readonly RunRecord[], audits: readonly { def: string; name: string }[],
): AuditStat[] {
  const attempts = new Array(SHIFTS_PER_RUN).fill(0);
  const losses = new Array(SHIFTS_PER_RUN).fill(0);
  let allLosses = 0;
  for (const r of records) {
    const es = Math.min(SHIFTS_PER_RUN, Math.max(1, Math.round(r.endShift)));
    const er = Math.min(ROUNDS_PER_SHIFT, Math.max(1, Math.round(r.endRound)));
    if (r.won !== true) allLosses += 1;
    for (let sh = 1; sh <= SHIFTS_PER_RUN; sh++) {
      if (es > sh || (es === sh && er >= ROUNDS_PER_SHIFT)) attempts[sh - 1] += 1;
    }
    if (r.won !== true && er >= ROUNDS_PER_SHIFT) losses[es - 1] += 1;
  }
  return audits.slice(0, SHIFTS_PER_RUN).map((a, i) => ({
    shift: i + 1,
    def: a.def,
    name: a.name,
    attempts: attempts[i],
    losses: losses[i],
    killRate: attempts[i] > 0 ? losses[i] / attempts[i] : NaN,
    shareOfLosses: allLosses > 0 ? losses[i] / allLosses : NaN,
  }));
}

export interface Coverage {
  /** median, over shipment decisions, of ordered selections scored */
  medianEvaluated: number;
  minEvaluated: number;
  maxEvaluated: number;
  /** previewShipment calls per run */
  medianPreviews: number;
  /** decisions where the preview budget cut a search short */
  budgetHitRuns: number;
}

export function coverage(records: readonly HarnessRecord[]): Coverage {
  const meds: number[] = [];
  const mins: number[] = [];
  const maxs: number[] = [];
  const prev: number[] = [];
  let hits = 0;
  for (const r of records) {
    if (r.shipmentDecisions > 0) {
      meds.push(r.evalP50);
      mins.push(r.evalMin);
      maxs.push(r.evalMax);
    }
    prev.push(r.previews);
    if (r.budgetHits > 0) hits += 1;
  }
  return {
    medianEvaluated: median(meds),
    minEvaluated: mins.length > 0 ? Math.min(...mins) : NaN,
    maxEvaluated: maxs.length > 0 ? Math.max(...maxs) : NaN,
    medianPreviews: median(prev),
    budgetHitRuns: hits,
  };
}

export interface DominanceCheck {
  ok: boolean;
  rates: Record<string, number>;
  gaps: { pair: string; gap: number }[];
  inversions: string[];
  runs: number;
}

/** oracle >= planner >= greedy >= random, on a shared seed set. */
export function dominance(tiers: readonly TierMetrics[]): DominanceCheck {
  const by = new Map(tiers.map((t) => [t.bot, t]));
  const rates: Record<string, number> = {};
  for (const b of BOT_TIERS) rates[b] = by.get(b)?.winRate ?? NaN;
  const order = ['oracle', 'planner', 'greedy', 'random'];
  const gaps: { pair: string; gap: number }[] = [];
  const inversions: string[] = [];
  for (let i = 0; i < order.length - 1; i++) {
    const hi = rates[order[i]];
    const lo = rates[order[i + 1]];
    const gap = hi - lo;
    gaps.push({ pair: `${order[i]} - ${order[i + 1]}`, gap });
    if (!(gap >= 0)) inversions.push(`${order[i]} (${(hi * 100).toFixed(2)}%) < ${order[i + 1]} (${(lo * 100).toFixed(2)}%)`);
  }
  const runs = Math.min(...BOT_TIERS.map((b) => by.get(b)?.runs ?? 0));
  return { ok: inversions.length === 0, rates, gaps, inversions, runs };
}
