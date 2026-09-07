// TAKT — part content.
//
// A part is an OBJECT, not a labelled number. The emotion this game sells is
// alchemy: a rusted offcut goes in the left and a monument comes out the right.
// That is why `Part.def` matters as much as `Part.value` — the def is the thing
// the player sees on the belt, and transmutation machines rewrite it.
//
// THE TIER LADDER is the spine of that fantasy:
//
//     Offcut -> Bolt -> Gear -> Pump -> Engine -> Reactor -> Monument
//
// Promotion machines (`foundry`, `kiln`, `assembly_line`, ...) walk a part UP this
// ladder, rewriting def, tags and value together. Corruption machines knock it back
// down to Offcut and pay you in mult for the vandalism. Off-ladder parts (a Fish, a
// Cursed Doll) enter the ladder at the rung matching their value, so every part in
// the game can be promoted.
//
// Each tier changes TAG as well as value, which is deliberate: promoting a part is
// how a Purity build breaks its own purity. Growth has a cost.

import type { Tag } from '../engine/types.ts';
import type { PartDef } from './registry.ts';

export interface TierStep {
  def: string;
  name: string;
  value: number;
  tags: Tag[];
}

/** index 0 is the bottom of the ladder. Machines promote along this. */
export const TIER_LADDER: TierStep[] = [
  { def: 'offcut', name: 'Offcut', value: 3, tags: ['scrap'] },
  { def: 'bolt', name: 'Bolt', value: 9, tags: ['metal'] },
  { def: 'gear', name: 'Gear', value: 21, tags: ['precision'] },
  { def: 'pump', name: 'Pump', value: 46, tags: ['metal'] },
  { def: 'engine', name: 'Engine', value: 98, tags: ['organic'] },
  { def: 'reactor', name: 'Reactor', value: 215, tags: ['volatile'] },
  { def: 'monument', name: 'Monument', value: 470, tags: ['precision'] },
];

/** def -> rung. Off-ladder parts are placed by value at promotion time. */
export const TIER_INDEX: Map<string, number> = new Map(TIER_LADDER.map((t, i) => [t.def, i]));

export const PARTS: PartDef[] = [
  // --- the ladder ----------------------------------------------------------
  // Cheap to buy at the bottom, absurd at the top. You are meant to *make* the top
  // three, not buy them; the shop prices reflect that.
  { def: 'offcut', name: 'Offcut', value: 3, mult: 1, tags: ['scrap'], rarity: 'common', cost: 2, starterWeight: 2 },
  { def: 'bolt', name: 'Bolt', value: 9, mult: 1, tags: ['metal'], rarity: 'common', cost: 4, starterWeight: 4 },
  { def: 'gear', name: 'Gear', value: 21, mult: 1, tags: ['precision'], rarity: 'common', cost: 7, starterWeight: 2 },
  { def: 'pump', name: 'Pump', value: 46, mult: 1, tags: ['metal'], rarity: 'uncommon', cost: 13, starterWeight: 0 },
  { def: 'engine', name: 'Engine', value: 98, mult: 1, tags: ['organic'], rarity: 'rare', cost: 26, starterWeight: 0 },
  { def: 'reactor', name: 'Reactor', value: 215, mult: 1, tags: ['volatile'], rarity: 'rare', cost: 52, starterWeight: 0 },
  { def: 'monument', name: 'Monument', value: 470, mult: 1, tags: ['precision'], rarity: 'legendary', cost: 110, starterWeight: 0 },

  // --- metal: heavy, cheap, reliable ---------------------------------------
  { def: 'rivet', name: 'Rivet', value: 6, mult: 1, tags: ['metal'], rarity: 'common', cost: 3, starterWeight: 5 },
  { def: 'ingot', name: 'Ingot', value: 16, mult: 1, tags: ['metal'], rarity: 'common', cost: 6, starterWeight: 2 },
  { def: 'anvil', name: 'Anvil', value: 34, mult: 1, tags: ['metal'], rarity: 'uncommon', cost: 11, starterWeight: 0 },

  // --- precision: low value, high mult, wants friends -----------------------
  { def: 'lens', name: 'Lens', value: 12, mult: 1.5, tags: ['precision'], rarity: 'common', cost: 6, starterWeight: 2 },
  { def: 'micrometer', name: 'Micrometer', value: 8, mult: 2, tags: ['precision'], rarity: 'uncommon', cost: 9, starterWeight: 1 },
  { def: 'governor', name: 'Governor', value: 26, mult: 1.5, tags: ['precision'], rarity: 'uncommon', cost: 14, starterWeight: 0 },

  // --- volatile: swingy, multiplies, spawns ---------------------------------
  { def: 'cell', name: 'Cell', value: 7, mult: 2, tags: ['volatile'], rarity: 'common', cost: 5, starterWeight: 3 },
  { def: 'fuse_wire', name: 'Fuse Wire', value: 4, mult: 3, tags: ['volatile'], rarity: 'uncommon', cost: 8, starterWeight: 1 },
  { def: 'flask', name: 'Flask', value: 19, mult: 1.5, tags: ['volatile'], rarity: 'uncommon', cost: 10, starterWeight: 1 },
  { def: 'plasma_can', name: 'Plasma Can', value: 33, mult: 2, tags: ['volatile'], rarity: 'rare', cost: 22, starterWeight: 0 },

  // --- organic: fat base value, no mult -------------------------------------
  { def: 'gasket', name: 'Gasket', value: 11, mult: 1, tags: ['organic'], rarity: 'common', cost: 4, starterWeight: 4 },
  { def: 'hide', name: 'Hide', value: 17, mult: 1, tags: ['organic'], rarity: 'common', cost: 6, starterWeight: 2 },
  { def: 'fish', name: 'Fish', value: 24, mult: 1, tags: ['organic'], rarity: 'uncommon', cost: 9, starterWeight: 1 },
  { def: 'heartwood', name: 'Heartwood', value: 42, mult: 1.2, tags: ['organic'], rarity: 'rare', cost: 20, starterWeight: 0 },

  // --- scrap: worthless alone, the raw material of every promotion ----------
  { def: 'dust', name: 'Dust', value: 2, mult: 1, tags: ['scrap'], rarity: 'common', cost: 1, starterWeight: 2 },
  { def: 'swarf', name: 'Swarf', value: 5, mult: 2, tags: ['scrap'], rarity: 'common', cost: 4, starterWeight: 2 },
  { def: 'slag', name: 'Slag', value: 9, mult: 1.5, tags: ['scrap'], rarity: 'common', cost: 5, starterWeight: 1 },
  // it keeps coming back. That is the joke, and it is also a genuinely strong part
  // once you own a machine that pays for scrap.
  { def: 'cursed_doll', name: 'Cursed Doll', value: 14, mult: 1.5, tags: ['scrap'], rarity: 'rare', cost: 18, sticky: true, starterWeight: 0 },
];

export const PARTS_BY_DEF: Map<string, PartDef> = new Map(PARTS.map((p) => [p.def, p]));

/** The opening crate: 20 parts, deliberately junk. You build the good stuff. */
export const STARTER_CRATE: string[] = [
  'rivet', 'rivet', 'rivet', 'rivet', 'rivet',
  'bolt', 'bolt', 'bolt', 'bolt',
  'gasket', 'gasket', 'gasket',
  'offcut', 'offcut',
  'dust', 'swarf',
  'cell', 'cell',
  'lens', 'gear',
];
