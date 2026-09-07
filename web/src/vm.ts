// TAKT — the view-model.
//
// This is the layer the brief cares about and the layer `tests/ui.test.ts` drives:
// it turns a `ShipmentResult` into an ANIMATION SCRIPT and knows nothing about the
// DOM, canvas or time. The renderer is a dumb consumer of what comes out of here.
//
// The product claim being served: *the player must see why the number changed.*
// A ShipmentResult is a list of batches — the state of the line at each station.
// What a human needs is the list of EVENTS between those states: this part was
// promoted, that one was thrown away, this one split in two, and the total went from
// 400 to 3,100 because of the fourth machine. So `buildReel` diffs consecutive
// stages part-by-part (matching on `Part.id`, which every machine preserves through
// its transforms) and emits one beat per machine with the changes attributed to it.
//
// Two beats matter more than the rest and are marked as such:
//  - `drama: 'gamble'` — the six coin-flip machines get a hold before the reveal.
//  - the `crate` beat — the punchline. A shipment ends on an OBJECT, not a number.

import type { Batch, Machine, Part, Tag } from '../../src/engine/types.ts';
import { scoreBatch } from '../../src/engine/types.ts';
import type { ShipmentResult } from '../../src/engine/api.ts';
import type { RunState } from '../../src/engine/types.ts';
import { previewShipment } from '../../src/engine/run.ts';
import { getRegistry } from '../../src/content/registry.ts';
import { TIER_INDEX, TIER_LADDER } from '../../src/content/parts.ts';

// ---------------------------------------------------------------------------
// snapshots
// ---------------------------------------------------------------------------

export interface PartSnap {
  id: string;
  def: string;
  name: string;
  value: number;
  mult: number;
  tags: Tag[];
  /** rung on the Offcut→Monument ladder, or -1 for an off-ladder object */
  tier: number;
  /** what this part contributes to the batch total */
  score: number;
  sticky: boolean;
}

export function snap(p: Part): PartSnap {
  const reg = getRegistry();
  const pd = reg.parts.get(p.def);
  const t = TIER_INDEX.get(p.def);
  return {
    id: p.id,
    def: p.def,
    name: pd !== undefined ? pd.name : titleize(p.def),
    value: p.value,
    mult: p.mult,
    tags: p.tags.slice(),
    tier: t === undefined ? -1 : t,
    score: p.value * p.mult,
    sticky: p.sticky === true,
  };
}

export function snapAll(b: Batch): PartSnap[] {
  return b.map(snap);
}

function titleize(def: string): string {
  return def.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/** The engine's scoring rule, applied to snapshots so the UI never re-derives it. */
export function scoreSnaps(ps: readonly PartSnap[]): number {
  let t = 0;
  for (const p of ps) t += p.value * p.mult;
  return Math.max(0, Math.floor(t));
}

// ---------------------------------------------------------------------------
// the diff
// ---------------------------------------------------------------------------

export type PartOp =
  | 'hold' | 'move' | 'gain' | 'lose' | 'gainMult' | 'loseMult'
  | 'promote' | 'demote' | 'transmute' | 'spawn' | 'destroy';

export interface PartChange {
  op: PartOp;
  from: PartSnap | null;
  to: PartSnap | null;
  /** slot the part occupied before this machine, or -1 if it was created here */
  fromIndex: number;
  /** slot it occupies after, or -1 if it was destroyed here */
  toIndex: number;
  tierDelta: number;
  valueDelta: number;
  multDelta: number;
  scoreDelta: number;
  /** for a spawn: the id of the part it was cloned from, when that is recoverable */
  sourceId: string | null;
}

/** Weight used to decide which single change a beat should be *about*. */
const OP_WEIGHT: Record<PartOp, number> = {
  promote: 100, demote: 95, transmute: 90, spawn: 80, destroy: 78,
  gainMult: 60, loseMult: 58, gain: 40, lose: 38, move: 12, hold: 0,
};

/**
 * Match parts across a machine by id, then classify what happened to each.
 * Machines copy parts rather than mutating them but preserve `id`, and generated
 * parts get ids of the form `<parent>+<n>`, which is what makes both the matching
 * and the spawn-parentage below reliable rather than heuristic.
 */
export function diffStage(before: readonly PartSnap[], after: readonly PartSnap[]): PartChange[] {
  const pool = new Map<string, number[]>();
  for (let i = 0; i < after.length; i++) {
    const list = pool.get(after[i].id);
    if (list === undefined) pool.set(after[i].id, [i]);
    else list.push(i);
  }
  const takenAfter = new Uint8Array(after.length);
  const changes: PartChange[] = [];

  for (let i = 0; i < before.length; i++) {
    const b = before[i];
    const list = pool.get(b.id);
    let j = -1;
    if (list !== undefined) {
      while (list.length > 0) {
        const k = list.shift() as number;
        if (takenAfter[k] === 0) { j = k; break; }
      }
    }
    if (j < 0) {
      changes.push(mkChange('destroy', b, null, i, -1, null));
      continue;
    }
    takenAfter[j] = 1;
    const a = after[j];
    changes.push(mkChange(classify(b, a, i, j), b, a, i, j, null));
  }

  for (let j = 0; j < after.length; j++) {
    if (takenAfter[j] === 1) continue;
    const a = after[j];
    const plus = a.id.lastIndexOf('+');
    const src = plus > 0 ? a.id.slice(0, plus) : null;
    changes.push(mkChange('spawn', null, a, -1, j, src));
  }
  return changes;
}

function mkChange(
  op: PartOp, from: PartSnap | null, to: PartSnap | null,
  fromIndex: number, toIndex: number, sourceId: string | null,
): PartChange {
  const ft = from !== null ? from.tier : -1;
  const tt = to !== null ? to.tier : -1;
  return {
    op, from, to, fromIndex, toIndex,
    tierDelta: from !== null && to !== null && ft >= 0 && tt >= 0 ? tt - ft : 0,
    valueDelta: (to !== null ? to.value : 0) - (from !== null ? from.value : 0),
    multDelta: (to !== null ? to.mult : 0) - (from !== null ? from.mult : 0),
    scoreDelta: (to !== null ? to.score : 0) - (from !== null ? from.score : 0),
    sourceId,
  };
}

function classify(b: PartSnap, a: PartSnap, i: number, j: number): PartOp {
  if (b.def !== a.def) {
    if (b.tier >= 0 && a.tier >= 0) {
      if (a.tier > b.tier) return 'promote';
      if (a.tier < b.tier) return 'demote';
    }
    if (a.tier > b.tier) return 'promote';
    if (b.tier >= 0 && a.tier < 0) return 'demote';
    return 'transmute';
  }
  if (a.mult !== b.mult) return a.mult > b.mult ? 'gainMult' : 'loseMult';
  if (a.value !== b.value) return a.value > b.value ? 'gain' : 'lose';
  if (i !== j) return 'move';
  return 'hold';
}

// ---------------------------------------------------------------------------
// the reel
// ---------------------------------------------------------------------------

export type BeatKind = 'entry' | 'machine' | 'audit' | 'crate';
export type Drama = 'idle' | 'small' | 'big' | 'gamble';

/**
 * The six machines that flip a coin. They get the biggest moment in the animation
 * because they are the only moments in the game that are not the player's fault,
 * and because they are the screenshot.
 */
export const GAMBLE_DEFS: ReadonlySet<string> = new Set([
  'roulette', 'jackpot', 'wildcard', 'dice_press', 'gremlin', 'lucky_run',
]);

export interface Beat {
  index: number;
  kind: BeatKind;
  /** machine id, or 'entry' / 'audit' / 'crate' */
  key: string;
  def: string;
  name: string;
  /** the rule text as printed on the machine, already level-substituted */
  text: string;
  archetype: string;
  level: number;
  /** position in the line, -1 for entry/audit/crate */
  lineIndex: number;
  before: PartSnap[];
  after: PartSnap[];
  changes: PartChange[];
  /** the one change this beat is *about* — what the camera should be looking at */
  focus: PartChange | null;
  batchBefore: number;
  batchAfter: number;
  delta: number;
  fired: boolean;
  drama: Drama;
  /** suspense before the change lands. Only gambles get a meaningful one. */
  holdMs: number;
  durationMs: number;
  startMs: number;
}

export interface Contribution {
  key: string;
  name: string;
  lineIndex: number;
  delta: number;
  /** signed share of the shipment's gain, in [-1,1] */
  share: number;
  fired: boolean;
  drama: Drama;
}

export interface Reel {
  beats: Beat[];
  /** total animation length including the crate beat */
  totalMs: number;
  /** length of the pass down the line, excluding the crate finale */
  lineMs: number;
  gained: number;
  scoreBefore: number;
  scoreAfter: number;
  quota: number;
  cleared: boolean;
  /** the object that arrives in the crate — the point of the whole animation */
  punchline: PartSnap | null;
  headline: string;
  /** 0..1, how much of a spectacle the punchline deserves */
  awe: number;
  breakdown: Contribution[];
  /** index into `beats` of the machine that made the number big */
  peakBeat: number;
}

export interface ReelOptions {
  line: readonly Machine[];
  scoreBefore: number;
  quota: number;
  /** target length of the pass down the line, in ms. The crate finale is extra. */
  targetMs?: number;
  crateMs?: number;
  /** the audit in force this round, if any */
  audit?: { def: string; name: string; text: string } | null;
}

const NATURAL: Record<Drama, number> = { idle: 90, small: 200, big: 340, gamble: 300 };
const GAMBLE_HOLD = 360;
const MIN_BEAT = 70;

/**
 * Turn a resolved shipment into the thing the player watches.
 *
 * Beat layout: one `entry` beat (the batch rolls onto the belt), one beat per
 * machine in the line, one `audit` beat when a shift boss rewrites the batch on
 * the way out, and one `crate` beat — the punchline. `stages` from the engine is
 * `[entering machine 0, after machine 0, ..., after machine n-1]` with one extra
 * appended stage when an audit is in force, which is why the audit beat is derived
 * from the array length rather than from a flag.
 */
export function buildReel(result: ShipmentResult, opts: ReelOptions): Reel {
  const reg = getRegistry();
  const line = opts.line;
  const stages = result.stages;
  const hasAudit = stages.length === line.length + 2;
  const targetMs = opts.targetMs ?? 1600;
  const crateMs = opts.crateMs ?? 760;

  const snaps: PartSnap[][] = stages.map(snapAll);
  const beats: Beat[] = [];

  const entryBatch = snaps[0];
  beats.push({
    index: 0, kind: 'entry', key: 'entry', def: 'entry', name: 'INTAKE',
    text: `${entryBatch.length} part${entryBatch.length === 1 ? '' : 's'} onto the belt`,
    archetype: 'positional', level: 0, lineIndex: -1,
    before: entryBatch, after: entryBatch, changes: [], focus: null,
    batchBefore: scoreSnaps(entryBatch), batchAfter: scoreSnaps(entryBatch),
    delta: 0, fired: true, drama: 'small', holdMs: 0, durationMs: 240, startMs: 0,
  });

  for (let i = 0; i < line.length; i++) {
    const m = line[i];
    const def = reg.machines.get(m.def);
    const before = snaps[i];
    const after = snaps[i + 1];
    const changes = diffStage(before, after);
    const fired = stages[i] !== stages[i + 1] && !identical(before, after);
    const batchBefore = scoreSnaps(before);
    const batchAfter = scoreSnaps(after);
    const gamble = GAMBLE_DEFS.has(m.def);
    const focus = pickFocus(changes);
    const drama = gamble ? 'gamble' : dramaOf(fired, changes, batchAfter - batchBefore, batchBefore);
    beats.push({
      index: beats.length, kind: 'machine', key: m.id, def: m.def,
      name: def !== undefined ? def.name : titleize(m.def),
      text: def !== undefined ? def.text(m.level) : '',
      archetype: def !== undefined ? def.archetype : 'arithmetic',
      level: m.level, lineIndex: i,
      before, after, changes, focus,
      batchBefore, batchAfter, delta: batchAfter - batchBefore,
      fired, drama,
      holdMs: gamble ? GAMBLE_HOLD : 0,
      durationMs: NATURAL[drama] + (gamble ? GAMBLE_HOLD : 0),
      startMs: 0,
    });
  }

  if (hasAudit) {
    const before = snaps[stages.length - 2];
    const after = snaps[stages.length - 1];
    const changes = diffStage(before, after);
    const batchBefore = scoreSnaps(before);
    const batchAfter = scoreSnaps(after);
    const a = opts.audit;
    beats.push({
      index: beats.length, kind: 'audit', key: 'audit',
      def: a !== undefined && a !== null ? a.def : 'audit',
      name: a !== undefined && a !== null ? a.name : 'AUDIT',
      text: a !== undefined && a !== null ? a.text : 'the audit inspects the batch',
      archetype: 'filter', level: 0, lineIndex: -1,
      before, after, changes, focus: pickFocus(changes),
      batchBefore, batchAfter, delta: batchAfter - batchBefore,
      fired: !identical(before, after),
      drama: identical(before, after) ? 'idle' : 'big',
      holdMs: 0, durationMs: NATURAL.big, startMs: 0,
    });
  }

  // Normalise the pass down the line to the target length, then lay out start times.
  let natural = 0;
  for (const b of beats) natural += b.durationMs;
  const scale = natural > 0 ? targetMs / natural : 1;
  let t = 0;
  for (const b of beats) {
    b.holdMs = b.holdMs > 0 ? Math.max(220, Math.round(b.holdMs * scale)) : 0;
    b.durationMs = Math.max(MIN_BEAT + b.holdMs, Math.round(b.durationMs * scale));
    b.startMs = t;
    t += b.durationMs;
  }
  const lineMs = t;

  const final = snaps[snaps.length - 1];
  const punchline = bestObject(final);
  const crate: Beat = {
    index: beats.length, kind: 'crate', key: 'crate', def: 'crate',
    name: 'CRATE', text: punchline !== null ? punchline.name : 'empty',
    archetype: 'economic', level: 0, lineIndex: -1,
    before: final, after: final, changes: [], focus: null,
    batchBefore: scoreSnaps(final), batchAfter: scoreSnaps(final),
    delta: 0, fired: true, drama: punchline !== null && punchline.tier >= 4 ? 'big' : 'small',
    holdMs: 0, durationMs: crateMs, startMs: lineMs,
  };
  beats.push(crate);

  // The breakdown has to ADD UP, or it is decoration rather than an explanation.
  // The parts you chose are the first row; every machine's row is what it added on
  // top; the rows sum to the shipment total.
  const denom = Math.abs(result.gained) > 0 ? Math.abs(result.gained) : 1;
  const breakdown: Contribution[] = [{
    key: 'base', name: 'RAW PARTS', lineIndex: -1,
    delta: scoreSnaps(entryBatch), share: scoreSnaps(entryBatch) / denom,
    fired: true, drama: 'small',
  }];
  for (const b of beats) {
    if (b.kind !== 'machine' && b.kind !== 'audit') continue;
    breakdown.push({
      key: b.key, name: b.name, lineIndex: b.lineIndex, delta: b.delta,
      share: b.delta / denom, fired: b.fired, drama: b.drama,
    });
  }

  let peak = -1;
  let peakDelta = -Infinity;
  for (const b of beats) {
    if (b.kind !== 'machine' && b.kind !== 'audit') continue;
    if (b.delta > peakDelta) { peakDelta = b.delta; peak = b.index; }
  }

  return {
    beats,
    totalMs: lineMs + crateMs,
    lineMs,
    gained: result.gained,
    scoreBefore: opts.scoreBefore,
    scoreAfter: opts.scoreBefore + result.gained,
    quota: opts.quota,
    cleared: result.cleared,
    punchline,
    headline: punchline !== null ? punchline.name.toUpperCase() : 'NOTHING',
    awe: punchline !== null ? aweOf(punchline) : 0,
    breakdown,
    peakBeat: peak,
  };
}

function identical(a: readonly PartSnap[], b: readonly PartSnap[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x.id !== y.id || x.def !== y.def || x.value !== y.value || x.mult !== y.mult) return false;
  }
  return true;
}

function pickFocus(changes: readonly PartChange[]): PartChange | null {
  let best: PartChange | null = null;
  let bestW = -1;
  for (const c of changes) {
    const w = OP_WEIGHT[c.op] * 1000 + Math.min(999, Math.abs(c.scoreDelta));
    if (w > bestW) { bestW = w; best = c; }
  }
  return best !== null && best.op === 'hold' ? null : best;
}

function dramaOf(
  fired: boolean, changes: readonly PartChange[], delta: number, before: number,
): Drama {
  if (!fired) return 'idle';
  for (const c of changes) {
    if (c.op === 'promote' || c.op === 'demote' || c.op === 'transmute') return 'big';
    if (c.op === 'spawn' || c.op === 'destroy') return 'big';
  }
  if (before > 0 && Math.abs(delta) >= before) return 'big';
  return 'small';
}

/** The object the shipment is *about*: highest rung first, then biggest number. */
export function bestObject(ps: readonly PartSnap[]): PartSnap | null {
  let best: PartSnap | null = null;
  for (const p of ps) {
    if (best === null) { best = p; continue; }
    if (p.tier !== best.tier ? p.tier > best.tier : p.score > best.score) best = p;
  }
  return best;
}

function aweOf(p: PartSnap): number {
  const byTier = p.tier < 0 ? 0.25 : p.tier / (TIER_LADDER.length - 1);
  const byScore = Math.min(1, Math.log10(Math.max(1, p.score)) / 4);
  return Math.max(byTier, byScore * 0.85);
}

// ---------------------------------------------------------------------------
// live preview — the other half of the brief
// ---------------------------------------------------------------------------

export interface Preview {
  ok: boolean;
  score: number;
  scoreAfter: number;
  cleared: boolean;
  /** what would come out of the crate under this ordering */
  punchline: PartSnap | null;
  /** per-machine deltas, so a drag can show WHERE the gain moved to */
  perMachine: number[];
}

const EMPTY_PREVIEW: Preview = {
  ok: false, score: 0, scoreAfter: 0, cleared: false, punchline: null, perMachine: [],
};

/**
 * Price a candidate ordering of the line against the current selection. This is
 * what makes dragging a machine feel like a decision instead of housekeeping: the
 * number under the player's thumb moves while the thumb is still down.
 */
export function preview(
  s: RunState, handIndices: readonly number[], line?: readonly Machine[],
): Preview {
  if (handIndices.length === 0 || handIndices.length > 5) return EMPTY_PREVIEW;
  let res: ShipmentResult;
  try {
    res = previewShipment(s, handIndices.slice(), line === undefined ? undefined : line.slice());
  } catch {
    return EMPTY_PREVIEW;
  }
  // Priced on the raw stages rather than on snapshots: this runs on every pointermove
  // while a machine is being dragged, and it is also what the test's auto-player
  // searches with, so it has to stay cheap.
  const used = line === undefined ? s.line : line;
  const perMachine: number[] = [];
  for (let i = 0; i < used.length; i++) {
    perMachine.push(scoreBatch(res.stages[i + 1]) - scoreBatch(res.stages[i]));
  }
  return {
    ok: true,
    score: res.gained,
    scoreAfter: res.scoreAfter,
    cleared: res.cleared,
    punchline: bestObject(snapAll(res.stages[res.stages.length - 1])),
    perMachine,
  };
}

/**
 * Move item `from` to index `to`, as a permutation for `reorderLine`.
 * `perm[i]` is the OLD index of the machine that ends up at position i, which is
 * the shape the engine wants and is very easy to get backwards.
 */
export function dragPerm(len: number, from: number, to: number): number[] {
  const idx: number[] = [];
  for (let i = 0; i < len; i++) idx.push(i);
  if (from < 0 || from >= len || to < 0 || to >= len || from === to) return idx;
  idx.splice(to, 0, idx.splice(from, 1)[0]);
  return idx;
}

// ---------------------------------------------------------------------------
// small view helpers the chrome needs (kept here so they are testable)
// ---------------------------------------------------------------------------

export interface MachineView {
  id: string;
  def: string;
  name: string;
  text: string;
  archetype: string;
  rarity: string;
  level: number;
  index: number;
  gamble: boolean;
}

export function lineView(line: readonly Machine[]): MachineView[] {
  const reg = getRegistry();
  return line.map((m, i) => {
    const d = reg.machines.get(m.def);
    return {
      id: m.id, def: m.def,
      name: d !== undefined ? d.name : titleize(m.def),
      text: d !== undefined ? d.text(m.level) : '',
      archetype: d !== undefined ? d.archetype : 'arithmetic',
      rarity: d !== undefined ? d.rarity : 'common',
      level: m.level, index: i,
      gamble: GAMBLE_DEFS.has(m.def),
    };
  });
}

/** 12480 -> "12,480";  1234567 -> "1.23M" once numbers stop fitting on a phone. */
export function fmt(n: number): string {
  const v = Math.round(n);
  if (Math.abs(v) >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  return v.toLocaleString('en-US');
}

export function fmtMult(m: number): string {
  const r = Math.round(m * 100) / 100;
  return Number.isInteger(r) ? `x${r}` : `x${r.toFixed(2).replace(/0$/, '')}`;
}

/** Progress toward the quota, clamped for the bar. */
export function quotaPct(score: number, quota: number): number {
  if (quota <= 0) return 1;
  return Math.max(0, Math.min(1, score / quota));
}

export const LADDER_NAMES: string[] = TIER_LADDER.map((t) => t.name);
