// TAKT — canvas primitives. Flat fills, one ink outline, no gradients.
//
// Everything here draws a *silhouette*: a filled polygon plus a darker outline plus
// a couple of ink marks. That is the whole art direction, and it is what lets a part
// morph into another part — a shape can be interpolated, a sprite cannot.

import type { Mark, Poly } from './art.ts';
import { PALETTE, morphOutline, silhouette } from './art.ts';

export function font(px: number, weight = 900): string {
  return `${weight} ${px}px ui-sans-serif, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`;
}

export function poly(ctx: CanvasRenderingContext2D, pts: readonly number[], s: number, x: number, y: number): void {
  ctx.beginPath();
  ctx.moveTo(x + pts[0] * s, y + pts[1] * s);
  for (let i = 2; i < pts.length; i += 2) ctx.lineTo(x + pts[i] * s, y + pts[i + 1] * s);
  ctx.closePath();
}

function drawMark(ctx: CanvasRenderingContext2D, m: Mark, s: number, x: number, y: number, ink: string, bg: string): void {
  if (m.kind === 'hole' || m.kind === 'dot') {
    ctx.beginPath();
    ctx.arc(x + m.pts[0] * s, y + m.pts[1] * s, Math.max(0.6, m.pts[2] * s), 0, Math.PI * 2);
    ctx.fillStyle = m.kind === 'hole' ? bg : ink;
    ctx.fill();
    return;
  }
  ctx.strokeStyle = ink;
  ctx.lineWidth = Math.max(1, (m.w ?? 0.08) * s);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(x + m.pts[0] * s, y + m.pts[1] * s);
  for (let i = 2; i < m.pts.length; i += 2) ctx.lineTo(x + m.pts[i] * s, y + m.pts[i + 1] * s);
  ctx.stroke();
}

const scratch: Poly = [];

export interface TokenPaint {
  defFrom: string;
  defTo: string;
  /** 0 = defFrom, 1 = defTo. Anything between is a live transmutation. */
  t: number;
  color: string;
  x: number;
  y: number;
  /** radius in px of the object's [-1,1] box */
  size: number;
  alpha: number;
  rot: number;
  /** a bright rim, used while a machine is acting on this part */
  glow: number;
}

/**
 * Draw one object on the belt. When `t` is strictly between 0 and 1 the outline is
 * the point-for-point blend of two silhouettes, so an Offcut visibly *becomes* a
 * Bolt instead of being replaced by one.
 */
export function drawToken(ctx: CanvasRenderingContext2D, tk: TokenPaint): void {
  const a = silhouette(tk.defFrom);
  const b = silhouette(tk.defTo);
  const t = tk.t <= 0 ? 0 : tk.t >= 1 ? 1 : tk.t;
  const out = t === 0 ? a.outline : t === 1 ? b.outline : morphOutline(a.outline, b.outline, t, scratch);

  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, tk.alpha));
  ctx.translate(tk.x, tk.y);
  if (tk.rot !== 0) ctx.rotate(tk.rot);

  if (tk.glow > 0.01) {
    ctx.strokeStyle = PALETTE.cream;
    ctx.globalAlpha = Math.min(1, tk.alpha) * tk.glow * 0.85;
    ctx.lineWidth = 6 + 10 * tk.glow;
    poly(ctx, out, tk.size, 0, 0);
    ctx.stroke();
    ctx.globalAlpha = Math.max(0, Math.min(1, tk.alpha));
  }

  ctx.fillStyle = tk.color;
  poly(ctx, out, tk.size, 0, 0);
  ctx.fill();
  ctx.strokeStyle = PALETTE.ink;
  ctx.lineWidth = Math.max(1.5, tk.size * 0.11);
  ctx.lineJoin = 'round';
  ctx.stroke();

  // Extras and ink marks belong to whichever silhouette is currently dominant;
  // they cross-fade rather than morph, which reads as detail settling into place.
  const src = t < 0.5 ? a : b;
  const fade = t < 0.5 ? 1 - t * 2 : (t - 0.5) * 2;
  ctx.globalAlpha = Math.max(0, Math.min(1, tk.alpha)) * (t === 0 || t === 1 ? 1 : fade);
  for (const ex of src.extras) {
    ctx.fillStyle = tk.color;
    poly(ctx, ex, tk.size, 0, 0);
    ctx.fill();
    ctx.strokeStyle = PALETTE.ink;
    ctx.lineWidth = Math.max(1.5, tk.size * 0.11);
    ctx.stroke();
  }
  for (const m of src.marks) drawMark(ctx, m, tk.size, 0, 0, PALETTE.ink, PALETTE.bg);
  ctx.restore();
}

export function roundRect(
  ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number,
): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

export function textCenter(
  ctx: CanvasRenderingContext2D, s: string, x: number, y: number, px: number,
  color: string, weight = 900,
): void {
  ctx.font = font(px, weight);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = color;
  ctx.fillText(s, x, y);
}

/** A part's number tag: the value and, when it is not 1, the multiplier. */
export function drawValueTag(
  ctx: CanvasRenderingContext2D, x: number, y: number, value: string, mult: string | null, px: number,
): void {
  ctx.font = font(px, 900);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const wv = ctx.measureText(value).width;
  const wm = mult === null ? 0 : ctx.measureText(mult).width + px * 0.55;
  const w = wv + wm + px * 0.9;
  const h = px * 1.5;
  ctx.fillStyle = PALETTE.ink;
  roundRect(ctx, x - w / 2, y - h / 2, w, h, h / 2);
  ctx.fill();
  ctx.fillStyle = PALETTE.cream;
  ctx.fillText(value, x - w / 2 + px * 0.45 + wv / 2, y + px * 0.05);
  if (mult !== null) {
    ctx.fillStyle = PALETTE.accent;
    ctx.fillText(mult, x + w / 2 - px * 0.45 - (wm - px * 0.55) / 2, y + px * 0.05);
  }
}
