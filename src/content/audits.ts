// TAKT — the eight Audits (shift bosses). `audits[shift - 1]` is in force during
// round 3 of that shift.
//
// Design rule for every one of these: it must invalidate a strategy and be ANSWERABLE
// BY REORDERING, not merely survived. `modify` rewrites the batch as it leaves the
// last machine, so the answer is always "make the batch come out of the line in a
// different shape" — which is what moving machines does. Each entry names, in a
// comment, the build it is aimed at and the reorder that beats it.
//
// The ramp: shift 1 costs you a little, shift 8 rewrites what scoring means.
//
// REBALANCE (first measured pass). The first bot benchmark found 99% of every
// planner and oracle loss landing on an Audit round: the Audits were not bosses,
// they were the game's entire difficulty curve. The cause was that each Audit did
// two jobs at once — a rule AND a quota multiplier — on top of a round quota that
// was already 2.4x round 1, and two of the rules (Monoculture, Ratio Control) were
// not answer-changers at all but flat score divisors that no reordering could undo.
//
// So the multipliers are given back almost entirely (the ramp now lives in the
// quota curve in run.ts, which carries it across the whole shift instead of dumping
// it on round 3), and the two unanswerable rules were rewritten so that the answer
// they demand is actually reachable from a normal hand. What each Audit keeps is
// its RULE: the thing that makes this round's right answer different from last
// round's. That is the boss. The number is not.

import type { Batch, MachineDef, Part, Tag } from '../engine/types.ts';
import type { AuditDef } from './registry.ts';

const cp = (p: Part): Part => {
  const q: Part = { id: p.id, def: p.def, value: p.value, tags: p.tags, mult: p.mult };
  if (p.sticky) q.sticky = true;
  return q;
};

const zero = (p: Part): Part => { const q = cp(p); q.value = 0; return q; };
const scale = (p: Part, f: number): Part => {
  const q = cp(p);
  q.value = Math.max(0, Math.floor(p.value * f));
  return q;
};

const allowAll = (_m: MachineDef): boolean => true;

function commonestTag(b: Batch): Tag | null {
  const n = new Map<Tag, number>();
  for (const p of b) for (const t of p.tags) n.set(t, (n.get(t) ?? 0) + 1);
  let best: Tag | null = null;
  let bestN = 0;
  for (const [t, k] of n) if (k > bestN) { bestN = k; best = t; }
  return bestN > 0 ? best : null;
}

export const AUDITS: AuditDef[] = [
  {
    // Shift 1 — gentle. Aimed at nothing in particular; teaches that the ORDER the
    // batch comes out in is a thing the game looks at.
    // Answer: end the line with a machine that puts your junk last.
    def: 'spot_check',
    name: 'Spot Check',
    text: 'the last part in the batch scores 0',
    modify: (b) => (b.length === 0 ? [] : b.map((p, i) => (i === b.length - 1 ? zero(p) : cp(p)))),
    allow: allowAll,
    quotaMult: 1,
  },
  {
    // Shift 2 — aimed at Wide (many small parts).
    // Answer: run your adders and promoters AFTER your spawners, not before.
    def: 'tolerance_check',
    name: 'Tolerance Check',
    text: 'parts worth under 25 score 0',
    modify: (b) => b.map((p) => (p.value < 25 ? zero(p) : cp(p))),
    allow: allowAll,
    quotaMult: 1,
  },
  {
    // Shift 3 — aimed at Wide again, harder, and at anyone spamming duplication.
    // Answer: move a filter to the end of the line and ship 3.
    def: 'weight_limit',
    name: 'Weight Limit',
    text: 'batches of 4 or more parts score half',
    modify: (b) => (b.length >= 4 ? b.map((p) => scale(p, 0.5)) : b.map(cp)),
    allow: allowAll,
    quotaMult: 1,
  },
  {
    // Shift 4 — aimed squarely at Sorting.
    // Answer: the positional machines are pass-throughs this round, so the machines
    // either side of them are now adjacent — reorder around the dead slots.
    def: 'line_freeze',
    name: 'Line Freeze',
    text: 'positional machines do nothing this round',
    modify: (b) => b.map(cp),
    allow: (m) => m.archetype !== 'positional',
    quotaMult: 1,
  },
  {
    // Shift 5 — aimed straight at Purity, which is the build that most wants to ignore
    // it. Answer: put the retag/promote machine LAST so the batch leaves mixed.
    //
    // REBALANCED. It used to zero every part carrying the commonest tag, whatever
    // the count — and since every part in the game carries exactly one tag, a
    // five-part batch of five different tags STILL lost a part, and any batch built
    // out of one ladder rung lost everything. It had no OFF state: across every
    // shipment the oracle's search evaluated, the median one came out of it with 27%
    // of the score it went in with, and there was frequently no candidate that did
    // better. It killed a third of every planner and oracle run that reached shift 5.
    // Now it only bites a tag that is an outright MAJORITY of the batch, which gives
    // it an off state a normal hand can actually reach: "no more than half of one
    // kind" is a statable answer at any batch size, and the zero — the drama — is
    // untouched for anyone who does not find it. Measured kill rate: 33% -> 7%.
    def: 'monoculture',
    name: 'Monoculture Review',
    text: 'if over half the batch shares a tag, those parts score 0',
    modify: (b) => {
      const t = commonestTag(b);
      if (t === null) return b.map(cp);
      let n = 0;
      for (const p of b) if (p.tags.indexOf(t) >= 0) n++;
      if (n * 2 <= b.length) return b.map(cp);
      return b.map((p) => (p.tags.indexOf(t) >= 0 ? zero(p) : cp(p)));
    },
    allow: allowAll,
    quotaMult: 1,
  },
  {
    // Shift 6 — aimed at generative engines AND at front-loading.
    // Answer: reorder so the part you least care about ends up first.
    def: 'parts_embargo',
    name: 'Parts Embargo',
    text: 'generative machines do nothing, and the first part scores 0',
    modify: (b) => (b.length === 0 ? [] : b.map((p, i) => (i === 0 ? zero(p) : cp(p)))),
    allow: (m) => m.archetype !== 'generative',
    quotaMult: 1.05,
  },
  {
    // Shift 7 — aimed at every mult-stacking build, which by shift 7 is most of them.
    // Answer: move value machines after mult machines; a capped mult makes raw value
    // and the tier ladder the better half of the equation.
    //
    // REBALANCED. It was a HARD cap at 3, and by shift 7 a mult-stacking line runs at
    // 20-40x — so the cap was a division by ten or more that no ordering could
    // recover, and it was measured killing 54% of every oracle run that reached it
    // and 47% of every planner run — the single deadliest thing in the game, and the
    // one round in the game the oracle's median run never cleared at all. It is now
    // a SOFT cap at the same
    // threshold: mult past 3 still counts, at half rate. The pressure is identical
    // in direction (stop stacking mult, start stacking value and the tier ladder)
    // and the threshold the player reads is the same number it always was; what is
    // gone is the cliff behind it, which was a divisor and not a decision.
    def: 'ratio_control',
    name: 'Ratio Control',
    text: 'mult above 3 counts for half',
    modify: (b) => b.map((p) => {
      if (p.mult <= 3) return cp(p);
      const q = cp(p);
      q.mult = 3 + (p.mult - 3) / 2;
      return q;
    }),
    allow: allowAll,
    quotaMult: 1.05,
  },
  {
    // Shift 8 — brutal, and the exact inverse of shift 3: Wide is dead, Tall is the
    // only answer, and filters are switched off so you cannot simply cut the batch
    // down. Answer: reorder to concentrate everything into one object — this is the
    // round the tier ladder was built for.
    def: 'final_inspection',
    name: 'Final Inspection',
    text: 'only the highest-value part scores. Filter machines do nothing',
    modify: (b) => {
      if (b.length === 0) return [];
      let k = 0;
      for (let i = 1; i < b.length; i++) if (b[i].value > b[k].value) k = i;
      return b.map((p, i) => (i === k ? cp(p) : zero(p)));
    },
    allow: (m) => m.archetype !== 'filter',
    quotaMult: 1.1,
  },
];

/** unused by the engine; kept so tests can assert the ramp is monotonic */
export const AUDIT_QUOTA_RAMP: number[] = AUDITS.map((a) => a.quotaMult);
