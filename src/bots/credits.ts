// TAKT — how much a machine pays, discovered by probing.
//
// `previewShipment` returns the score a shipment makes and nothing else. But the
// economic archetype — thirteen machines, one of the five builds the content set
// says it supports — pays in CREDITS through `ctx.grantCredits`, which preview does
// not report. A bot that only reads `gained` therefore values every economic
// machine at exactly zero, never buys one, and the benchmark comes back saying the
// economy build does not exist. That would be an artefact of the bot, not a fact
// about the game, and G3.2/G3.3 (archetype diversity in wins) would be measuring
// the blind spot rather than the content.
//
// A human reads the rule text. The bot cannot, so it probes: apply each machine to
// a spread of synthetic batches and record what it granted. The result is a rough
// per-application expectation — it cannot know what the real batch will look like —
// but rough and present beats exact and absent.
//
// The number is used only to price PURCHASES (see planner.ts). Shipment choice is
// still scored purely on score, because a credit cannot clear a quota.

import type { Batch, MachineDef, Part, RunCtx, Tag } from '../engine/types.ts';
import { makeRng } from '../engine/rng.ts';
import { getRegistry } from '../content/registry.ts';

const TAGSETS: Tag[][] = [
  ['metal'], ['organic'], ['volatile'], ['precision'], ['scrap'], ['metal', 'precision'],
];

function batch(n: number, k: number): Batch {
  const out: Part[] = new Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = {
      id: `c${k}_${i}`,
      def: ['offcut', 'bolt', 'gear', 'pump', 'engine'][(i + k) % 5],
      value: 5 + ((i * 11 + k * 17) % 60),
      tags: TAGSETS[(i + k) % TAGSETS.length],
      mult: 1 + ((i + k) % 4) * 0.5,
    };
  }
  return out;
}

let cache: Map<string, number[]> | null = null;

/** Mean credits granted per application, indexed by level-1. Probed, then cached. */
export function creditYield(def: string, level: number): number {
  if (cache === null) {
    cache = new Map();
    for (const md of getRegistry().machines.values()) {
      cache.set(md.def, [1, 2, 3].map((l) => probe(md, l)));
    }
  }
  const row = cache.get(def);
  if (row === undefined) return 0;
  const i = Math.min(3, Math.max(1, Math.floor(level))) - 1;
  return row[i];
}

function probe(md: MachineDef, level: number): number {
  let total = 0;
  let n = 0;
  for (let k = 0; k < 6; k++) {
    for (const size of [2, 3, 5]) {
      let granted = 0;
      const ctx: RunCtx = {
        rng: makeRng(0x9e3779b1 + k * 7919 + size),
        shift: 4, round: 2, quota: 4000, score: 1200, shipmentIndex: 1,
        lineCap: 6, handSize: 8, credits: 25,
        memo: {},
        grantCredits(x: number): void { granted += x; },
      };
      try { md.apply(batch(size, k), ctx, level); } catch { granted = 0; }
      total += granted;
      n++;
    }
  }
  return n > 0 ? total / n : 0;
}

/** Expected credits one pass of this line pays. */
export function lineCreditYield(line: readonly { def: string; level: number }[]): number {
  let t = 0;
  for (const m of line) t += creditYield(m.def, m.level);
  return t;
}

export function resetCreditCache(): void {
  cache = null;
}
