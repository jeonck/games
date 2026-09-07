// TAKT — deep-copying a run so a bot can play it forward in its head.
//
// The oracle's beam search and the planner's one-ply shop lookahead both need to
// ask "what does the next round look like if I buy this?", which means actually
// advancing a copy of the run through `nextRound` and `playShipment`.
//
// TWO THINGS ARE DELIBERATE HERE.
//
// 1. THE ROLLOUT GETS A DIFFERENT SEED. `RunState.rng` is a closure with no
//    readable internal state, so a copy cannot continue the real stream even if we
//    wanted it to. We do not want to. A lookahead run on the real seed would deal
//    the real next hand and resolve the real coin flips — the bot would be
//    planning with knowledge of the future, and `oracle`'s win rate would measure
//    clairvoyance rather than skill. Every rollout therefore runs on an
//    independent seed, i.e. the bot plans under the same uncertainty a player
//    faces. This is the same principle as the rng-fishing fix in `ev.ts`, applied
//    one level up.
//
// 2. THE COPY IS DEEP DOWN TO PARTS. `playShipment` splices `hand`, pushes to
//    `discard` and (through blueprints) appends to `crate`; machines never mutate
//    parts, but blueprints and the engine own them. Sharing a Part between the
//    real run and a rollout would be a silent corruption of the benchmark, so
//    parts are copied.
//
// The engine's per-run side table (score-reward flag, id counter) is rebuilt from
// the copied state by the engine itself on first touch; `rewarded` re-derives as
// `score >= quota`, which is correct at every point a bot clones (shop time, after
// the quota is met and the reward has been paid).

import type { Blueprint, Machine, Part, RunState } from '../engine/types.ts';
import { makeRng } from '../engine/rng.ts';
import { runMemo } from '../engine/run.ts';

function copyPart(p: Part): Part {
  const q: Part = { id: p.id, def: p.def, value: p.value, tags: p.tags.slice(), mult: p.mult };
  if (p.sticky === true) q.sticky = true;
  return q;
}

function copyParts(xs: Part[]): Part[] {
  const out: Part[] = new Array(xs.length);
  for (let i = 0; i < xs.length; i++) out[i] = copyPart(xs[i]);
  return out;
}

/**
 * A playable copy of `s` running on `seed`. Mutating the copy — shipping, buying,
 * advancing rounds — cannot touch `s`.
 */
export function cloneRun(s: RunState, seed: number): RunState {
  const c: RunState = {
    seed: seed >>> 0,
    rng: makeRng(seed >>> 0),
    shift: s.shift,
    round: s.round,
    quota: s.quota,
    score: s.score,
    shipmentsLeft: s.shipmentsLeft,
    scrapsLeft: s.scrapsLeft,
    credits: s.credits,
    line: s.line.map((m: Machine) => ({ id: m.id, def: m.def, level: m.level })),
    lineCap: s.lineCap,
    crate: copyParts(s.crate),
    drawPile: copyParts(s.drawPile),
    hand: copyParts(s.hand),
    discard: copyParts(s.discard),
    blueprints: s.blueprints.map((b: Blueprint) => ({ id: b.id, def: b.def })),
    handSize: s.handSize,
    over: s.over,
    won: s.won,
    decisions: s.decisions,
  };
  Object.assign(runMemo(c), runMemo(s));
  return c;
}
