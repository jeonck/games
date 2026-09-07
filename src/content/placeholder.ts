// TAKT — placeholder content.
//
// A deliberately tiny stub (3 machines / 3 parts / 2 blueprints / 8 audits) so the
// engine can be developed and tested standalone before the real content lands.
// The real set lives in `src/content/index.ts`; importing that installs over this.
//
// Importing this module does NOT install it — call `installPlaceholder()`.

import type { Batch, BlueprintDef, MachineDef, Part, RunCtx } from '../engine/types.ts';
import type { AuditDef, PartDef, Registry } from './registry.ts';
import { buildRegistry, setRegistry } from './registry.ts';

const clone = (p: Part): Part => ({
  id: p.id, def: p.def, value: p.value, tags: p.tags, mult: p.mult, sticky: p.sticky,
});

export const PLACEHOLDER_MACHINES: MachineDef[] = [
  {
    def: 'stub_add',
    name: 'Stub Adder',
    archetype: 'arithmetic',
    rarity: 'common',
    cost: 5,
    text: (level) => `+${2 * level} value to each part`,
    apply: (batch, _ctx, level) => {
      const out: Batch = new Array(batch.length);
      for (let i = 0; i < batch.length; i++) {
        const p = clone(batch[i]);
        p.value += 2 * level;
        out[i] = p;
      }
      return out;
    },
  },
  {
    def: 'stub_double_first',
    name: 'Stub Press',
    archetype: 'positional',
    rarity: 'common',
    cost: 6,
    text: (level) => `x${1 + level} mult on the first part`,
    apply: (batch, _ctx, level) => {
      if (batch.length === 0) return batch;
      const out: Batch = batch.slice();
      const p = clone(out[0]);
      p.mult *= 1 + level;
      out[0] = p;
      return out;
    },
  },
  {
    def: 'stub_reverse',
    name: 'Stub Reverser',
    archetype: 'positional',
    rarity: 'common',
    cost: 5,
    text: () => 'reverse the batch',
    apply: (batch) => {
      const out: Batch = new Array(batch.length);
      for (let i = 0; i < batch.length; i++) out[i] = batch[batch.length - 1 - i];
      return out;
    },
  },
];

export const PLACEHOLDER_PARTS: PartDef[] = [
  {
    def: 'stub_ingot', name: 'Stub Ingot', value: 8, mult: 1,
    tags: ['metal'], rarity: 'common', cost: 3, starterWeight: 3,
  },
  {
    def: 'stub_gasket', name: 'Stub Gasket', value: 5, mult: 1,
    tags: ['organic'], rarity: 'common', cost: 3, starterWeight: 2,
  },
  {
    def: 'stub_cell', name: 'Stub Cell', value: 3, mult: 2,
    tags: ['volatile'], rarity: 'uncommon', cost: 5, starterWeight: 1,
  },
];

export const PLACEHOLDER_BLUEPRINTS: BlueprintDef[] = [
  { def: 'stub_ledger', name: 'Stub Ledger', text: '+1 credit each round' },
  {
    def: 'stub_wide', name: 'Stub Widener', text: '+1 hand size',
    onRoundStart: (s) => { s.handSize += 0; },
  },
];

const pass = (batch: Batch, _ctx: RunCtx): Batch => batch;
const allowAll = (_m: MachineDef): boolean => true;

export const PLACEHOLDER_AUDITS: AuditDef[] = [
  { def: 'stub_audit_1', name: 'Stub Audit 1', text: 'no rule', modify: pass, allow: allowAll, quotaMult: 1 },
  { def: 'stub_audit_2', name: 'Stub Audit 2', text: 'no rule', modify: pass, allow: allowAll, quotaMult: 1.05 },
  { def: 'stub_audit_3', name: 'Stub Audit 3', text: 'no rule', modify: pass, allow: allowAll, quotaMult: 1.1 },
  {
    def: 'stub_audit_4', name: 'Stub Audit 4', text: 'batches of 4+ score half',
    modify: (batch) => {
      if (batch.length < 4) return batch;
      const out: Batch = new Array(batch.length);
      for (let i = 0; i < batch.length; i++) {
        const p = clone(batch[i]);
        p.value = p.value / 2;
        out[i] = p;
      }
      return out;
    },
    allow: allowAll,
    quotaMult: 1.15,
  },
  { def: 'stub_audit_5', name: 'Stub Audit 5', text: 'no rule', modify: pass, allow: allowAll, quotaMult: 1.2 },
  {
    def: 'stub_audit_6', name: 'Stub Audit 6', text: 'positional machines do nothing',
    modify: pass,
    allow: (m) => m.archetype !== 'positional',
    quotaMult: 1.25,
  },
  { def: 'stub_audit_7', name: 'Stub Audit 7', text: 'no rule', modify: pass, allow: allowAll, quotaMult: 1.3 },
  { def: 'stub_audit_8', name: 'Stub Audit 8', text: 'no rule', modify: pass, allow: allowAll, quotaMult: 1.35 },
];

export function placeholderRegistry(): Registry {
  return buildRegistry({
    machines: PLACEHOLDER_MACHINES,
    parts: PLACEHOLDER_PARTS,
    blueprints: PLACEHOLDER_BLUEPRINTS,
    audits: PLACEHOLDER_AUDITS,
    starterCrate: [
      ...Array(9).fill('stub_ingot'),
      ...Array(7).fill('stub_gasket'),
      ...Array(4).fill('stub_cell'),
    ],
    starterLine: ['stub_add', 'stub_double_first'],
  });
}

/** Install the stub content set. Safe to call more than once. */
export function installPlaceholder(): Registry {
  const r = placeholderRegistry();
  setRegistry(r);
  return r;
}
