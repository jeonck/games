// TAKT — the benchmark driver.
//
//   node --experimental-strip-types src/sim/cli.ts --runs 20000 --bots all \
//        --out docs/bench/RESULTS.md
//
// Runs every tier on the SAME seed set (that is what makes the win-rate ladder a
// comparison rather than four separate experiments), folds the records through the
// frozen metrics/gate/report pipeline, appends the verdict to RESULTS.md, and then
// appends the measurements the frozen gate has no field for: the amended G2.2/G2.4
// pair, losses by round type and by named Audit, planner search coverage, measured
// throughput, and the rng-fishing A/B.
//
// Flags:
//   --runs N          runs per tier (default 20000)
//   --bots all|a,b    tiers to run (default all)
//   --out PATH        markdown to append to (default docs/bench/RESULTS.md)
//   --workers N       worker threads (default availableParallelism, capped at 8)
//   --chunk N         seeds per work item (default 250)
//   --offset N        first seed - 1 (default 0)
//   --iteration N     iteration number written into the report header
//   --samples N       rng streams averaged per candidate (the fishing fix, default 8)
//   --fishing-ab N    additionally run N planner runs WITH the bug, for the A/B
//   --no-write        print to stdout only

import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import '../content/index.ts';
import { AUDITS, measureNonCommutativity } from '../content/index.ts';
import { aggregate, winCount } from './metrics.ts';
import { evaluateGate } from './gate.ts';
import { renderMarkdown } from './report.ts';
import { seedRange } from './harness.ts';
import type { HarnessRecord } from './harness.ts';
import { poolSize, runPool } from './pool.ts';
import type { BotName } from './telemetry.ts';
import {
  auditStats, coverage, dominance, marginStats, optOrderSplit, roundTypeLosses,
} from './analysis.ts';

const ALL: BotName[] = ['random', 'greedy', 'planner', 'oracle'];

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  return fallback;
}
function flag(name: string): boolean {
  return process.argv.indexOf(`--${name}`) >= 0;
}
function num(name: string, fallback: number): number {
  const v = arg(name);
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function pct(x: number): string {
  return Number.isFinite(x) ? `${(x * 100).toFixed(2)}%` : 'n/a';
}

function commit(): string {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

async function main(): Promise<void> {
  const runs = Math.max(1, Math.floor(num('runs', 20000)));
  const botsArg = arg('bots', 'all') as string;
  const bots = botsArg === 'all'
    ? ALL
    : botsArg.split(',').map((b) => b.trim()).filter((b) => (ALL as string[]).includes(b)) as BotName[];
  const out = arg('out', 'docs/bench/RESULTS.md') as string;
  const workers = poolSize(num('workers', 0));
  const chunk = Math.max(1, Math.floor(num('chunk', 250)));
  const offset = Math.floor(num('offset', 0));
  const iteration = Math.floor(num('iteration', 1));
  const samples = Math.max(1, Math.floor(num('samples', 8)));
  const fishingAb = Math.floor(num('fishing-ab', 0));

  const seeds = seedRange(runs, offset);
  const records: HarnessRecord[] = [];
  const timing: { bot: string; perRun: number; wall: number; runsPerSecPerCore: number }[] = [];

  for (const bot of bots) {
    process.stderr.write(`[sim] ${bot}: ${runs} runs on ${workers} workers…\n`);
    const res = await runPool(bot, { samples }, seeds, workers, chunk, (done, total) => {
      if (done % (chunk * workers * 4) === 0) {
        process.stderr.write(`[sim]   ${bot} ${done}/${total}\n`);
      }
    });
    for (const r of res.records) records.push(r);
    const perRun = res.workerMs / Math.max(1, res.records.length);
    timing.push({
      bot,
      perRun,
      wall: res.wallMs,
      runsPerSecPerCore: 1000 / perRun,
    });
    process.stderr.write(
      `[sim]   ${bot} done in ${(res.wallMs / 1000).toFixed(1)}s `
      + `(${perRun.toFixed(1)} ms/run, ${(1000 / perRun).toFixed(1)} runs/s/core)\n`,
    );
  }

  // --- the frozen pipeline ------------------------------------------------
  const nc = measureNonCommutativity();
  const tiers = aggregate(records);
  const report = evaluateGate(tiers, iteration, commit(), { nonCommutativePairRate: nc.rate });
  const md: string[] = [renderMarkdown(report)];

  // --- the measurements the frozen gate cannot carry ----------------------
  const planner = records.filter((r) => r.bot === 'planner');
  const split = optOrderSplit(planner);
  const cov = coverage(planner);
  const dom = dominance(tiers);

  md.push('');
  md.push('### Supplement — measurements the frozen gate does not carry');
  md.push('');
  md.push('_Produced by `src/sim/analysis.ts`. `src/sim/gate.ts` is frozen for this'
    + ' agent and still scores the PRE-AMENDMENT G2.2 (`≥ 50%`) and has no G2.4;'
    + ' the amended pair from `docs/bench/BENCHMARK.md` §A1 is computed here._');
  md.push('');
  md.push('| metric | value | n | threshold (amended) | verdict |');
  md.push('|---|---:|---:|---|---|');
  md.push(`| G2.2 optimal order changed, WITHIN a shift | ${pct(split.withinShiftRate)} | ${split.withinShiftN} | ≤ 30% | ${split.withinShiftRate <= 0.30 ? 'PASS' : 'FAIL'} |`);
  md.push(`| G2.4 optimal order changed, ACROSS a shift boundary | ${pct(split.boundaryRate)} | ${split.boundaryN} | ≥ 60% | ${split.boundaryRate >= 0.60 ? 'PASS' : 'FAIL'} |`);
  md.push(`| (gate.ts's G2.2: all transitions pooled) | ${pct(split.allRate)} | ${split.allN} | — | — |`);
  md.push(`| strict variant, within a shift (full def sequence) | ${pct(split.strictWithinShiftRate)} | ${split.withinShiftN} | — | — |`);
  md.push(`| strict variant, across a boundary | ${pct(split.strictBoundaryRate)} | ${split.boundaryN} | — | — |`);
  md.push('');
  md.push('`optOrderChanged` compares the RELATIVE order of the machines the line kept'
    + ' between the two rounds; the strict variant compares the full def sequence, so'
    + ' buying a machine counts as a change on its own. Both are reported so the'
    + ' choice is the reader\'s.');
  md.push('');

  // --- losses by round type ----------------------------------------------
  const mg = marginStats(planner);
  md.push('#### G6.1 read two ways');
  md.push('');
  md.push('| reading | value | n | threshold |');
  md.push('|---|---:|---:|---|');
  md.push(`| 2nd-best ORDERED SELECTION within 10% (what gate.ts scores) | ${pct(mg.closeCallStrict)} | ${mg.nStrict} | 20–45% |`);
  md.push(`| …of those, exact ties | ${pct(mg.tieRate)} | ${mg.nStrict} | — |`);
  md.push(`| 2nd-best DIFFERENT-SUBSET shipment within 10% | ${pct(mg.closeCallSubset)} | ${mg.nSubset} | — |`);
  md.push('');
  md.push('The first runner-up is usually the same shipment with one scoreless part'
    + ' added or two commuting parts swapped, which ties exactly. The second asks'
    + ' whether a genuinely different shipment was nearly as good.');
  md.push('');

  md.push('#### Losses by round type — where runs actually die');
  md.push('');
  md.push('| tier | round 1 | round 2 | Audit (round 3) | losses |');
  md.push('|---|---:|---:|---:|---:|');
  for (const b of bots) {
    const rt = roundTypeLosses(records.filter((r) => r.bot === b));
    md.push(`| \`${b}\` | ${pct(rt.shares[0])} | ${pct(rt.shares[1])} | **${pct(rt.shares[2])}** | ${rt.total} |`);
  }
  md.push('');
  md.push('G4.2/G4.3 measure loss concentration across SHIFTS. This table measures it'
    + ' across ROUND TYPES, which the gate has no metric for. A third of rounds are'
    + ' Audits, so a healthy game concentrates roughly a third of its losses here.');
  md.push('');

  // --- per-audit, every tier ----------------------------------------------
  md.push('#### Per-Audit kill rates, by name');
  md.push('');
  md.push('_"reached" = runs that got past round 2 of that shift. "kill rate" ='
    + ' of the runs that faced this Audit, the share it ended. This is the table the'
    + ' rebalance should be steered by: a per-shift histogram cannot show it, because'
    + ' the concentration is on the ROUND axis, not the shift axis._');
  for (const b of bots) {
    const rs = records.filter((r) => r.bot === b);
    md.push('');
    md.push(`\`${b}\``);
    md.push('');
    md.push('| shift | Audit | reached | died on it | kill rate | share of all losses |');
    md.push('|---:|---|---:|---:|---:|---:|');
    for (const a of auditStats(rs, AUDITS)) {
      md.push(`| ${a.shift} | ${a.name} (\`${a.def}\`) | ${a.attempts} | ${a.losses} | ${pct(a.killRate)} | ${pct(a.shareOfLosses)} |`);
    }
  }
  md.push('');

  // --- dominance + coverage + throughput ----------------------------------
  md.push('#### Bot integrity');
  md.push('');
  md.push(`Strict dominance (oracle ≥ planner ≥ greedy ≥ random) on ${dom.runs} shared seeds: `
    + `**${dom.ok ? 'HOLDS' : 'VIOLATED'}**`);
  md.push('');
  for (const g of dom.gaps) {
    md.push(`- \`${g.pair}\` = ${Number.isFinite(g.gap) ? (g.gap * 100).toFixed(2) : 'n/a'} pp`);
  }
  if (!dom.ok) {
    md.push('');
    md.push('**INVERSION — this is a bug in the bots, not a finding about the game:**');
    for (const i of dom.inversions) md.push(`- ${i}`);
  }
  md.push('');
  md.push('Planner search coverage, per shipment decision:');
  md.push('');
  md.push(`- ordered selections scored: median **${cov.medianEvaluated}**, min ${cov.minEvaluated}, max ${cov.maxEvaluated}`);
  md.push('- the full ordered-selection space from a hand of 8 at 1–5 parts is **8,800**;'
    + ' all 218 SUBSETS are enumerated exactly, and ordering search is bounded'
    + ' (best-insertion + swap descent) on the best few');
  md.push(`- \`previewShipment\` calls per run: median **${Math.round(cov.medianPreviews).toLocaleString('en-US')}**`);
  md.push(`- runs where a search hit its preview budget: ${cov.budgetHitRuns}`);
  md.push('');
  md.push('Throughput:');
  md.push('');
  md.push('| tier | ms/run/core | runs/s/core | wall for this sweep |');
  md.push('|---|---:|---:|---:|');
  for (const t of timing) {
    md.push(`| \`${t.bot}\` | ${t.perRun.toFixed(1)} | ${t.runsPerSecPerCore.toFixed(2)} | ${(t.wall / 1000).toFixed(1)}s |`);
  }
  md.push('');
  md.push(`Content self-measurement fed to G2.3: non-commutative machine pairs `
    + `= ${pct(nc.rate)} over ${nc.trials.toLocaleString('en-US')} trials `
    + `(${pct(nc.withSingletons)} including 1-part batches).`);
  md.push('');

  // --- the rng-fishing A/B -------------------------------------------------
  if (fishingAb > 0) {
    process.stderr.write(`[sim] rng-fishing A/B: ${fishingAb} planner runs with the bug…\n`);
    const abSeeds = seedRange(fishingAb, offset);
    const fixed = await runPool('planner', { samples }, abSeeds, workers, chunk);
    const fishy = await runPool('planner', { samples, fishing: true }, abSeeds, workers, chunk);
    const wr = (rs: HarnessRecord[]): number => rs.filter((r) => r.won).length / Math.max(1, rs.length);
    const a = wr(fixed.records);
    const b = wr(fishy.records);
    md.push('#### The rng-fishing exploit, priced');
    md.push('');
    md.push(`On the same ${fishingAb} seeds:`);
    md.push('');
    md.push('| planner | win rate |');
    md.push('|---|---:|');
    md.push(`| with the fix (expected value over independent rng streams) | ${pct(a)} |`);
    md.push(`| with the bug (evaluated on the stream \`playShipment\` will use) | ${pct(b)} |`);
    md.push(`| difference | ${((b - a) * 100).toFixed(2)} pp |`);
    md.push('');
    md.push('The bug is not "the bot gets luckier". It is that `previewShipment` is'
      + ' exact, so a searching bot reads every coin flip in the line before it'
      + ' commits and sizes its shipment to the answer. See `src/bots/ev.ts`.');
    md.push('');
  }

  const text = md.join('\n');
  if (flag('no-write')) {
    process.stdout.write(`${text}\n`);
    return;
  }
  if (!existsSync(out)) {
    writeFileSync(out, '# TAKT — benchmark results\n\n'
      + '_Appended by `src/sim/cli.ts`. Each iteration is one sweep of every tier on'
      + ' one shared seed set, scored against `docs/bench/BENCHMARK.md`._\n\n');
  }
  appendFileSync(out, `${text}\n\n---\n\n`);
  process.stderr.write(`[sim] appended to ${out}\n`);
  process.stdout.write(`GATE: ${report.gatePass ? 'PASS' : 'FAIL'}`
    + ` (${report.failing.length} failing: ${report.failing.join(', ') || 'none'})\n`);
  for (const t of tiers) {
    process.stdout.write(`  ${t.bot}: ${pct(t.winRate)} (${winCount(t)}/${t.runs})\n`);
  }
}

await main();
