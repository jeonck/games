// TAKT — verdict renderer. Pure formatting: it computes no thresholds of its
// own, it only makes gate.ts's verdict impossible to misread.
//
// The mandated skeleton from docs/bench/BENCHMARK.md is reproduced verbatim:
//
//   ## Iteration N — <date> — <commit>
//   G1.1 <value> PASS/FAIL   ... (all metrics)
//   GATE: PASS | FAIL (n failing: <list>)
//   Weakest metric: <id> — next loop targets this.
//
// Everything this renderer adds — the UNDERSAMPLED banner, the NOT MEASURED
// block, Wilson intervals and MARGINAL flags — exists to stop a weak result
// being read as a clean one. Nothing is ever removed to make a run look better.

import type { GateReport, GateResult, TierMetrics } from './telemetry.ts';
import { MIN_RUNS_PER_TIER, winCount } from './metrics.ts';
import {
  NOT_MEASURED,
  annotate,
  undersampledTiers,
  wilson95,
  type Interval,
  type MetricAnnotation,
  type MetricFormat,
} from './gate.ts';

function fmt(v: number, f: MetricFormat): string {
  if (!Number.isFinite(v)) return 'n/a';
  switch (f) {
    case 'fraction': return `${(v * 100).toFixed(2)}%`;
    case 'percent': return `${v.toFixed(2)}%`;
    case 'ratio': return `${v.toFixed(2)}×`;
    case 'pp': return `${v.toFixed(2)} pp`;
    case 'count': return Number.isInteger(v) ? String(v) : v.toFixed(1);
    case 'entropy': return v.toFixed(3);
    case 'minutes': return `${v.toFixed(1)} min`;
    default: return String(v);
  }
}

function fmtInterval(ci: Interval | null, f: MetricFormat | null): string {
  if (!ci || !f) return '';
  const lo = fmt(ci.lo, f);
  const hi = Number.isFinite(ci.hi) ? fmt(ci.hi, f) : '∞';
  return `[${lo}, ${hi}]`;
}

function valueOf(res: GateResult, a: MetricAnnotation | undefined): string {
  if (typeof res.value === 'string') return res.value;
  if (!Number.isFinite(res.value)) return NOT_MEASURED;
  return fmt(res.value as number, a?.format ?? 'count');
}

function int(x: number): string {
  return Number.isFinite(x) ? Math.round(x).toLocaleString('en-US') : 'n/a';
}

function tierRow(t: TierMetrics): string {
  const ci = wilson95(winCount(t), t.runs);
  const winTime = Number.isFinite(t.medianEstSeconds) ? `${(t.medianEstSeconds / 60).toFixed(1)} min` : 'n/a';
  const flag = t.runs >= MIN_RUNS_PER_TIER ? '' : ' ⚠';
  return `| \`${t.bot}\`${flag} | ${int(t.runs)} | ${(t.winRate * 100).toFixed(2)}% | ${fmtInterval(ci, 'fraction')} | ${int(t.medianDecisions)} | ${winTime} |`;
}

/**
 * Render one iteration's verdict as markdown, ready to append to
 * docs/bench/RESULTS.md.
 */
export function renderMarkdown(report: GateReport): string {
  const r: GateReport = report ?? ({} as GateReport);
  const results: GateResult[] = Array.isArray(r.results) ? r.results : [];
  const tiers: TierMetrics[] = Array.isArray(r.tiers) ? r.tiers : [];
  const ann = annotate(r);
  const out: string[] = [];

  out.push(`## Iteration ${Number.isFinite(r.iteration) ? r.iteration : 0} — ${r.date ?? 'unknown-date'} — ${r.commit ?? 'unknown'}`);
  out.push('');

  // --- sample adequacy, first and loudest -------------------------------
  const thin = undersampledTiers(tiers);
  if (thin.length > 0) {
    for (const t of thin) {
      out.push(`⚠ UNDERSAMPLED (n=${Number.isFinite(t.runs) ? t.runs : 0}) — tier \`${t.bot}\` is below the ${MIN_RUNS_PER_TIER.toLocaleString('en-US')}-run floor set by the gate.`);
    }
    out.push('');
    out.push('**GATE FORCED TO FAIL: a gate passed on thin data is not passed.**');
    out.push('');
  }

  // --- metrics that had no data at all ----------------------------------
  const unmeasured = results.filter((x) => !(typeof x.value === 'number' && Number.isFinite(x.value)));
  if (unmeasured.length > 0) {
    out.push(`**NOT MEASURED (${unmeasured.length}): ${unmeasured.map((x) => x.id).join(', ')}** — no samples reached the gate for these. They are counted as FAIL: an unmeasured threshold is not a met threshold.`);
    out.push('');
  }

  // --- metrics whose verdict sits inside sampling noise ------------------
  const marginal = results.filter((x) => ann.get(x.id)?.marginal);
  if (marginal.length > 0) {
    out.push(`**MARGINAL (${marginal.length}): ${marginal.map((x) => x.id).join(', ')}** — the 95% Wilson interval straddles the threshold, so the verdict on these rows would flip inside sampling noise. Treat as unproven in either direction.`);
    out.push('');
  }

  // --- tiers -------------------------------------------------------------
  out.push('| tier | runs | win rate | 95% CI (Wilson) | median decisions | median win time |');
  out.push('|---|---:|---:|---|---:|---:|');
  for (const t of tiers) out.push(tierRow(t));
  out.push('');

  // --- the metric block, in BENCHMARK order ------------------------------
  out.push('```text');
  for (const res of results) {
    const a = ann.get(res.id);
    const verdict = res.pass ? 'PASS' : 'FAIL';
    const marginalTag = a?.marginal ? ' MARGINAL' : '';
    const parts = [`${res.id} ${valueOf(res, a)} ${verdict}${marginalTag}`];
    parts.push(`threshold: ${res.threshold ?? '?'}`);
    if (a?.ci) parts.push(`95% CI ${fmtInterval(a.ci, a.ciFormat)}`);
    if (!res.pass && a && Number.isFinite(a.distance) && a.distance > 0) {
      parts.push(a.absoluteDistance ? `off by ${a.distance}` : `off by ${(a.distance * 100).toFixed(1)}%`);
    }
    if (a) parts.push(a.label);
    out.push(parts.join('   '));
  }
  out.push('```');
  out.push('');

  // --- verdict -----------------------------------------------------------
  const failing = Array.isArray(r.failing) ? r.failing : [];
  const gateLine = r.gatePass
    ? 'GATE: PASS (0 failing: none)'
    : `GATE: FAIL (${failing.length} failing: ${failing.length > 0 ? failing.join(', ') : 'none'})`;
  out.push(
    !r.gatePass && failing.length === 0
      ? `${gateLine} — forced FAIL on sample size; see UNDERSAMPLED above.`
      : gateLine,
  );
  out.push('');

  out.push(
    r.weakest
      ? `Weakest metric: ${r.weakest} — next loop targets this.`
      : 'Weakest metric: none.',
  );
  out.push('');

  out.push('_Passing this gate means the mechanic is not the reason the game would fail. It does not predict chart position — see the stated limitation in docs/bench/BENCHMARK.md._');

  return out.join('\n');
}
