// TAKT — shop legality, shared by every tier.
//
// `buy()` returns false rather than throwing when a purchase is illegal (line
// full, duplicate machine, maxed upgrade). A bot that offers illegal buys would
// spin the harness's shop loop, and — worse — a "random affordable buy" that is
// really a "random buy that mostly fails" would quietly make the random tier
// weaker than the policy it is supposed to represent. So legality is computed
// here, once, and every tier picks from the same filtered list.

import type { RunState } from '../engine/types.ts';
import { MAX_LINE_CAP } from '../engine/types.ts';
import type { Shop, ShopItem } from '../engine/api.ts';
import { MAX_MACHINE_LEVEL } from '../engine/run.ts';

/** True when `buy(s, shop, i)` would succeed. */
export function canBuy(s: RunState, item: ShopItem): boolean {
  if (s.over) return false;
  if (!(s.credits >= item.cost)) return false;
  switch (item.kind) {
    case 'machine':
      if (s.line.length >= s.lineCap) return false;
      for (const m of s.line) if (m.def === item.def) return false;
      return true;
    case 'blueprint':
      for (const b of s.blueprints) if (b.def === item.def) return false;
      return true;
    case 'lineslot':
      return s.lineCap < MAX_LINE_CAP;
    case 'upgrade': {
      const i = s.line.findIndex((m) => m.def === item.def);
      return i >= 0 && s.line[i].level < MAX_MACHINE_LEVEL;
    }
    case 'part':
      return true;
    default:
      return false;
  }
}

/** Indices into `shop.items` of every purchase that would actually go through. */
export function affordable(s: RunState, shop: Shop): number[] {
  const out: number[] = [];
  for (let i = 0; i < shop.items.length; i++) if (canBuy(s, shop.items[i])) out.push(i);
  return out;
}
