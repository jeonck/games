// TAKT — blueprints. Run-long modifiers bought in the shop, one of each per run.
//
// `onRoundStart` runs once per round AND once at the moment of purchase, so every
// effect here is written to be IDEMPOTENT. Per-round fields (credits, shipmentsLeft,
// scrapsLeft, quota) are reset by the engine immediately before blueprints run, so
// `+=` on those is safe and stacks. `handSize` is NOT reset, so the blueprints that
// change it recompute it from the full owned set instead of incrementing.
//
// Every blueprint costs the same (the engine prices them flat), so these are balanced
// against each other rather than on a curve: the strong ones carry a real cost.

import type { BlueprintDef, Part, RunState } from '../engine/types.ts';
import { BASE_HAND_SIZE } from '../engine/types.ts';
import { PARTS_BY_DEF } from './parts.ts';

/** hand-size deltas, summed over owned blueprints — never applied incrementally. */
const HAND_BONUS: Record<string, number> = {
  wide_bench: 2,
  deep_stock: 3,
  just_in_time: -2,
  hoarder: 1,
  narrow_focus: -3,
};

function syncHand(s: RunState): void {
  let n = BASE_HAND_SIZE;
  for (const b of s.blueprints) n += HAND_BONUS[b.def] ?? 0;
  s.handSize = Math.max(3, Math.min(16, n));
}

function scaleQuota(s: RunState, f: number): void {
  s.quota = Math.max(1, Math.round(s.quota * f));
}

let seq = 0;
/** add a fresh part to the crate. Ids are unique within the run by construction. */
function addPart(s: RunState, def: string): void {
  const pd = PARTS_BY_DEF.get(def);
  if (pd === undefined) return;
  const p: Part = {
    id: `bp${s.shift}_${s.round}_${seq++}`,
    def: pd.def,
    value: pd.value,
    mult: pd.mult,
    tags: pd.tags,
  };
  if (pd.sticky) p.sticky = true;
  s.crate.push(p);
}

export const BLUEPRINTS: BlueprintDef[] = [
  {
    def: 'wide_bench', name: 'Wide Bench', text: '+2 hand size',
    onRoundStart: syncHand,
  },
  {
    def: 'deep_stock', name: 'Deep Stock', text: '+3 hand size, -1 shipment per round',
    onRoundStart: (s) => { syncHand(s); s.shipmentsLeft = Math.max(1, s.shipmentsLeft - 1); },
  },
  {
    def: 'just_in_time', name: 'Just In Time', text: '+2 shipments per round, -2 hand size',
    onRoundStart: (s) => { syncHand(s); s.shipmentsLeft += 2; },
  },
  {
    def: 'narrow_focus', name: 'Narrow Focus', text: '-3 hand size, -15% quota',
    onRoundStart: (s) => { syncHand(s); scaleQuota(s, 0.85); },
  },
  {
    def: 'night_shift', name: 'Night Shift', text: '+1 shipment per round',
    onRoundStart: (s) => { s.shipmentsLeft += 1; },
  },
  {
    def: 'skip_bin', name: 'Skip Bin', text: '+2 scraps per round',
    onRoundStart: (s) => { s.scrapsLeft += 2; },
  },
  {
    def: 'hoarder', name: 'Hoarder', text: '+1 hand size, +1 scrap per round',
    onRoundStart: (s) => { syncHand(s); s.scrapsLeft += 1; },
  },
  {
    def: 'retainer', name: 'Retainer', text: '+5c at the start of every round',
    onRoundStart: (s) => { s.credits += 5; },
  },
  {
    def: 'apprenticeship', name: 'Apprenticeship', text: '+2c per shift, every round',
    onRoundStart: (s) => { s.credits += 2 * s.shift; },
  },
  {
    def: 'insurance', name: 'Insurance', text: '+9c per round, +6% quota',
    onRoundStart: (s) => { s.credits += 9; scaleQuota(s, 1.06); },
  },
  {
    def: 'union_rules', name: 'Union Rules', text: '-8% quota',
    onRoundStart: (s) => { scaleQuota(s, 0.92); },
  },
  {
    def: 'overtime', name: 'Overtime', text: '+1 shipment per round, +12% quota',
    onRoundStart: (s) => { s.shipmentsLeft += 1; scaleQuota(s, 1.12); },
  },
  {
    def: 'audit_prep', name: 'Audit Prep', text: '-18% quota on Audit rounds',
    onRoundStart: (s) => { if (s.round === 3) scaleQuota(s, 0.82); },
  },
  {
    def: 'pilot_run', name: 'Pilot Run', text: '+2 shipments on the first round of a shift',
    onRoundStart: (s) => { if (s.round === 1) s.shipmentsLeft += 2; },
  },
  {
    def: 'scrap_intake', name: 'Scrap Intake', text: 'an Offcut joins your crate every round',
    onRoundStart: (s) => { addPart(s, 'offcut'); },
  },
  {
    def: 'pattern_book', name: 'Pattern Book', text: 'a Bolt joins your crate every round',
    onRoundStart: (s) => { addPart(s, 'bolt'); },
  },
];
