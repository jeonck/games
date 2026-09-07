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
    quotaMult: 1.05,
  },
  {
    // Shift 3 — aimed at Wide again, harder, and at anyone spamming duplication.
    // Answer: move a filter to the end of the line and ship 3.
    def: 'weight_limit',
    name: 'Weight Limit',
    text: 'batches of 4 or more parts score half',
    modify: (b) => (b.length >= 4 ? b.map((p) => scale(p, 0.5)) : b.map(cp)),
    allow: allowAll,
    quotaMult: 1.1,
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
    quotaMult: 1.15,
  },
  {
    // Shift 5 — aimed straight at Purity, which is the build that most wants to ignore
    // it. Answer: put the retag/promote machine LAST so the batch leaves mixed.
    def: 'monoculture',
    name: 'Monoculture Review',
    text: 'parts carrying the batch\'s most common tag score 0',
    modify: (b) => {
      const t = commonestTag(b);
      if (t === null) return b.map(cp);
      return b.map((p) => (p.tags.indexOf(t) >= 0 ? zero(p) : cp(p)));
    },
    allow: allowAll,
    quotaMult: 1.2,
  },
  {
    // Shift 6 — aimed at generative engines AND at front-loading.
    // Answer: reorder so the part you least care about ends up first.
    def: 'parts_embargo',
    name: 'Parts Embargo',
    text: 'generative machines do nothing, and the first part scores 0',
    modify: (b) => (b.length === 0 ? [] : b.map((p, i) => (i === 0 ? zero(p) : cp(p)))),
    allow: (m) => m.archetype !== 'generative',
    quotaMult: 1.25,
  },
  {
    // Shift 7 — aimed at every mult-stacking build, which by shift 7 is most of them.
    // Answer: move value machines after mult machines; a capped mult makes raw value
    // and the tier ladder the better half of the equation.
    def: 'ratio_control',
    name: 'Ratio Control',
    text: 'each part\'s mult is capped at 3',
    modify: (b) => b.map((p) => {
      if (p.mult <= 3) return cp(p);
      const q = cp(p);
      q.mult = 3;
      return q;
    }),
    allow: allowAll,
    quotaMult: 1.3,
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
    quotaMult: 1.45,
  },
];

/** unused by the engine; kept so tests can assert the ramp is monotonic */
export const AUDIT_QUOTA_RAMP: number[] = AUDITS.map((a) => a.quotaMult);
