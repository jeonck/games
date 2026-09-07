// TAKT — the run loop. One place where a run is played, shared by all four tiers.
//
// The bots decide; this file executes. Nothing here knows which tier it is driving,
// which is the only way the win-rate ladder stays a comparison between POLICIES
// rather than between four subtly different harnesses.
//
// ---------------------------------------------------------------------------
// ONE POLICY DECISION LIVES HERE, AND IT IS LOAD-BEARING: shipments after clear
// ---------------------------------------------------------------------------
// The engine pays the round reward the instant the quota is first met, computed
// from `shipmentsLeft` at that moment, and score does not carry across rounds. So
// once a round is cleared, every remaining shipment is FREE: it cannot lose credits
// it has already banked, it cannot lower the score (gained is floored at 0) and it
// cannot end the run. Playing them out is therefore strictly non-negative, and a
// bot that stopped would be leaving G5's tail on the table for no reason a player
// could name. All four tiers play every shipment.
//
// The honest consequence is reported rather than buried: it means G5.1/G5.2 (the
// "broken run" tail) are measured on runs that dump their remaining shipments into
// an already-cleared round, and that behaviour is free rather than earned. See the
// report.

import type { Machine, RunState } from '../engine/types.ts';
import { ROUNDS_PER_SHIFT, SHIFTS_PER_RUN } from '../engine/types.ts';
import type { Shop } from '../engine/api.ts';
import {
  buy, newRun, nextRound, playShipment, reorderLine, reroll, rollShop, scrapParts,
} from '../engine/run.ts';
import { getRegistry } from '../content/registry.ts';
import type { Archetype } from '../engine/types.ts';
import type { BotName, RunRecord } from './telemetry.ts';
import type { Bot } from '../bots/types.ts';

// ---------------------------------------------------------------------------
// DECISION-TIME MODEL (G7.2)
// ---------------------------------------------------------------------------
// The spec's model, used verbatim: 4s to pick and order a shipment, 8s for a shop
// decision, 2s for a scrap. Two extensions, both stated because they move G7.2:
//   - each SHOP VISIT costs one 8s beat on top of the purchases made in it (you
//     read the five items before you buy any of them);
//   - each ROUND-START REORDER costs one 8s beat (it is a structural decision, and
//     it is the decision the whole game is about; charging it 0 would be absurd),
//     and each mid-round line NUDGE costs a 4s beat, the same as a shipment.
// Nothing else is charged. Reading the hand between shipments, the audit text, the
// menus — all free. The model is therefore a LOWER BOUND on real session length.
export const SECONDS_PER_SHIPMENT = 4;
export const SECONDS_PER_SHOP_DECISION = 8;
export const SECONDS_PER_SCRAP = 2;

/** Extra measurements RunRecord (frozen) has no field for. metrics.ts ignores them. */
export interface HarnessRecord extends RunRecord {
  /** ordered selections scored per shipment decision, within this run */
  evalP50: number;
  evalMin: number;
  evalMax: number;
  shipmentDecisions: number;
  /** previewShipment calls made by the bot over the whole run */
  previews: number;
  /** decisions in which a search stopped on its preview budget */
  budgetHits: number;
  /**
   * G2.4 needs the shift boundaries picked out of the same transition list G2.2
   * reads. Rather than making the reader infer them from array position, each
   * transition says whether it crosses a shift.
   */
  optOrderShiftBoundary: boolean[];
  /**
   * Companion to `optOrderChanged`. `optOrderChanged` compares the RELATIVE order
   * of the machines the line kept (the thing A1's "does my structure still hold"
   * argument is about); this one compares the full def sequence, so a round where
   * the only change is a newly bought machine counts as changed. Both are
   * reported; neither is quietly chosen for the reader.
   */
  optOrderChangedStrict: boolean[];
  /** G6.1 companion: margin against the best DIFFERENT-SUBSET shipment. */
  decisionMarginSubsetPct: number[];
  wallMs: number;
}

export interface RunOptions {
  /** called after every shipment decision, for the coverage experiment */
  onShipment?: (s: RunState, evaluated: number, marginPct: number) => void;
}

function relativeOrderChanged(prev: string[], cur: string[]): boolean {
  const inCur = new Set(cur);
  const inPrev = new Set(prev);
  const a = prev.filter((d) => inCur.has(d));
  const b = cur.filter((d) => inPrev.has(d));
  if (a.length < 2) return false;
  return a.join('|') !== b.join('|');
}

function medianOf(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = xs.slice().sort((a, b) => a - b);
  const n = s.length;
  return n % 2 === 1 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

/** Play one run to completion and produce its record. */
export function runOne(bot: Bot, seed: number, opts: RunOptions = {}): HarnessRecord {
  const t0 = performance.now();
  const reg = getRegistry();
  const s = newRun(seed);
  bot.startRun(s, seed);
  if (bot.ev !== null) { bot.ev.previews = 0; bot.ev.evaluations = 0; bot.ev.budgetHits = 0; }

  const arrivalIds: string[] = s.line.map((m) => m.id);
  const evalCounts: number[] = [];
  const margins: number[] = [];
  const subsetMargins: number[] = [];
  const gains: number[] = [];
  const optChanged: boolean[] = [];
  const optStrict: boolean[] = [];
  const optBoundary: boolean[] = [];
  let prevKey: string[] | null = null;

  let shipments = 0;
  let scraps = 0;
  let shopVisits = 0;
  let shopActions = 0;
  let refinements = 0;

  while (!s.over) {
    // --- reorder, at the START of the round -------------------------------
    //
    // NOT at the shop, which is where an earlier version of this loop had it and
    // where it was quietly wrong: at the shop the engine is still in the round
    // that just finished, so `previewShipment` scores against THAT round's rules.
    // A line reordered at the shop before an Audit round is therefore optimised
    // for a round whose audit is not in force — and every run in this game dies on
    // an Audit round. Reordering here, after `nextRound`, the bot sees the audit
    // and the hand it will actually face, which is also what "this round's optimal
    // ordering" has to mean for G2.2 and G2.4 to be about anything.
    for (const m of s.line) if (arrivalIds.indexOf(m.id) < 0) arrivalIds.push(m.id);
    const arrival: Machine[] = [];
    for (const id of arrivalIds) {
      const m = s.line.find((x) => x.id === id);
      if (m !== undefined) arrival.push(m);
    }
    const ro = bot.chooseReorder(s, arrival);
    if (ro !== null) {
      if (Number.isFinite(ro.gainPct)) gains.push(ro.gainPct);
      if (prevKey !== null) {
        optChanged.push(relativeOrderChanged(prevKey, ro.key));
        optStrict.push(prevKey.join('|') !== ro.key.join('|'));
        optBoundary.push(s.round === 1);
      }
      prevKey = ro.key;
      reorderLine(s, ro.perm);
      shopActions++;
    } else if (prevKey !== null) {
      // Still a transition: a round in which no ordering was measurable is a round
      // in which the ordering did not change. Dropping the entry would reweight the
      // G2.2 rate over the rounds that happened to be measurable.
      optChanged.push(false);
      optStrict.push(false);
      optBoundary.push(s.round === 1);
    }

    // --- the round -------------------------------------------------------
    while (!s.over && s.shipmentsLeft > 0 && s.hand.length > 0) {
      for (let guard = 0; guard < 8 && s.scrapsLeft > 0; guard++) {
        const sc = bot.chooseScrap(s);
        if (sc === null || sc.length === 0) break;
        const before = s.scrapsLeft;
        // scrapParts is a silent no-op when the ask is degenerate; if the scrap
        // count did not move, the bot is asking for something the engine will not
        // do and looping would spin the harness.
        scrapParts(s, sc);
        if (s.scrapsLeft >= before) break;
        scraps++;
      }
      const refine = bot.refineLine(s);
      if (refine !== null) {
        reorderLine(s, refine);
        refinements++;
      }
      const d = bot.chooseShipment(s);
      if (d.indices.length === 0) break;
      playShipment(s, d.indices);
      shipments++;
      evalCounts.push(d.evaluated);
      if (Number.isFinite(d.marginPct)) margins.push(d.marginPct);
      if (Number.isFinite(d.subsetMarginPct)) subsetMargins.push(d.subsetMarginPct);
      if (opts.onShipment !== undefined) opts.onShipment(s, d.evaluated, d.marginPct);
    }
    if (s.over) break;

    // --- the shop --------------------------------------------------------
    const isLastRound = s.shift >= SHIFTS_PER_RUN && s.round >= ROUNDS_PER_SHIFT;
    if (!isLastRound) {
      let shop: Shop = rollShop(s);
      shopVisits++;
      let fails = 0;
      for (let guard = 0; guard < 16; guard++) {
        const a = bot.chooseShop(s, shop);
        if (a.kind === 'done') break;
        if (a.kind === 'reroll') {
          const next = reroll(s, shop);
          if (next === shop) break;
          shop = next;
          shopActions++;
          continue;
        }
        if (buy(s, shop, a.index)) shopActions++;
        else if (++fails >= 3) break;
      }
    }

    nextRound(s);
  }

  const machines = s.line.map((m) => m.def);
  const archetypes: Archetype[] = [];
  for (const def of machines) {
    const md = reg.machines.get(def);
    if (md !== undefined) archetypes.push(md.archetype);
  }

  const estSeconds =
    SECONDS_PER_SHIPMENT * shipments
    + SECONDS_PER_SCRAP * scraps
    + SECONDS_PER_SHOP_DECISION * (shopVisits + shopActions)
    + SECONDS_PER_SHIPMENT * refinements;

  return {
    bot: bot.name as BotName,
    seed,
    won: s.won === true,
    endShift: s.shift,
    endRound: s.round,
    decisions: s.decisions,
    estSeconds,
    machines,
    archetypes,
    finalScore: s.score,
    finalQuota: s.quota,
    reorderGainPct: gains,
    optOrderChanged: optChanged,
    decisionMarginPct: margins,
    evalP50: medianOf(evalCounts),
    evalMin: evalCounts.length > 0 ? Math.min(...evalCounts) : 0,
    evalMax: evalCounts.length > 0 ? Math.max(...evalCounts) : 0,
    shipmentDecisions: shipments,
    previews: bot.ev !== null ? bot.ev.previews : 0,
    budgetHits: bot.ev !== null ? bot.ev.budgetHits : 0,
    optOrderShiftBoundary: optBoundary,
    optOrderChangedStrict: optStrict,
    decisionMarginSubsetPct: subsetMargins,
    wallMs: performance.now() - t0,
  };
}

/** Play `seeds` with a freshly constructed bot and return one record per seed. */
export function runSeeds(
  make: () => Bot, seeds: number[], opts: RunOptions = {},
): HarnessRecord[] {
  const bot = make();
  const out: HarnessRecord[] = new Array(seeds.length);
  for (let i = 0; i < seeds.length; i++) out[i] = runOne(bot, seeds[i], opts);
  return out;
}

/** The canonical seed set: deterministic, dense, and identical for every tier. */
export function seedRange(count: number, offset = 0): number[] {
  const out: number[] = new Array(count);
  for (let i = 0; i < count; i++) out[i] = (1 + offset + i) >>> 0;
  return out;
}
