// TAKT — view-model tests.
//
// The UI is split so that everything that DECIDES something is in `web/src/vm.ts`
// and everything that draws is in `stage.ts`/`draw.ts`. This file exercises the
// deciding half with no DOM at all: the diff between two stages of a shipment, the
// beat timings, the contribution breakdown that has to add up, the live reorder
// preview, and finally a whole run played start to finish through those same
// functions. If the animation is ever wrong about *why* the number changed, it is
// wrong here first.

import test from 'node:test';
import assert from 'node:assert/strict';

import '../src/content/index.ts';
import type { Machine, Part, RunState } from '../src/engine/types.ts';
import { ROUNDS_PER_SHIFT, SHIFTS_PER_RUN } from '../src/engine/types.ts';
import {
  buy, newRun, nextRound, playShipment, previewShipment, reorderLine, rollShop, roundCleared,
} from '../src/engine/run.ts';
import { getRegistry } from '../src/content/registry.ts';
import { PARTS, TIER_LADDER } from '../src/content/parts.ts';

import {
  DRAWN_DEFS, OUTLINE_POINTS, TIER_COLORS, colorOf, morphOutline, resample, silhouette, tierOf,
} from '../web/src/art.ts';
import type { PartSnap } from '../web/src/vm.ts';
import {
  GAMBLE_DEFS, bestObject, buildReel, diffStage, dragPerm, fmt, fmtMult, preview,
  lineView, quotaPct, scoreSnaps, snap,
} from '../web/src/vm.ts';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

let uid = 0;
function part(def: string, over: Partial<Part> = {}): Part {
  const pd = getRegistry().parts.get(def);
  assert.ok(pd !== undefined, `unknown part ${def}`);
  return {
    id: over.id ?? `t${uid++}`,
    def,
    value: over.value ?? pd.value,
    mult: over.mult ?? pd.mult,
    tags: over.tags ?? pd.tags.slice(),
    sticky: over.sticky,
  };
}

function snaps(...ps: Part[]): PartSnap[] { return ps.map(snap); }

// ===========================================================================
// 1. the objects
// ===========================================================================

test('every part in the content set has a hand-drawn silhouette', () => {
  const drawn = new Set(DRAWN_DEFS);
  for (const p of PARTS) {
    assert.ok(drawn.has(p.def), `part ${p.def} has no silhouette`);
  }
  assert.equal(DRAWN_DEFS.length, PARTS.length, 'silhouettes and parts are 1:1');
});

test('silhouettes are morph-compatible: same point count, stable endpoints', () => {
  for (const def of DRAWN_DEFS) {
    const s = silhouette(def);
    assert.equal(s.outline.length, OUTLINE_POINTS * 2, `${def} outline is not resampled`);
    for (const n of s.outline) assert.ok(Number.isFinite(n), `${def} has a non-finite point`);
  }
  const a = silhouette('offcut').outline;
  const b = silhouette('monument').outline;
  assert.deepEqual(morphOutline(a, b, 0), a);
  assert.deepEqual(morphOutline(a, b, 1), b);
  const mid = morphOutline(a, b, 0.5);
  assert.equal(mid.length, a.length);
  // a halfway morph is a genuinely intermediate shape, not a snap to either end
  assert.notDeepEqual(mid, a);
  assert.notDeepEqual(mid, b);
});

test('silhouettes are distinguishable from each other', () => {
  const seen = new Map<string, string>();
  for (const def of DRAWN_DEFS) {
    const key = silhouette(def).outline.map((n) => n.toFixed(3)).join(',');
    const prev = seen.get(key);
    assert.equal(prev, undefined, `${def} draws the same shape as ${prev}`);
    seen.set(key, def);
  }
});

test('resample survives a degenerate polygon', () => {
  const flat = resample([0, 0, 1, 0, 1, 0], 16);
  assert.equal(flat.length, 32);
  for (const n of flat) assert.ok(Number.isFinite(n));
});

test('the tier ladder reads as a ramp; off-ladder parts colour by material', () => {
  TIER_LADDER.forEach((t, i) => {
    assert.equal(tierOf(t.def), i);
    assert.equal(colorOf(t.def, t.tags), TIER_COLORS[i]);
  });
  assert.equal(tierOf('fish'), -1);
  assert.notEqual(colorOf('fish', ['organic']), colorOf('cell', ['volatile']));
});

// ===========================================================================
// 2. the diff — what a machine actually did
// ===========================================================================

test('diffStage names a promotion', () => {
  const p = part('offcut', { id: 'x' });
  const before = snaps(p);
  const after = snaps({ ...p, def: 'bolt', value: 9, tags: ['metal'] });
  const [c] = diffStage(before, after);
  assert.equal(c.op, 'promote');
  assert.equal(c.tierDelta, 1);
  assert.equal(c.valueDelta, 6);
});

test('diffStage names a corruption back down to scrap', () => {
  const p = part('engine', { id: 'x' });
  const before = snaps(p);
  const after = snaps({ ...p, def: 'offcut', value: 30, mult: 1.5, tags: ['scrap'] });
  const [c] = diffStage(before, after);
  assert.equal(c.op, 'demote');
  assert.equal(c.tierDelta, -4);
});

test('diffStage names spawns, destroys and moves', () => {
  const a = part('bolt', { id: 'a' });
  const b = part('gear', { id: 'b' });
  const before = snaps(a, b);
  const after = snaps({ ...b }, { ...a }, { ...a, id: 'a+1' });
  const cs = diffStage(before, after);
  const byId = new Map(cs.map((c) => [(c.from ?? c.to as PartSnap).id, c]));
  assert.equal(byId.get('a')?.op, 'move');
  assert.equal(byId.get('a')?.fromIndex, 0);
  assert.equal(byId.get('a')?.toIndex, 1);
  assert.equal(byId.get('b')?.op, 'move');
  const sp = cs.find((c) => c.op === 'spawn');
  assert.ok(sp !== undefined);
  assert.equal(sp.sourceId, 'a', 'a generated part points back at its parent');

  const gone = diffStage(before, snaps(a));
  assert.equal(gone.find((c) => c.op === 'destroy')?.from?.id, 'b');
});

test('diffStage separates a value change from a mult change', () => {
  const p = part('bolt', { id: 'x', value: 10, mult: 1 });
  assert.equal(diffStage(snaps(p), snaps({ ...p, value: 20 }))[0].op, 'gain');
  assert.equal(diffStage(snaps(p), snaps({ ...p, value: 4 }))[0].op, 'lose');
  assert.equal(diffStage(snaps(p), snaps({ ...p, mult: 3 }))[0].op, 'gainMult');
  assert.equal(diffStage(snaps(p), snaps({ ...p, mult: 0 }))[0].op, 'loseMult');
  assert.equal(diffStage(snaps(p), snaps({ ...p }))[0].op, 'hold');
});

test('bestObject prefers the higher rung, then the bigger number', () => {
  const junk = snap(part('slag', { value: 9999 }));
  const gold = snap(part('monument'));
  assert.equal(bestObject([junk, gold])?.def, 'monument');
  const twoBolts = [snap(part('bolt', { value: 5 })), snap(part('bolt', { value: 50 }))];
  assert.equal(bestObject(twoBolts)?.value, 50);
  assert.equal(bestObject([]), null);
});

// ===========================================================================
// 3. the reel
// ===========================================================================

function fixture(seed = 7): { s: RunState; sel: number[] } {
  const s = newRun(seed);
  const sel: number[] = [];
  for (let i = 0; i < Math.min(5, s.hand.length); i++) sel.push(i);
  return { s, sel };
}

test('a reel has one beat per station: intake, each machine, the crate', () => {
  const { s, sel } = fixture();
  const res = previewShipment(s, sel);
  const reel = buildReel(res, { line: s.line, scoreBefore: s.score, quota: s.quota });
  assert.equal(reel.beats.length, s.line.length + 2);
  assert.equal(reel.beats[0].kind, 'entry');
  assert.equal(reel.beats[reel.beats.length - 1].kind, 'crate');
  for (let i = 0; i < s.line.length; i++) {
    assert.equal(reel.beats[i + 1].kind, 'machine');
    assert.equal(reel.beats[i + 1].lineIndex, i);
    assert.equal(reel.beats[i + 1].key, s.line[i].id);
  }
});

test('beats are laid end to end and the pass down the line hits its target length', () => {
  const { s, sel } = fixture();
  const res = previewShipment(s, sel);
  const reel = buildReel(res, { line: s.line, scoreBefore: s.score, quota: s.quota, targetMs: 1600 });
  let t = 0;
  for (const b of reel.beats) {
    assert.equal(b.startMs, t, `beat ${b.name} does not start where the previous one ended`);
    assert.ok(b.durationMs > 0);
    t += b.durationMs;
  }
  assert.equal(reel.totalMs, t);
  assert.ok(Math.abs(reel.lineMs - 1600) < 160, `line pass was ${reel.lineMs}ms, wanted ~1600`);
  assert.equal(reel.totalMs, reel.lineMs + reel.beats[reel.beats.length - 1].durationMs);
});

test('the fast setting shortens the reel without dropping any beat', () => {
  const { s, sel } = fixture();
  const res = previewShipment(s, sel);
  const slow = buildReel(res, { line: s.line, scoreBefore: s.score, quota: s.quota, targetMs: 1600 });
  const fast = buildReel(res, { line: s.line, scoreBefore: s.score, quota: s.quota, targetMs: 700, crateMs: 460 });
  assert.equal(fast.beats.length, slow.beats.length);
  assert.ok(fast.lineMs < slow.lineMs);
  for (const b of fast.beats) assert.ok(b.durationMs >= 70);
});

test('the breakdown adds up to the shipment total', () => {
  for (let seed = 1; seed <= 25; seed++) {
    const { s, sel } = fixture(seed);
    const res = previewShipment(s, sel);
    const reel = buildReel(res, { line: s.line, scoreBefore: s.score, quota: s.quota });
    const sum = reel.breakdown.reduce((a, c) => a + c.delta, 0);
    assert.equal(sum, reel.gained, `seed ${seed}: breakdown does not explain the total`);
    assert.equal(reel.breakdown[0].key, 'base', 'the parts you chose are the first row');
    assert.equal(reel.breakdown.length, s.line.length + 1);
  }
});

test('the peak beat is the machine that made the number big', () => {
  const { s, sel } = fixture(3);
  const res = previewShipment(s, sel);
  const reel = buildReel(res, { line: s.line, scoreBefore: s.score, quota: s.quota });
  const machineBeats = reel.beats.filter((b) => b.kind === 'machine' || b.kind === 'audit');
  const max = Math.max(...machineBeats.map((b) => b.delta));
  assert.equal(reel.beats[reel.peakBeat].delta, max);
});

test('a shipment ends on an object, not on a number', () => {
  const { s, sel } = fixture(11);
  const res = previewShipment(s, sel);
  const reel = buildReel(res, { line: s.line, scoreBefore: s.score, quota: s.quota });
  const crate = reel.beats[reel.beats.length - 1];
  assert.equal(crate.kind, 'crate');
  assert.ok(reel.punchline !== null);
  assert.equal(reel.headline, (reel.punchline as PartSnap).name.toUpperCase());
  assert.ok(reel.awe > 0 && reel.awe <= 1);
  assert.equal(crate.name, 'CRATE');
});

test('gamble machines get a hold before the reveal and nothing else does', () => {
  const s = newRun(5);
  const gambles = [...GAMBLE_DEFS];
  const line: Machine[] = [
    { id: 'g0', def: gambles[2], level: 1 },   // wildcard — promote everything, or ruin it
    { id: 'g1', def: 'press', level: 1 },
  ];
  const res = previewShipment(s, [0, 1, 2], line);
  const reel = buildReel(res, { line, scoreBefore: 0, quota: 500 });
  const g = reel.beats[1];
  const plain = reel.beats[2];
  assert.equal(g.drama, 'gamble');
  assert.ok(g.holdMs >= 220, `gamble hold was ${g.holdMs}ms — no suspense`);
  assert.ok(g.durationMs > g.holdMs);
  assert.equal(plain.holdMs, 0);
  assert.notEqual(plain.drama, 'gamble');
});

test('a machine that whiffs is reported as having done nothing', () => {
  // The content set deliberately allows conditionals to miss (see the header of
  // machines.ts). A miss the player cannot see is indistinguishable from a bug, so
  // the reel has to label it — here, across the whole machine set on one batch.
  const s = newRun(9);
  const sel = [0, 1, 2];
  let whiffs = 0;
  for (const def of getRegistry().machines.keys()) {
    const line: Machine[] = [{ id: 'm0', def, level: 1 }];
    const reel = buildReel(previewShipment(s, sel, line), { line, scoreBefore: 0, quota: 1 });
    const beat = reel.beats[1];
    assert.equal(beat.kind, 'machine');
    if (!beat.fired) {
      whiffs++;
      assert.equal(beat.drama, 'idle', `${def} did nothing but was not marked idle`);
      assert.equal(beat.delta, 0);
      assert.equal(reel.breakdown.find((c) => c.key === 'm0')?.fired, false);
    }
  }
  assert.ok(whiffs > 0, 'no machine in the whole set ever whiffs — the drama is missing');
});

test('an empty line is still intake and a crate', () => {
  const s = newRun(9);
  const reel = buildReel(previewShipment(s, [0], []), { line: [], scoreBefore: 0, quota: 1 });
  assert.equal(reel.beats.length, 2);
  assert.equal(reel.beats[0].kind, 'entry');
  assert.equal(reel.beats[1].kind, 'crate');
  assert.equal(reel.breakdown.length, 1);
  assert.equal(reel.breakdown[0].delta, reel.gained);
});

test('the audit gets its own beat on round three, and its own row in the breakdown', () => {
  const s = newRun(4);
  s.round = ROUNDS_PER_SHIFT;
  const audit = getRegistry().audits[s.shift - 1];
  const res = previewShipment(s, [0, 1, 2]);
  assert.equal(res.stages.length, s.line.length + 2, 'engine appends a post-audit stage');
  const reel = buildReel(res, {
    line: s.line, scoreBefore: 0, quota: s.quota,
    audit: { def: audit.def, name: audit.name, text: audit.text },
  });
  const beat = reel.beats.find((b) => b.kind === 'audit');
  assert.ok(beat !== undefined);
  assert.equal(beat.name, audit.name);
  assert.equal(beat.text, audit.text);
  assert.ok(reel.breakdown.some((c) => c.name === audit.name));
  assert.equal(reel.beats.length, s.line.length + 3);
});

test('a reel is well-formed for every shift of the run, audits included', () => {
  const s = newRun(21);
  for (let shift = 1; shift <= SHIFTS_PER_RUN; shift++) {
    for (let round = 1; round <= ROUNDS_PER_SHIFT; round++) {
      s.shift = shift;
      s.round = round;
      const res = previewShipment(s, [0, 1, 2, 3]);
      const audit = round === ROUNDS_PER_SHIFT ? getRegistry().audits[shift - 1] : null;
      const reel = buildReel(res, {
        line: s.line, scoreBefore: 0, quota: 100,
        audit: audit === null ? null : { def: audit.def, name: audit.name, text: audit.text },
      });
      assert.equal(reel.breakdown.reduce((a, c) => a + c.delta, 0), reel.gained);
      for (const b of reel.beats) {
        assert.ok(Number.isFinite(b.durationMs) && b.durationMs > 0);
        assert.equal(b.before.length >= 0, true);
        for (const c of b.changes) {
          assert.ok(c.from !== null || c.to !== null, 'a change with neither side is meaningless');
        }
      }
    }
  }
});

test('scoreSnaps matches the engine scoring rule', () => {
  const { s, sel } = fixture(13);
  const res = previewShipment(s, sel);
  const last = res.stages[res.stages.length - 1].map(snap);
  assert.equal(scoreSnaps(last), res.gained);
});

// ===========================================================================
// 4. reordering — the live preview under the player's thumb
// ===========================================================================

test('dragPerm agrees with an array move, and with reorderLine', () => {
  assert.deepEqual(dragPerm(4, 0, 2), [1, 2, 0, 3]);
  assert.deepEqual(dragPerm(4, 3, 0), [3, 0, 1, 2]);
  assert.deepEqual(dragPerm(4, 1, 1), [0, 1, 2, 3]);
  assert.deepEqual(dragPerm(4, -1, 9), [0, 1, 2, 3]);

  const s = newRun(2);
  while (s.line.length < 4) s.line.push({ id: `x${s.line.length}`, def: 'press', level: 1 });
  const names = s.line.map((m) => m.id);
  reorderLine(s, dragPerm(s.line.length, 0, 2));
  const want = names.slice();
  want.splice(2, 0, want.splice(0, 1)[0]);
  assert.deepEqual(s.line.map((m) => m.id), want);
});

test('the live preview matches what the shipment will actually pay', () => {
  const { s, sel } = fixture(17);
  const pv = preview(s, sel);
  assert.equal(pv.ok, true);
  const res = playShipment(s, sel);
  assert.equal(pv.score, res.gained);
  assert.equal(pv.cleared, res.cleared);
});

test('the preview prices a candidate ordering without touching the run', () => {
  const s = newRun(23);
  while (s.line.length < 4) s.line.push({ id: `x${s.line.length}`, def: 'doubler', level: 1 });
  const sel = [0, 1, 2, 3, 4];
  const before = JSON.stringify({ score: s.score, credits: s.credits, hand: s.hand, line: s.line });
  const a = preview(s, sel);
  const flipped = s.line.slice().reverse();
  const b = preview(s, sel, flipped);
  assert.equal(JSON.stringify({ score: s.score, credits: s.credits, hand: s.hand, line: s.line }), before);
  assert.equal(a.perMachine.length, s.line.length);
  assert.equal(b.perMachine.length, flipped.length);
  assert.ok(a.ok && b.ok);
});

test('order is load-bearing: some permutation of the line pays more than another', () => {
  // If this ever fails, the animation is honest and the game is not.
  let found = false;
  for (let seed = 1; seed <= 40 && !found; seed++) {
    const s = newRun(seed);
    const sel = [0, 1, 2, 3, 4].slice(0, Math.min(5, s.hand.length));
    const base = preview(s, sel).score;
    const flipped = preview(s, sel, s.line.slice().reverse()).score;
    if (flipped !== base) found = true;
  }
  assert.ok(found, 'no seed in 40 changed its score when the line was reversed');
});

test('preview refuses batches the engine would refuse', () => {
  const s = newRun(31);
  assert.equal(preview(s, []).ok, false);
  assert.equal(preview(s, [0, 1, 2, 3, 4, 5]).ok, false);
  assert.equal(preview(s, [0, 0]).ok, false, 'a duplicated hand index is not a batch');
  assert.equal(preview(s, [999]).ok, false);
});

test('lineView carries the rule text the player is shown', () => {
  const s = newRun(6);
  const view = lineView(s.line);
  assert.equal(view.length, s.line.length);
  view.forEach((m, i) => {
    const def = getRegistry().machines.get(s.line[i].def);
    assert.equal(m.name, def?.name);
    assert.equal(m.text, def?.text(s.line[i].level));
    assert.equal(m.gamble, GAMBLE_DEFS.has(m.def));
    assert.ok(m.text.length > 0, `${m.def} has no rule text to show`);
  });
});

test('number formatting stays readable on a phone', () => {
  assert.equal(fmt(0), '0');
  assert.equal(fmt(12480), '12,480');
  assert.equal(fmt(-25), '-25');
  assert.equal(fmt(2_500_000), '2.50M');
  assert.equal(fmt(3_000_000_000), '3.00B');
  assert.equal(fmtMult(2), 'x2');
  assert.equal(fmtMult(1.5), 'x1.5');
  assert.equal(quotaPct(150, 300), 0.5);
  assert.equal(quotaPct(900, 300), 1);
  assert.equal(quotaPct(5, 0), 1);
});

// ===========================================================================
// 5. a whole run, played through the view-model
// ===========================================================================

function subsets(n: number, k: number): number[][] {
  const out: number[][] = [];
  const cur: number[] = [];
  const rec = (start: number): void => {
    if (cur.length === k) { out.push(cur.slice()); return; }
    for (let i = start; i < n; i++) { cur.push(i); rec(i + 1); cur.pop(); }
  };
  rec(0);
  return out;
}

const PERMS = new Map<number, number[][]>();
function perms(n: number): number[][] {
  let cached = PERMS.get(n);
  if (cached !== undefined) return cached;
  const out: number[][] = [];
  const cur: number[] = [];
  const used = new Array<boolean>(n).fill(false);
  const rec = (): void => {
    if (cur.length === n) { out.push(cur.slice()); return; }
    for (let i = 0; i < n; i++) {
      if (used[i]) continue;
      used[i] = true; cur.push(i); rec(); cur.pop(); used[i] = false;
    }
  };
  rec();
  PERMS.set(n, out);
  cached = out;
  return cached;
}

/** everything below prices moves with `preview` — the same call the drag UI makes */
function score(s: RunState, sel: number[], line?: readonly Machine[]): number {
  const p = preview(s, sel, line);
  return p.ok ? p.score : -1;
}

function bestSelection(s: RunState, line?: readonly Machine[]): number[] {
  const k = Math.min(5, s.hand.length);
  let best: number[] = [];
  let bs = -1;
  for (const sub of subsets(s.hand.length, k)) {
    for (const ord of [sub, sub.slice().reverse()]) {
      const v = score(s, ord, line);
      if (v > bs) { bs = v; best = ord.slice(); }
    }
  }
  for (let pass = 0; pass < 3; pass++) {
    let moved = false;
    for (let i = 0; i + 1 < best.length; i++) {
      const t = best.slice();
      const tmp = t[i]; t[i] = t[i + 1]; t[i + 1] = tmp;
      const v = score(s, t, line);
      if (v > bs) { bs = v; best = t; moved = true; }
    }
    if (!moved) break;
  }
  return best;
}

function bestOrder(s: RunState, sel: number[], line: readonly Machine[]): Machine[] {
  let cur = line.slice();
  let bs = score(s, sel, cur);
  if (line.length <= 6) {
    for (const p of perms(line.length)) {
      const cand = p.map((k) => line[k]);
      const v = score(s, sel, cand);
      if (v > bs) { bs = v; cur = cand; }
    }
    return cur;
  }
  for (let pass = 0; pass < 6; pass++) {
    let moved = false;
    for (let i = 0; i < cur.length; i++) {
      for (let j = 0; j < cur.length; j++) {
        if (i === j) continue;
        const t = cur.slice();
        t.splice(j, 0, t.splice(i, 1)[0]);
        const v = score(s, sel, t);
        if (v > bs) { bs = v; cur = t; moved = true; }
      }
    }
    if (!moved) break;
  }
  return cur;
}

function valueOfLine(s: RunState, line: readonly Machine[]): number {
  const sel = bestSelection(s, line);
  return score(s, sel, bestOrder(s, sel, line));
}

function doShop(s: RunState): void {
  const shop = rollShop(s);
  for (let guard = 0; guard < 12; guard++) {
    const baseline = valueOfLine(s, s.line);
    let bestI = -1;
    let bestRate = 0;
    for (let i = 0; i < shop.items.length; i++) {
      const it = shop.items[i];
      if (it.cost > s.credits) continue;
      let gain = 0;
      if (it.kind === 'machine') {
        if (s.line.length >= s.lineCap) continue;
        gain = valueOfLine(s, s.line.concat([{ id: 'try', def: it.def, level: 1 }])) - baseline;
      } else if (it.kind === 'upgrade') {
        const t = s.line.findIndex((m) => m.def === it.def);
        if (t < 0) continue;
        gain = valueOfLine(s, s.line.map((m, k) => (k === t ? { ...m, level: m.level + 1 } : m))) - baseline;
      } else if (it.kind === 'lineslot') {
        gain = s.line.length >= s.lineCap ? baseline * 0.5 : baseline * 0.05;
      } else {
        gain = baseline * (it.kind === 'blueprint' ? 0.12 : 0.06);
      }
      const rate = gain / Math.max(1, it.cost);
      if (gain > 0 && rate > bestRate) { bestRate = rate; bestI = i; }
    }
    if (bestI < 0) break;
    if (!buy(s, shop, bestI)) break;
  }
}

interface RunOutcome {
  won: boolean; shift: number; round: number; score: number;
  shipments: number; reels: number; bestRung: number;
}

/**
 * Play a whole run using only the view-model's own calls: `preview` to price a
 * batch and a candidate ordering, `dragPerm`/`reorderLine` to commit a reorder, and
 * `buildReel` on every result — which is exactly the sequence the screen performs.
 * Every reel built along the way is checked, so this doubles as a fuzz test of the
 * animation script against all 110 machines and all 8 audits.
 */
function playRun(seed: number): RunOutcome {
  const s = newRun(seed);
  let shipments = 0;
  let reels = 0;
  let bestRung = -1;
  let guard = 0;

  while (!s.over && guard++ < 400) {
    while (!roundCleared(s) && s.shipmentsLeft > 0 && !s.over) {
      const sel = bestSelection(s);
      const ordered = bestOrder(s, sel, s.line);
      const perm = ordered.map((m) => s.line.indexOf(m));
      if (perm.every((p) => p >= 0)) reorderLine(s, perm);

      const finalSel = bestSelection(s);
      const expect = preview(s, finalSel);
      const line = s.line.map((m) => ({ ...m }));
      const audit = s.round === ROUNDS_PER_SHIFT ? getRegistry().audits[s.shift - 1] : null;
      const scoreBefore = s.score;
      const quota = s.quota;

      const res = playShipment(s, finalSel);
      assert.equal(res.gained, expect.score, 'the number on the SHIP button lied');

      const reel = buildReel(res, {
        line, scoreBefore, quota,
        audit: audit === null ? null : { def: audit.def, name: audit.name, text: audit.text },
      });
      reels++;
      shipments++;
      assert.equal(reel.breakdown.reduce((a, c) => a + c.delta, 0), reel.gained);
      assert.equal(reel.scoreAfter, scoreBefore + res.gained);
      assert.equal(reel.beats[reel.beats.length - 1].kind, 'crate');
      if (reel.punchline !== null) bestRung = Math.max(bestRung, reel.punchline.tier);
    }
    if (s.over || !roundCleared(s)) break;
    doShop(s);
    nextRound(s);
  }
  return {
    won: s.won, shift: s.shift, round: s.round, score: s.score, shipments, reels, bestRung,
  };
}

test('a full run is completable end to end through the view-model', () => {
  const outcomes: RunOutcome[] = [];
  for (let seed = 1; seed <= 12; seed++) outcomes.push(playRun(seed));

  const wins = outcomes.filter((o) => o.won).length;
  const shipments = outcomes.reduce((a, o) => a + o.shipments, 0);
  const reels = outcomes.reduce((a, o) => a + o.reels, 0);

  assert.ok(shipments > 200, `only ${shipments} shipments played`);
  assert.equal(reels, shipments, 'every shipment produced an animation script');
  assert.ok(
    wins >= 1,
    `no seed of 12 finished all ${SHIFTS_PER_RUN} shifts — the run may not be completable`,
  );
  // and the ones that lose must lose cleanly, not hang or corrupt themselves
  for (const o of outcomes) {
    assert.ok(o.shift >= 1 && o.shift <= SHIFTS_PER_RUN);
    assert.ok(o.round >= 1 && o.round <= ROUNDS_PER_SHIFT);
    assert.ok(o.score >= 0);
  }
});

test('a run visibly climbs the tier ladder — junk goes in, better things come out', () => {
  const o = playRun(12);
  assert.ok(
    o.bestRung >= 2,
    `the best object a whole run ever produced was rung ${o.bestRung} — no alchemy happened`,
  );
});
