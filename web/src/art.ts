// TAKT — the objects.
//
// This file is the answer to the one line in the veteran review that mattered:
// "there is no object in this game anyone could love." Every part def gets a distinct
// flat silhouette, defined here as plain polygons in a [-1,1] box, and every
// silhouette is resampled to the SAME number of outline points so that any part can
// be morphed into any other part. A promotion is therefore a shape *becoming* another
// shape, not a label swapping out from under a number.
//
// DOM-free and canvas-free on purpose: this is data plus geometry, so the unit tests
// can check that every part has a silhouette and that morphing is well-defined.

import type { Tag } from '../../src/engine/types.ts';
import { TIER_LADDER, TIER_INDEX } from '../../src/content/parts.ts';

/** Outline resolution. Every silhouette is resampled to exactly this many points. */
export const OUTLINE_POINTS = 64;

export type Poly = number[]; // flat [x0,y0,x1,y1,...], coordinates in [-1,1], y down

export interface Mark {
  kind: 'hole' | 'dot' | 'line';
  /** hole/dot: [cx, cy, r].  line: [x0,y0,x1,y1,...] */
  pts: number[];
  w?: number;
}

export interface Silhouette {
  def: string;
  /** the morph outline: OUTLINE_POINTS points, arc-length even, starting at the top */
  outline: Poly;
  /** extra solid bits (a doll's head, a governor's flyballs) — cross-faded, not morphed */
  extras: Poly[];
  /** ink detail drawn on top of the fill */
  marks: Mark[];
}

// ---------------------------------------------------------------------------
// palette — two tones per object (a body fill and ink), on one dark ground
// ---------------------------------------------------------------------------

export const PALETTE = {
  bg: '#12100e',
  panel: '#1c1815',
  panelHi: '#272119',
  ink: '#0a0908',
  cream: '#f4eee2',
  dim: '#8d8377',
  line: '#3a332b',
  accent: '#ff7a2f',
  gold: '#ffc53d',
  bad: '#e8433f',
  good: '#5ec98a',
};

/** The tier ramp. Reads as a heat curve: dead grey junk up to a gold Monument. */
export const TIER_COLORS: string[] = [
  '#6a5f52', // offcut   — mud
  '#98a2ad', // bolt     — steel
  '#79c0d8', // gear     — cold precision
  '#57c08d', // pump     — running machine
  '#e8b23c', // engine   — brass
  '#f2762e', // reactor  — fire
  '#ffd84d', // monument — gold
];

export const TAG_COLORS: Record<Tag, string> = {
  metal: '#98a2ad',
  precision: '#79c0d8',
  organic: '#6fbf73',
  volatile: '#f2762e',
  scrap: '#6a5f52',
};

/** rung on the tier ladder, or -1 for an off-ladder part */
export function tierOf(def: string): number {
  const t = TIER_INDEX.get(def);
  return t === undefined ? -1 : t;
}

/** Body colour of a part: its rung if it is on the ladder, else its material. */
export function colorOf(def: string, tags: readonly string[]): string {
  const t = tierOf(def);
  if (t >= 0) return TIER_COLORS[t];
  const tag = (tags.length > 0 ? tags[0] : 'scrap') as Tag;
  return TAG_COLORS[tag] ?? PALETTE.dim;
}

/** How much of a spectacle this object deserves when it lands in the crate. */
export function awe(def: string, score: number): number {
  const t = tierOf(def);
  const byTier = t < 0 ? 0.25 : t / (TIER_LADDER.length - 1);
  const byScore = Math.min(1, Math.log10(Math.max(1, score)) / 4);
  return Math.max(byTier, byScore * 0.85);
}

// ---------------------------------------------------------------------------
// geometry helpers
// ---------------------------------------------------------------------------

function arc(cx: number, cy: number, r: number, a0: number, a1: number, n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    out.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
  }
  return out;
}

function circlePoly(cx: number, cy: number, r: number, n = 28): number[] {
  return arc(cx, cy, r, -Math.PI / 2, Math.PI * 1.5, n).slice(0, n * 2);
}

/** a cog: `teeth` square teeth around a hub */
function cog(teeth: number, rOut: number, rIn: number): number[] {
  const out: number[] = [];
  const step = (Math.PI * 2) / teeth;
  for (let i = 0; i < teeth; i++) {
    const a = -Math.PI / 2 + i * step;
    const w = step * 0.28;
    out.push(Math.cos(a - w) * rIn, Math.sin(a - w) * rIn);
    out.push(Math.cos(a - w * 0.72) * rOut, Math.sin(a - w * 0.72) * rOut);
    out.push(Math.cos(a + w * 0.72) * rOut, Math.sin(a + w * 0.72) * rOut);
    out.push(Math.cos(a + w) * rIn, Math.sin(a + w) * rIn);
    const b = a + step * 0.5;
    out.push(Math.cos(b) * rIn * 0.98, Math.sin(b) * rIn * 0.98);
  }
  return out;
}

/**
 * A tapering ribbon that spirals inward — a lathe chip. Built as an outer spiral
 * plus a reversed inner spiral rather than as an offset band, because offsetting a
 * path with sharp turns produces bowties that no fill rule can rescue.
 */
function ribbon(turns: number, ro0: number, ro1: number, ri0: number, ri1: number, n: number): number[] {
  const outer: number[] = [];
  const inner: number[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const a = -Math.PI / 2 + t * turns * Math.PI * 2;
    outer.push(Math.cos(a) * (ro0 + (ro1 - ro0) * t), Math.sin(a) * (ro0 + (ro1 - ro0) * t));
    inner.push(Math.cos(a) * (ri0 + (ri1 - ri0) * t), Math.sin(a) * (ri0 + (ri1 - ri0) * t));
  }
  const out = outer.slice();
  for (let i = n; i >= 0; i--) out.push(inner[i * 2], inner[i * 2 + 1]);
  return out;
}

/** a closed ring as a polyline mark — used for tree rings and dials */
function ringMark(r: number, n = 20): number[] {
  const p = arc(0, 0, r, -Math.PI / 2, Math.PI * 1.5, n);
  return p;
}

// ---------------------------------------------------------------------------
// resampling — the thing that makes morphing possible
// ---------------------------------------------------------------------------

function perimeter(poly: Poly): number {
  const n = poly.length / 2;
  let d = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    d += Math.hypot(poly[j * 2] - poly[i * 2], poly[j * 2 + 1] - poly[i * 2 + 1]);
  }
  return d;
}

function signedArea(poly: Poly): number {
  const n = poly.length / 2;
  let a = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += poly[i * 2] * poly[j * 2 + 1] - poly[j * 2] * poly[i * 2 + 1];
  }
  return a / 2;
}

/**
 * Even-arc-length resample to exactly `n` points, wound clockwise and rotated so
 * point 0 is the topmost vertex. Two silhouettes prepared this way can be lerped
 * point-for-point and the tween stays a plausible object the whole way across —
 * that is the entire trick behind a promotion looking like a transmutation.
 */
export function resample(poly: Poly, n = OUTLINE_POINTS): Poly {
  let src = poly.slice();
  if (signedArea(src) < 0) {
    const rev: number[] = [];
    for (let i = src.length / 2 - 1; i >= 0; i--) rev.push(src[i * 2], src[i * 2 + 1]);
    src = rev;
  }
  const total = perimeter(src);
  const m = src.length / 2;
  const out: number[] = [];
  let seg = 0;
  let segStart = 0;
  let segLen = Math.hypot(src[2] - src[0], src[3] - src[1]);
  for (let i = 0; i < n; i++) {
    const target = (total * i) / n;
    while (segStart + segLen < target && seg < m - 1) {
      segStart += segLen;
      seg++;
      const j = (seg + 1) % m;
      segLen = Math.hypot(src[j * 2] - src[seg * 2], src[j * 2 + 1] - src[seg * 2 + 1]);
    }
    const t = segLen > 0 ? (target - segStart) / segLen : 0;
    const j = (seg + 1) % m;
    out.push(
      src[seg * 2] + (src[j * 2] - src[seg * 2]) * t,
      src[seg * 2 + 1] + (src[j * 2 + 1] - src[seg * 2 + 1]) * t,
    );
  }
  // rotate so index 0 is the topmost point — a stable anchor across every shape
  let top = 0;
  for (let i = 1; i < n; i++) if (out[i * 2 + 1] < out[top * 2 + 1]) top = i;
  const rot: number[] = [];
  for (let i = 0; i < n; i++) {
    const k = (top + i) % n;
    rot.push(out[k * 2], out[k * 2 + 1]);
  }
  return rot;
}

/**
 * Linear blend of two resampled outlines. `t` in [0,1]. The endpoints are copied
 * rather than computed so that a finished morph is bit-identical to the target
 * shape — otherwise a settled object jitters by a float epsilon forever.
 */
export function morphOutline(a: Poly, b: Poly, t: number, into?: Poly): Poly {
  const out = into ?? new Array(a.length);
  if (t <= 0) { for (let i = 0; i < a.length; i++) out[i] = a[i]; return out; }
  if (t >= 1) { for (let i = 0; i < b.length; i++) out[i] = b[i]; return out; }
  for (let i = 0; i < a.length; i++) out[i] = a[i] + (b[i] - a[i]) * t;
  return out;
}

export function mixColor(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const r = Math.round((pa >> 16) + (((pb >> 16) & 255) - (pa >> 16)) * t);
  const g = Math.round(((pa >> 8) & 255) + ((((pb >> 8) & 255) - ((pa >> 8) & 255)) * t));
  const bl = Math.round((pa & 255) + (((pb & 255) - (pa & 255)) * t));
  return `rgb(${r},${g},${bl})`;
}

// ---------------------------------------------------------------------------
// the 25 objects
// ---------------------------------------------------------------------------

interface RawShape { outline: Poly; extras?: Poly[]; marks?: Mark[] }

const RAW: Record<string, RawShape> = {
  // --- the ladder: junk, then a fastener, then a mechanism, then a landmark ---
  offcut: {
    outline: [-0.85, -0.28, -0.32, -0.82, 0.12, -0.54, 0.56, -0.86, 0.86, -0.12,
      0.44, 0.24, 0.72, 0.7, 0.06, 0.54, -0.36, 0.86, -0.58, 0.2],
    marks: [{ kind: 'line', pts: [-0.3, -0.1, 0.12, 0.16], w: 0.09 }],
  },
  bolt: {
    outline: [-0.3, -0.95, 0.3, -0.95, 0.62, -0.5, 0.3, -0.05, 0.26, -0.05,
      0.26, 0.92, -0.26, 0.92, -0.26, -0.05, -0.3, -0.05, -0.62, -0.5],
    marks: [
      { kind: 'line', pts: [-0.26, 0.22, 0.26, 0.32], w: 0.08 },
      { kind: 'line', pts: [-0.26, 0.5, 0.26, 0.6], w: 0.08 },
    ],
  },
  gear: {
    outline: cog(9, 0.98, 0.66),
    marks: [{ kind: 'hole', pts: [0, 0, 0.3] }],
  },
  pump: {
    outline: [-0.78, -0.14, 0.02, -0.14, 0.02, -0.86, 0.86, -0.86, 0.86, -0.36,
      0.44, -0.36, 0.44, 0.88, -0.78, 0.88],
    marks: [{ kind: 'hole', pts: [-0.18, 0.36, 0.3] }, { kind: 'line', pts: [-0.7, 0.04, 0.36, 0.04], w: 0.09 }],
  },
  engine: {
    outline: [-0.92, 0.72, -0.92, -0.3, -0.6, -0.3, -0.6, -0.92, -0.3, -0.92, -0.3, -0.3,
      -0.15, -0.3, -0.15, -0.92, 0.15, -0.92, 0.15, -0.3,
      0.3, -0.3, 0.3, -0.92, 0.6, -0.92, 0.6, -0.3, 0.92, -0.3, 0.92, 0.72,
      0.98, 0.72, 0.98, 0.92, -0.98, 0.92, -0.98, 0.72],
    marks: [
      { kind: 'line', pts: [-0.76, 0.12, 0.76, 0.12], w: 0.11 },
      { kind: 'dot', pts: [-0.45, 0.44, 0.12] },
      { kind: 'dot', pts: [0.45, 0.44, 0.12] },
    ],
  },
  reactor: {
    outline: [-0.74, 0.92, -0.4, -0.08, -0.56, -0.72, -0.64, -0.96,
      0.64, -0.96, 0.56, -0.72, 0.4, -0.08, 0.74, 0.92],
    marks: [{ kind: 'hole', pts: [0, 0.34, 0.24] }, { kind: 'dot', pts: [0, -0.5, 0.1] }],
  },
  monument: {
    outline: [-0.1, -0.98, 0.1, -0.98, 0.1, -0.72, 0.3, -0.72, 0.3, -0.42, 0.55, -0.42,
      0.55, -0.1, 0.78, -0.1, 0.78, 0.3, 0.95, 0.3, 0.95, 0.9,
      -0.95, 0.9, -0.95, 0.3, -0.78, 0.3, -0.78, -0.1, -0.55, -0.1,
      -0.55, -0.42, -0.3, -0.42, -0.3, -0.72, -0.1, -0.72],
    marks: [
      { kind: 'line', pts: [-0.5, 0.62, 0.5, 0.62], w: 0.1 },
      { kind: 'dot', pts: [0, -0.62, 0.11] },
    ],
  },

  // --- metal ---------------------------------------------------------------
  rivet: {
    outline: arc(0, 0.05, 0.78, Math.PI, Math.PI * 2, 18).concat([0.3, 0.05, 0.3, 0.92, -0.3, 0.92, -0.3, 0.05]),
    marks: [{ kind: 'line', pts: [-0.4, -0.2, 0.1, -0.42], w: 0.1 }],
  },
  ingot: {
    outline: [-0.95, 0.6, -0.66, -0.24, 0.66, -0.24, 0.95, 0.6],
    extras: [[-0.66, -0.24, -0.44, -0.62, 0.86, -0.62, 0.66, -0.24]],
    marks: [{ kind: 'line', pts: [-0.6, 0.24, 0.6, 0.24], w: 0.09 }],
  },
  anvil: {
    outline: [-0.92, -0.6, 0.5, -0.6, 0.96, -0.32, 0.5, -0.16, 0.28, -0.16,
      0.24, 0.22, 0.56, 0.58, 0.56, 0.88, -0.56, 0.88, -0.56, 0.58,
      -0.24, 0.22, -0.28, -0.16, -0.92, -0.3],
    marks: [{ kind: 'line', pts: [-0.8, -0.38, 0.3, -0.38], w: 0.08 }],
  },

  // --- precision -----------------------------------------------------------
  lens: {
    outline: arc(-0.55, 0, 1.05, -Math.PI / 2.6, Math.PI / 2.6, 14)
      .concat(arc(0.55, 0, 1.05, Math.PI - Math.PI / 2.6, Math.PI + Math.PI / 2.6, 14)),
    marks: [{ kind: 'line', pts: [-0.1, -0.42, 0.22, -0.16], w: 0.1 }],
  },
  micrometer: {
    outline: arc(0, 0, 0.96, -Math.PI * 0.42, Math.PI * 1.28, 22)
      .concat(arc(0, 0, 0.52, Math.PI * 1.28, -Math.PI * 0.42, 22)),
    extras: [[0.3, -0.92, 0.98, -0.92, 0.98, -0.66, 0.3, -0.66]],
    marks: [{ kind: 'dot', pts: [0.62, 0.5, 0.12] }],
  },
  governor: {
    outline: [-0.07, -0.96, 0.07, -0.96, 0.07, -0.34, 0.86, 0.34, 0.72, 0.6,
      0.0, 0.1, -0.72, 0.6, -0.86, 0.34, -0.07, -0.34],
    extras: [circlePoly(-0.78, 0.52, 0.28), circlePoly(0.78, 0.52, 0.28)],
    marks: [{ kind: 'dot', pts: [0, -0.72, 0.1] }],
  },

  // --- volatile ------------------------------------------------------------
  cell: {
    outline: [-0.2, -0.96, 0.2, -0.96, 0.2, -0.76, 0.62, -0.76, 0.62, 0.9,
      -0.62, 0.9, -0.62, -0.76, -0.2, -0.76],
    marks: [
      { kind: 'line', pts: [-0.3, -0.2, 0.3, -0.2], w: 0.12 },
      { kind: 'line', pts: [0, -0.5, 0, 0.1], w: 0.12 },
      { kind: 'line', pts: [-0.3, 0.5, 0.3, 0.5], w: 0.12 },
    ],
  },
  fuse_wire: {
    outline: [0.3, -0.96, -0.58, 0.06, -0.06, 0.06, -0.36, 0.96, 0.62, -0.16, 0.1, -0.16],
    marks: [{ kind: 'line', pts: [-0.02, -0.4, 0.16, -0.6], w: 0.09 }],
  },
  flask: {
    outline: [-0.22, -0.95, 0.22, -0.95, 0.22, -0.34, 0.82, 0.86, -0.82, 0.86, -0.22, -0.34],
    marks: [
      { kind: 'line', pts: [-0.52, 0.34, 0.52, 0.34], w: 0.09 },
      { kind: 'dot', pts: [0.16, 0.6, 0.1] },
    ],
  },
  plasma_can: {
    outline: [-0.3, -0.96, 0.3, -0.96, 0.3, -0.72, 0.64, -0.54, 0.64, 0.7,
      0.3, 0.92, -0.3, 0.92, -0.64, 0.7, -0.64, -0.54, -0.3, -0.72],
    marks: [
      { kind: 'line', pts: [0, -0.36, 0.36, 0.3, -0.36, 0.3, 0, -0.36], w: 0.11 },
      { kind: 'dot', pts: [0, 0.06, 0.1] },
    ],
  },

  // --- organic -------------------------------------------------------------
  gasket: {
    outline: circlePoly(0, 0, 0.94, 30),
    marks: [
      { kind: 'hole', pts: [0, 0, 0.46] },
      { kind: 'dot', pts: [0, -0.72, 0.09] },
      { kind: 'dot', pts: [0.68, 0.24, 0.09] },
      { kind: 'dot', pts: [-0.68, 0.24, 0.09] },
    ],
  },
  hide: {
    outline: [0.0, -0.92, 0.42, -0.78, 0.62, -0.88, 0.7, -0.52, 0.92, -0.2,
      0.72, 0.16, 0.86, 0.64, 0.46, 0.52, 0.16, 0.9, -0.16, 0.9, -0.46, 0.52,
      -0.86, 0.64, -0.72, 0.16, -0.92, -0.2, -0.7, -0.52, -0.62, -0.88, -0.42, -0.78],
    marks: [{ kind: 'dot', pts: [-0.14, -0.1, 0.13] }, { kind: 'dot', pts: [0.26, 0.2, 0.1] }],
  },
  fish: {
    outline: [-0.96, -0.62, -0.5, -0.08, -0.2, -0.56, 0.3, -0.5, 0.78, -0.14,
      0.96, 0.04, 0.78, 0.24, 0.3, 0.56, -0.2, 0.52, -0.5, 0.08, -0.96, 0.62],
    marks: [{ kind: 'dot', pts: [0.56, -0.04, 0.11] }, { kind: 'line', pts: [-0.1, 0.06, 0.3, 0.06], w: 0.08 }],
  },
  heartwood: {
    outline: circlePoly(0, 0, 0.92, 26),
    marks: [
      { kind: 'line', pts: ringMark(0.66), w: 0.07 },
      { kind: 'line', pts: ringMark(0.38, 16), w: 0.07 },
      { kind: 'dot', pts: [0, 0, 0.11] },
    ],
  },

  // --- scrap ---------------------------------------------------------------
  dust: {
    outline: [-0.42, -0.5, 0.0, -0.72, 0.44, -0.44, 0.36, 0.0, 0.62, 0.34,
      0.1, 0.5, -0.34, 0.42, -0.5, 0.02],
    extras: [circlePoly(-0.74, 0.6, 0.17, 10), circlePoly(0.76, -0.62, 0.14, 10), circlePoly(0.66, 0.72, 0.11, 10)],
    marks: [{ kind: 'dot', pts: [0, -0.06, 0.1] }],
  },
  swarf: {
    outline: ribbon(1.3, 1.0, 0.44, 0.6, 0.02, 40),
    marks: [],
  },
  slag: {
    outline: [-0.9, -0.2, -0.5, -0.7, 0.0, -0.58, 0.42, -0.9, 0.86, -0.4,
      0.72, 0.06, 0.92, 0.5, 0.34, 0.62, -0.1, 0.9, -0.56, 0.5, -0.86, 0.24],
    marks: [
      { kind: 'hole', pts: [-0.3, -0.06, 0.19] },
      { kind: 'hole', pts: [0.34, 0.16, 0.14] },
    ],
  },
  cursed_doll: {
    outline: [-0.17, -0.36, 0.17, -0.36, 0.17, -0.1, 0.82, -0.1, 0.82, 0.14,
      0.17, 0.14, 0.17, 0.42, 0.46, 0.94, 0.13, 0.94, 0.0, 0.6,
      -0.13, 0.94, -0.46, 0.94, -0.17, 0.42, -0.17, 0.14, -0.82, 0.14,
      -0.82, -0.1, -0.17, -0.1],
    extras: [circlePoly(0, -0.62, 0.32, 16)],
    marks: [
      { kind: 'line', pts: [-0.2, -0.78, -0.06, -0.62], w: 0.07 },
      { kind: 'line', pts: [-0.06, -0.78, -0.2, -0.62], w: 0.07 },
      { kind: 'line', pts: [0.06, -0.78, 0.2, -0.62], w: 0.07 },
      { kind: 'line', pts: [0.2, -0.78, 0.06, -0.62], w: 0.07 },
    ],
  },
};

/** Fallback for any part def that somehow has no drawing — a blank crate token. */
const FALLBACK: RawShape = {
  outline: [-0.8, -0.7, 0.8, -0.7, 0.8, 0.7, -0.8, 0.7],
  marks: [{ kind: 'line', pts: [-0.5, 0, 0.5, 0], w: 0.1 }],
};

const CACHE = new Map<string, Silhouette>();

export function silhouette(def: string): Silhouette {
  const hit = CACHE.get(def);
  if (hit !== undefined) return hit;
  const raw = RAW[def] ?? FALLBACK;
  const s: Silhouette = {
    def,
    outline: resample(raw.outline, OUTLINE_POINTS),
    extras: raw.extras ?? [],
    marks: raw.marks ?? [],
  };
  CACHE.set(def, s);
  return s;
}

/** Every def this file draws by hand — the content test checks parts.ts against it. */
export const DRAWN_DEFS: string[] = Object.keys(RAW);

/**
 * Archetype BADGES. A glyph can only ever say what family a machine belongs to —
 * Press and Doubler are both arithmetic, so an icon can never tell them apart. So the
 * badge is deliberately demoted to a family tag (shape + colour) and the machine's
 * NAME does the identifying work everywhere it is drawn.
 */
export const ARCHETYPE_BADGE: Record<string, Poly> = {
  arithmetic: [-0.78, -0.78, 0.78, -0.78, 0.78, 0.78, -0.78, 0.78],
  positional: [0, -1, 1, 0, 0, 1, -1, 0],
  filter: [-0.98, -0.76, 0.98, -0.76, 0, 0.92],
  generative: circlePoly(0, 0, 0.92, 18),
  conditional: [0, -0.98, 0.85, -0.49, 0.85, 0.49, 0, 0.98, -0.85, 0.49, -0.85, -0.49],
  economic: [0, -0.98, 0.93, -0.3, 0.58, 0.8, -0.58, 0.8, -0.93, -0.3],
  transmutation: [0, -0.95, 0.95, 0.78, -0.95, 0.78],
};

/** Text glyphs for the DOM chrome, where a one-character tag is all that fits. */
export const ARCHETYPE_GLYPH: Record<string, string> = {
  arithmetic: '+',
  positional: '⇄',
  filter: '▽',
  generative: '✳',
  conditional: '?',
  economic: '¢',
  transmutation: '△',
};

export const ARCHETYPE_COLOR: Record<string, string> = {
  arithmetic: '#98a2ad',
  positional: '#79c0d8',
  filter: '#e8433f',
  generative: '#6fbf73',
  conditional: '#ffc53d',
  economic: '#ff7a2f',
  transmutation: '#c98ae0',
};
