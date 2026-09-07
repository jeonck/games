// TAKT — content registry interface.
//
// OWNERSHIP: this file is owned by the Gameplay Engineer and is a CONTRACT.
// The content agent fills `machines.ts` / `parts.ts` / `blueprints.ts` /
// `audits.ts` and wires them up in `index.ts`; it does not change this file.
//
// How content installs itself (do this at the bottom of `src/content/index.ts`):
//
//   import { setRegistry, buildRegistry } from './registry.ts';
//   import { MACHINES } from './machines.ts';
//   import { PARTS } from './parts.ts';
//   import { BLUEPRINTS } from './blueprints.ts';
//   import { AUDITS } from './audits.ts';
//
//   setRegistry(buildRegistry({
//     machines: MACHINES,       // MachineDef[]
//     parts: PARTS,             // PartDef[]
//     blueprints: BLUEPRINTS,   // BlueprintDef[]
//     audits: AUDITS,           // AuditDef[], exactly 8, index 0 = shift 1
//     starterCrate: [...],      // optional: string[] of part defs, the run's opening deck
//     starterLine: [...],       // optional: string[] of machine defs the run opens with
//   }));
//   export { getRegistry } from './registry.ts';
//
// The engine only ever calls `getRegistry()`. `src/content/placeholder.ts` installs a
// tiny stub so the engine can be tested before the real content lands.

import type {
  Batch, BlueprintDef, MachineDef, Rarity, RunCtx, Tag,
} from '../engine/types.ts';

/** A part *template*. The engine instantiates these into `Part` objects with unique ids. */
export interface PartDef {
  def: string;
  name: string;
  /** base value, integer >= 0 */
  value: number;
  /** per-part multiplier, default 1 */
  mult: number;
  tags: Tag[];
  rarity: Rarity;
  /** shop price */
  cost: number;
  /** returns to hand instead of the discard after a shipment */
  sticky?: boolean;
  /**
   * Relative weight when the engine has to compose a starter crate itself
   * (i.e. `Registry.starterCrate` was not supplied). 0 = never a starter part.
   * Default 1.
   */
  starterWeight?: number;
}

/**
 * A shift boss. Exactly 8 of these exist; `audits[shift - 1]` is in force during
 * round 3 (the Audit round) of that shift.
 *
 * The three levers, all of which must be answerable by reordering the line:
 *  - `modify`   — rewrite the batch that leaves the last machine, before it is scored.
 *                 This is how "batches of 4+ score half" or "volatile parts score 0" work.
 *                 MUST be pure: do not mutate `batch` or any Part in it; return a new array.
 *  - `allow`    — return false to disable a machine for the round (it becomes a no-op
 *                 pass-through, it is not removed from the line). This is how
 *                 "positional machines do nothing" works.
 *  - `quotaMult` — multiplies the round quota. 1 = no change.
 */
export interface AuditDef {
  def: string;
  name: string;
  /** terse player-facing rule text */
  text: string;
  modify(batch: Batch, ctx: RunCtx): Batch;
  allow(machineDef: MachineDef): boolean;
  quotaMult: number;
}

export interface Registry {
  machines: Map<string, MachineDef>;
  parts: Map<string, PartDef>;
  blueprints: Map<string, BlueprintDef>;
  /** length 8, indexed by shift-1 */
  audits: AuditDef[];
  /**
   * Optional opening deck, as part defs (repeats allowed). When absent the engine
   * builds a starter crate from `parts` using `starterWeight` / rarity.
   */
  starterCrate?: string[];
  /**
   * Optional opening line, as machine defs. When absent the engine picks common
   * machines deterministically from the run seed.
   */
  starterLine?: string[];
}

export interface RegistrySource {
  machines: readonly MachineDef[] | Map<string, MachineDef>;
  parts: readonly PartDef[] | Map<string, PartDef>;
  blueprints: readonly BlueprintDef[] | Map<string, BlueprintDef>;
  audits: readonly AuditDef[];
  starterCrate?: readonly string[];
  starterLine?: readonly string[];
}

function toMap<T extends { def: string }>(
  xs: readonly T[] | Map<string, T>, what: string,
): Map<string, T> {
  if (xs instanceof Map) return xs;
  const m = new Map<string, T>();
  for (const x of xs) {
    if (m.has(x.def)) throw new Error(`duplicate ${what} def: ${x.def}`);
    m.set(x.def, x);
  }
  return m;
}

/** Build a `Registry` from plain arrays, checking the invariants the engine relies on. */
export function buildRegistry(src: RegistrySource): Registry {
  const machines = toMap(src.machines, 'machine');
  const parts = toMap(src.parts, 'part');
  const blueprints = toMap(src.blueprints, 'blueprint');
  if (machines.size === 0) throw new Error('registry: no machines');
  if (parts.size === 0) throw new Error('registry: no parts');
  const audits = src.audits.slice();
  if (audits.length !== 8) {
    throw new Error(`registry: audits must have length 8, got ${audits.length}`);
  }
  const seen = new Set<string>();
  for (const a of audits) {
    if (seen.has(a.def)) throw new Error(`duplicate audit def: ${a.def}`);
    seen.add(a.def);
    if (!(a.quotaMult > 0)) throw new Error(`audit ${a.def}: quotaMult must be > 0`);
  }
  const reg: Registry = { machines, parts, blueprints, audits };
  if (src.starterCrate) {
    reg.starterCrate = src.starterCrate.slice();
    for (const d of reg.starterCrate) {
      if (!parts.has(d)) throw new Error(`starterCrate references unknown part: ${d}`);
    }
  }
  if (src.starterLine) {
    reg.starterLine = src.starterLine.slice();
    for (const d of reg.starterLine) {
      if (!machines.has(d)) throw new Error(`starterLine references unknown machine: ${d}`);
    }
  }
  return reg;
}

let active: Registry | null = null;

/** Install the content set. Called once, at content-module load time. */
export function setRegistry(r: Registry): void {
  active = r;
}

/** True once some content set (real or placeholder) has been installed. */
export function hasRegistry(): boolean {
  return active !== null;
}

/** The installed content set. Throws if nothing has been installed yet. */
export function getRegistry(): Registry {
  if (active === null) {
    throw new Error(
      'no content registry installed — import src/content/index.ts (real content) ' +
      'or src/content/placeholder.ts (stub) before using the engine',
    );
  }
  return active;
}
