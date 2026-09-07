// TAKT — the conveyor.
//
// This file is the product. Everything else is chrome around it.
//
// A shipment is not a number appearing; it is a pass down the line. The camera
// travels with the batch, each machine pops as it fires, the batch VISIBLY changes
// in front of that machine — a part promotes, splits, moves, vanishes — and the
// shipment total ticks up beside it. When the batch reaches the end, one object
// arrives in the crate, big, with its name. That object is the payoff.
//
// The renderer owns no game state and makes no decisions: it consumes a `Reel` from
// vm.ts and interpolates. Anything you can see here, you can assert on there.

import type { Beat, PartChange, PartSnap, Reel } from './vm.ts';
import { fmt, fmtMult } from './vm.ts';
import { ARCHETYPE_COLOR, ARCHETYPE_GLYPH, PALETTE, TIER_COLORS, colorOf, mixColor } from './art.ts';
import { drawToken, drawValueTag, font, roundRect, textCenter } from './draw.ts';
import { TIER_LADDER } from '../../src/content/parts.ts';

const STEP = 208;            // world distance between stations
const TRANSIT = 0.42;        // fraction of a beat spent travelling to the machine

function ease(t: number): number { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }
function easeOut(t: number): number { return 1 - Math.pow(1 - t, 3); }
function clamp01(t: number): number { return t < 0 ? 0 : t > 1 ? 1 : t; }

export interface StationView {
  name: string;
  archetype: string;
  level: number;
  gamble: boolean;
  dim?: boolean;
}

export type StageMode = 'idle' | 'play' | 'attract';

interface Shake { t: number; mag: number }

export class Stage {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private w = 0;
  private h = 0;
  private dpr = 1;

  mode: StageMode = 'idle';
  private stations: StationView[] = [];
  private idleBatch: PartSnap[] = [];
  private reel: Reel | null = null;
  private t = 0;
  private speed = 1;
  private camX = 0;
  private camInit = false;
  private shake: Shake = { t: 0, mag: 0 };
  private beltScroll = 0;
  private attractT = 0;
  private last = 0;
  private raf = 0;
  private running = false;

  /** called once the crate beat has finished */
  onDone: (() => void) | null = null;
  /** called each frame while playing, with the shipment total currently on screen */
  onTick: ((shown: number) => void) | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const c = canvas.getContext('2d', { alpha: false });
    if (c === null) throw new Error('no 2d context');
    this.ctx = c;
    this.resize();
  }

  resize(): void {
    const r = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.w = Math.max(240, Math.round(r.width));
    this.h = Math.max(160, Math.round(r.height));
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    const loop = (now: number): void => {
      if (!this.running) return;
      // clamp: a backwards or enormous dt (tab restore, clock skew) must never
      // be able to run the reel backwards or skip a beat outright
      const dt = Math.max(0, Math.min(64, now - this.last));
      this.last = now;
      this.step(dt);
      this.draw();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    this.running = false;
    if (this.raf !== 0) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  /** The resting view: the line as it stands, with the chosen batch waiting at intake. */
  showIdle(stations: StationView[], batch: PartSnap[]): void {
    this.mode = 'idle';
    this.stations = stations;
    this.idleBatch = batch;
    this.reel = null;
  }

  showAttract(stations: StationView[]): void {
    this.mode = 'attract';
    this.stations = stations;
    this.reel = null;
  }

  play(reel: Reel, stations: StationView[]): void {
    this.mode = 'play';
    this.reel = reel;
    this.stations = stations;
    this.t = 0;
    this.speed = 1;
    this.camInit = false;
  }

  /** Tap during a shipment: hurry it along without losing the readability of it. */
  faster(): void { this.speed = this.speed >= 3 ? 5 : 3; }

  /** Hold during a shipment: jump straight to the object landing in the crate. */
  skipToCrate(): void {
    const r = this.reel;
    if (r === null) return;
    this.t = Math.max(this.t, r.lineMs);
    this.speed = Math.max(this.speed, 2);
  }

  get playing(): boolean { return this.mode === 'play' && this.reel !== null; }

  // -------------------------------------------------------------------------

  private step(dt: number): void {
    this.beltScroll = (this.beltScroll + dt * 0.045) % 28;
    if (this.shake.t > 0) this.shake.t = Math.max(0, this.shake.t - dt);
    if (this.mode === 'attract') { this.attractT += dt; return; }
    const r = this.reel;
    if (this.mode !== 'play' || r === null) return;

    const before = this.t;
    this.t += dt * this.speed;

    // fire the shake exactly once, as each dramatic beat lands
    for (const b of r.beats) {
      const at = b.startMs + (b.durationMs - b.holdMs) * TRANSIT + b.holdMs;
      if (before < at && this.t >= at) {
        if (b.drama === 'gamble') this.kick(b.delta >= 0 ? 10 : 7);
        else if (b.drama === 'big') this.kick(5);
      }
    }
    if (this.t >= r.totalMs) {
      this.t = r.totalMs;
      this.mode = 'idle';
      const cb = this.onDone;
      this.onDone = null;
      if (cb !== null) cb();
    }
  }

  private kick(mag: number): void { this.shake = { t: 190, mag }; }

  private beatAt(ms: number): Beat {
    const r = this.reel as Reel;
    const bs = r.beats;
    for (let i = 0; i < bs.length; i++) {
      if (ms < bs[i].startMs + bs[i].durationMs) return bs[i];
    }
    return bs[bs.length - 1];
  }

  private stationX(i: number): number { return i * STEP; }

  private spacing(n: number): number { return n <= 3 ? 64 : n <= 5 ? 54 : n <= 8 ? 42 : 32; }

  private slotX(station: number, idx: number, n: number): number {
    return this.stationX(station) + (idx - (n - 1) / 2) * this.spacing(n);
  }

  // -------------------------------------------------------------------------

  private draw(): void {
    const ctx = this.ctx;
    ctx.fillStyle = PALETTE.bg;
    ctx.fillRect(0, 0, this.w, this.h);
    if (this.mode === 'attract') { this.drawAttract(); return; }
    // At rest the player is THINKING, so the whole line has to be on screen at once,
    // compact and legible. Only during a shipment does the camera drop down to the
    // belt and travel with the batch.
    if (this.mode !== 'play' || this.reel === null) { this.drawIdle(); return; }

    const r = this.reel;
    const beltY = Math.round(this.h * 0.66);
    const size = Math.max(15, Math.min(30, this.h * 0.085));

    let focusStation = 0;
    let beat: Beat | null = null;
    let u = 0;
    if (this.mode === 'play' && r !== null) {
      beat = this.beatAt(this.t);
      u = this.t - beat.startMs;
      focusStation = beat.index;
    }

    const targetCam = this.stationX(focusStation);
    if (!this.camInit) { this.camX = targetCam; this.camInit = true; }
    else this.camX += (targetCam - this.camX) * 0.16;

    const shakeK = this.shake.t > 0 ? (this.shake.t / 190) * this.shake.mag : 0;
    const ox = Math.round(this.w * 0.5 - this.camX + (shakeK > 0 ? (Math.random() - 0.5) * shakeK * 2 : 0));
    const oy = shakeK > 0 ? (Math.random() - 0.5) * shakeK : 0;

    ctx.save();
    ctx.translate(ox, oy);

    const nStations = this.stations.length + 2; // intake + machines/audit + crate
    this.drawBelt(beltY, ox);
    this.drawIntake(beltY, size);
    for (let i = 0; i < this.stations.length; i++) {
      this.drawMachine(i + 1, this.stations[i], beltY, beat, u);
    }
    this.drawCrate(nStations - 1, beltY, beat, u);

    if (beat !== null) this.drawBatch(r, beat, u, beltY, size);

    ctx.restore();

    if (beat !== null) this.drawPlayHud(r, beat, u, beltY, size);
  }

  // -------------------------------------------------------------------------
  // the resting view: the whole line as a schematic, the chosen batch above it
  // -------------------------------------------------------------------------

  private drawIdle(): void {
    const ctx = this.ctx;
    const b = this.idleBatch;
    const rowY = Math.round(this.h * 0.72);

    textCenter(ctx, 'THE LINE — LEFT TO RIGHT', this.w * 0.5, 16, 11, PALETTE.dim);

    if (b.length === 0) {
      textCenter(ctx, 'TAP PARTS BELOW', this.w * 0.5, this.h * 0.34, 15, PALETTE.dim);
      textCenter(ctx, 'the order you tap is the order they enter', this.w * 0.5, this.h * 0.34 + 22, 12, PALETTE.line);
    } else {
      const size = Math.min(this.h * 0.13, (this.w - 30) / (b.length * 2.5));
      const gap = size * 2.4;
      const y = this.h * 0.36;
      for (let i = 0; i < b.length; i++) {
        const p = b[i];
        const x = this.w * 0.5 + (i - (b.length - 1) / 2) * gap;
        drawToken(ctx, {
          defFrom: p.def, defTo: p.def, t: 0, color: colorOf(p.def, p.tags),
          x, y, size, alpha: 1, rot: 0, glow: 0,
        });
        drawValueTag(ctx, x, y + size * 1.4, fmt(p.value),
          Math.abs(p.mult - 1) > 0.001 ? fmtMult(p.mult) : null, Math.max(9, size * 0.42));
        ctx.fillStyle = PALETTE.accent;
        ctx.beginPath();
        ctx.arc(x - size * 0.92, y - size * 0.92, 9, 0, Math.PI * 2);
        ctx.fill();
        textCenter(ctx, String(i + 1), x - size * 0.92, y - size * 0.92, 11, '#1a0c02');
      }
    }

    this.drawSchematic(rowY);
  }

  /** intake ▸ machine ▸ machine ▸ … ▸ crate, sized to fit whatever the line is */
  private drawSchematic(y: number): void {
    const ctx = this.ctx;
    const n = this.stations.length + 2;
    const pad = 8;
    const cell = (this.w - pad * 2) / n;
    const bw = Math.min(cell - 6, 74);
    const bh = Math.min(46, this.h * 0.19);

    for (let i = 0; i < n; i++) {
      const cx = pad + cell * (i + 0.5);
      if (i > 0) {
        textCenter(ctx, '▸', pad + cell * i, y, Math.min(14, cell * 0.28), PALETTE.line);
      }
      if (i === 0 || i === n - 1) {
        ctx.fillStyle = PALETTE.panel;
        roundRect(ctx, cx - bw / 2, y - bh / 2, bw, bh, 7);
        ctx.fill();
        ctx.strokeStyle = PALETTE.line;
        ctx.lineWidth = 2;
        ctx.stroke();
        textCenter(ctx, i === 0 ? 'IN' : 'CRATE', cx, y, Math.min(12, bw * 0.24), PALETTE.dim);
        continue;
      }
      const st = this.stations[i - 1];
      const accent = ARCHETYPE_COLOR[st.archetype] ?? PALETTE.dim;
      ctx.save();
      ctx.globalAlpha = st.dim === true ? 0.4 : 1;
      ctx.fillStyle = PALETTE.panel;
      roundRect(ctx, cx - bw / 2, y - bh / 2, bw, bh, 7);
      ctx.fill();
      ctx.strokeStyle = st.gamble ? PALETTE.gold : PALETTE.line;
      ctx.lineWidth = 2;
      ctx.stroke();
      textCenter(ctx, ARCHETYPE_GLYPH[st.archetype] ?? '+', cx, y - bh * 0.12, Math.min(20, bw * 0.34), accent);
      textCenter(ctx, String(i), cx - bw / 2 + 9, y - bh / 2 + 9, 9, PALETTE.dim);
      if (st.level > 1) textCenter(ctx, `L${st.level}`, cx + bw / 2 - 10, y - bh / 2 + 9, 9, PALETTE.gold);
      ctx.restore();
      const name = st.name.length > 9 ? st.name.slice(0, 8) + '…' : st.name;
      textCenter(ctx, name.toUpperCase(), cx, y + bh / 2 + 10, Math.min(10, bw * 0.19),
        st.dim === true ? PALETTE.line : PALETTE.dim);
    }
  }

  private drawBelt(beltY: number, ox: number): void {
    const ctx = this.ctx;
    const x0 = -ox - 60;
    const x1 = -ox + this.w + 60;
    ctx.fillStyle = PALETTE.panel;
    ctx.fillRect(x0, beltY, x1 - x0, 16);
    ctx.strokeStyle = PALETTE.line;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x0, beltY + 0.5);
    ctx.lineTo(x1, beltY + 0.5);
    ctx.stroke();
    ctx.strokeStyle = PALETTE.line;
    ctx.lineWidth = 3;
    ctx.beginPath();
    const start = Math.floor(x0 / 28) * 28 + this.beltScroll;
    for (let x = start; x < x1; x += 28) {
      ctx.moveTo(x, beltY + 13);
      ctx.lineTo(x + 7, beltY + 4);
      ctx.lineTo(x + 14, beltY + 13);
    }
    ctx.stroke();
  }

  private drawIntake(beltY: number, size: number): void {
    const ctx = this.ctx;
    const x = this.stationX(0);
    ctx.fillStyle = PALETTE.panel;
    roundRect(ctx, x - 46, beltY - 74, 92, 74, 8);
    ctx.fill();
    ctx.strokeStyle = PALETTE.line;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = PALETTE.bg;
    ctx.fillRect(x - 34, beltY - 62, 68, 50);
    textCenter(ctx, 'INTAKE', x, beltY + 30, 11, PALETTE.dim);
  }

  private drawMachine(station: number, st: StationView, beltY: number, beat: Beat | null, u: number): void {
    const ctx = this.ctx;
    const x = this.stationX(station);
    const active = beat !== null && beat.index === station;
    const dur = beat !== null ? beat.durationMs : 1;
    const hold = beat !== null ? beat.holdMs : 0;
    const fireAt = beat !== null ? (dur - hold) * TRANSIT : 0;
    const fired = active && u >= fireAt;
    const sinceFire = fired ? u - fireAt : 0;
    const holding = active && hold > 0 && sinceFire < hold;

    let pop = 0;
    if (fired && !holding) {
      const p = clamp01((sinceFire - hold) / 260);
      pop = Math.sin(p * Math.PI) * (beat !== null && beat.drama === 'big' ? 1 : 0.6);
    }
    if (holding) pop = 0.18 + 0.18 * Math.sin(sinceFire / 55);

    // the block has to shrink on a short viewport or its label collides with the HUD
    const bw = Math.min(104, this.h * 0.36) + pop * 14;
    const bh = Math.min(86, this.h * 0.3) + pop * 12;
    const accent = ARCHETYPE_COLOR[st.archetype] ?? PALETTE.dim;
    const on = active && fired;

    ctx.save();
    ctx.globalAlpha = st.dim === true ? 0.45 : 1;
    ctx.fillStyle = on ? mixColor(PALETTE.panelHi, accent, 0.5) : PALETTE.panel;
    roundRect(ctx, x - bw / 2, beltY - bh + 12, bw, bh, 10);
    ctx.fill();
    ctx.strokeStyle = on ? PALETTE.cream : PALETTE.line;
    ctx.lineWidth = on ? 3 : 2;
    ctx.stroke();

    // legs, so it reads as machinery standing over the belt
    ctx.fillStyle = PALETTE.panel;
    ctx.fillRect(x - bw / 2 + 8, beltY + 10, 10, 16);
    ctx.fillRect(x + bw / 2 - 18, beltY + 10, 10, 16);

    const glyph = ARCHETYPE_GLYPH[st.archetype] ?? '+';
    textCenter(ctx, holding ? '?' : glyph, x, beltY - bh + 44, holding ? 40 : 34, on ? PALETTE.cream : accent);
    ctx.globalAlpha = st.dim === true ? 0.45 : 1;
    textCenter(ctx, st.name.toUpperCase(), x, beltY - bh - 4, 12, on ? PALETTE.cream : PALETTE.dim);
    if (st.level > 1) {
      textCenter(ctx, `LV${st.level}`, x + bw / 2 - 16, beltY - bh + 22, 10, PALETTE.gold);
    }
    if (st.gamble) {
      textCenter(ctx, '◆', x - bw / 2 + 14, beltY - bh + 22, 12, PALETTE.gold);
    }
    ctx.restore();

    if (active && fired && beat !== null && beat.fired && !holding) {
      this.drawRuleCard(x, beltY + 34, beat, clamp01((sinceFire - hold) / 200));
      if (beat.delta !== 0) this.drawDeltaChip(x, beltY - bh - 26, beat.delta, clamp01((sinceFire - hold) / 420));
    }
  }

  private drawRuleCard(x: number, y: number, beat: Beat, k: number): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = k;
    ctx.font = font(12, 700);
    ctx.textAlign = 'center';
    const text = beat.text.length > 46 ? beat.text.slice(0, 44) + '…' : beat.text;
    const w = Math.max(120, ctx.measureText(text).width + 24);
    ctx.fillStyle = PALETTE.panelHi;
    roundRect(ctx, x - w / 2, y + (1 - k) * 8, w, 26, 6);
    ctx.fill();
    ctx.fillStyle = PALETTE.cream;
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x, y + 13 + (1 - k) * 8);
    ctx.restore();
  }

  private drawDeltaChip(x: number, y: number, delta: number, k: number): void {
    const ctx = this.ctx;
    const rise = easeOut(k) * 26;
    ctx.save();
    ctx.globalAlpha = 1 - Math.pow(k, 3);
    textCenter(
      ctx, `${delta >= 0 ? '+' : ''}${fmt(delta)}`, x, y - rise, 22,
      delta >= 0 ? PALETTE.gold : PALETTE.bad,
    );
    ctx.restore();
  }

  private drawCrate(station: number, beltY: number, beat: Beat | null, u: number): void {
    const ctx = this.ctx;
    const x = this.stationX(station);
    const active = beat !== null && beat.kind === 'crate';
    const k = active ? clamp01(u / (beat as Beat).durationMs) : 0;
    ctx.save();
    ctx.fillStyle = active ? PALETTE.panelHi : PALETTE.panel;
    roundRect(ctx, x - 62, beltY - 62, 124, 74, 8);
    ctx.fill();
    ctx.strokeStyle = active && k > 0.4 ? PALETTE.gold : PALETTE.line;
    ctx.lineWidth = active && k > 0.4 ? 3 : 2;
    ctx.stroke();
    ctx.strokeStyle = PALETTE.line;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x - 62, beltY - 34); ctx.lineTo(x + 62, beltY - 34);
    ctx.moveTo(x, beltY - 62); ctx.lineTo(x, beltY - 34);
    ctx.stroke();
    textCenter(ctx, 'CRATE', x, beltY + 30, 11, PALETTE.dim);
    ctx.restore();
  }

  // -------------------------------------------------------------------------
  // the batch
  // -------------------------------------------------------------------------

  /**
   * The batch mid-shipment. Two phases per beat: the parts travel to the machine,
   * then the machine's changes play out on them in place. Every visual here is a
   * direct read of one `PartChange` — which is what makes the animation an
   * explanation and not a light show.
   */
  private drawBatch(r: Reel, beat: Beat, u: number, beltY: number, size: number): void {
    const ctx = this.ctx;
    const y = beltY - size * 1.5 - 6;
    const station = beat.index;
    const dur = beat.durationMs;
    const hold = beat.holdMs;
    const transitDur = Math.max(1, (dur - hold) * TRANSIT);
    const transformDur = Math.max(1, dur - hold - transitDur);

    if (beat.kind === 'entry') {
      const k = ease(clamp01(u / dur));
      const n = beat.after.length;
      for (let i = 0; i < n; i++) {
        const p = beat.after[i];
        const to = this.slotX(0, i, n);
        const from = to - 420 - i * 40;
        this.token(p, p, 0, from + (to - from) * k, y, size, 1, 0);
      }
      return;
    }

    if (beat.kind === 'crate') {
      this.drawCrateFinale(r, beat, u, beltY, size);
      return;
    }

    const nb = beat.before.length;
    const na = beat.after.length;

    if (u < transitDur) {
      const k = ease(clamp01(u / transitDur));
      for (let i = 0; i < nb; i++) {
        const p = beat.before[i];
        const from = this.slotX(station - 1, i, nb);
        const to = this.slotX(station, i, nb);
        this.token(p, p, 0, from + (to - from) * k, y, size, 1, 0);
      }
      return;
    }

    const sinceFire = u - transitDur;
    if (hold > 0 && sinceFire < hold) {
      // the pause before the reveal — the batch sits under the machine, waiting
      const pulse = 0.5 + 0.5 * Math.sin(sinceFire / 60);
      for (let i = 0; i < nb; i++) {
        const p = beat.before[i];
        this.token(p, p, 0, this.slotX(station, i, nb), y, size, 1, pulse * 0.5);
      }
      return;
    }

    const v = ease(clamp01((sinceFire - hold) / transformDur));
    const raw = clamp01((sinceFire - hold) / transformDur);
    for (const c of beat.changes) this.drawChange(c, station, nb, na, v, raw, y, size);
  }

  private drawChange(
    c: PartChange, station: number, nb: number, na: number,
    v: number, raw: number, y: number, size: number,
  ): void {
    const glow = Math.sin(clamp01(raw * 1.6) * Math.PI) * 0.9;

    if (c.op === 'destroy' && c.from !== null) {
      const x = this.slotX(station, c.fromIndex, nb);
      this.token(c.from, c.from, 0, x, y + v * 60, size * (1 - v * 0.5), 1 - v, 0);
      return;
    }
    if (c.op === 'spawn' && c.to !== null) {
      const x = this.slotX(station, c.toIndex, na);
      const pop = v < 0.6 ? v / 0.6 : 1;
      this.token(c.to, c.to, 1, x, y, size * (0.2 + 0.8 * pop), Math.min(1, v * 2), glow);
      return;
    }
    if (c.from === null || c.to === null) return;

    const x0 = this.slotX(station, c.fromIndex, nb);
    const x1 = this.slotX(station, c.toIndex, na);
    const x = x0 + (x1 - x0) * v;

    const morphing = c.from.def !== c.to.def;
    // a promotion gets a scale kick; a corruption gets a squash
    let s = size;
    if (morphing) {
      const kick = Math.sin(clamp01(raw) * Math.PI);
      s = size * (1 + kick * (c.tierDelta >= 0 ? 0.42 : -0.24));
    } else if (c.op === 'gainMult' || c.op === 'gain') {
      s = size * (1 + Math.sin(clamp01(raw) * Math.PI) * 0.16);
    }
    this.token(c.from, c.to, morphing ? v : 0, x, y, s, 1, morphing || c.op !== 'move' ? glow : 0);
  }

  private token(
    from: PartSnap, to: PartSnap, t: number, x: number, y: number,
    size: number, alpha: number, glow: number,
  ): void {
    const color = t <= 0 ? colorOf(from.def, from.tags)
      : t >= 1 ? colorOf(to.def, to.tags)
        : mixColor(colorOf(from.def, from.tags), colorOf(to.def, to.tags), t);
    drawToken(this.ctx, { defFrom: from.def, defTo: to.def, t, color, x, y, size, alpha, rot: 0, glow });
    const value = Math.round(from.value + (to.value - from.value) * t);
    const mult = from.mult + (to.mult - from.mult) * t;
    this.ctx.globalAlpha = alpha;
    drawValueTag(
      this.ctx, x, y + size * 1.35, fmt(value),
      Math.abs(mult - 1) > 0.001 ? fmtMult(mult) : null, Math.max(9, size * 0.44),
    );
    this.ctx.globalAlpha = 1;
  }

  /**
   * The punchline. The batch pours into the crate and ONE object comes back out,
   * enormous, named. If a shipment ever ends on a bare number instead of this, the
   * whole design argument in docs/design/VETERAN-REVIEW.md has been lost.
   */
  private drawCrateFinale(r: Reel, beat: Beat, u: number, beltY: number, size: number): void {
    const ctx = this.ctx;
    const dur = beat.durationMs;
    const k = clamp01(u / dur);
    const station = beat.index;
    const y = beltY - size * 1.5 - 6;
    const n = beat.before.length;
    const pour = ease(clamp01(k / 0.4));
    for (let i = 0; i < n; i++) {
      const p = beat.before[i];
      const from = this.slotX(station - 1, i, n);
      const to = this.stationX(station);
      this.token(p, p, 0, from + (to - from) * pour, y + pour * 26, size * (1 - pour * 0.6), 1 - pour * 0.85, 0);
    }
    if (k < 0.34) return;

    const p = r.punchline;
    if (p === null) return;
    const b = ease(clamp01((k - 0.34) / 0.42));
    // The object plus its name and rung line has to fit the viewport whole — a
    // Monument cropped by the top edge is the one frame this build cannot afford.
    const room = Math.min(this.w * 0.32, (this.h - 34) / 2.75);
    const big = Math.max(34, room * (0.68 + 0.32 * r.awe));
    const cx = this.stationX(station);
    const cy = big + 14;

    // black out the whole conveyor behind the reveal — the last thing the player
    // looks at in a shipment should be the object, with nothing else competing
    ctx.save();
    ctx.globalAlpha = b * 0.92;
    ctx.fillStyle = PALETTE.bg;
    ctx.fillRect(cx - this.w * 1.5, -this.h, this.w * 3, this.h * 3);
    ctx.restore();

    // rays for anything genuinely absurd
    if (r.awe > 0.55) {
      ctx.save();
      ctx.globalAlpha = b * 0.28;
      ctx.strokeStyle = p.tier >= 0 ? TIER_COLORS[p.tier] : PALETTE.gold;
      ctx.lineWidth = 6;
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2 + u * 0.0004;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(a) * big * 1.15, cy + Math.sin(a) * big * 1.15);
        ctx.lineTo(cx + Math.cos(a) * big * (1.5 + 0.5 * b), cy + Math.sin(a) * big * (1.5 + 0.5 * b));
        ctx.stroke();
      }
      ctx.restore();
    }

    const overshoot = 1 + Math.sin(clamp01((k - 0.34) / 0.42) * Math.PI) * 0.18;
    drawToken(ctx, {
      defFrom: p.def, defTo: p.def, t: 0, color: colorOf(p.def, p.tags),
      x: cx, y: cy, size: big * b * overshoot, alpha: 1, rot: 0, glow: (1 - b) * 0.8,
    });
    ctx.save();
    ctx.globalAlpha = b;
    textCenter(ctx, p.name.toUpperCase(), cx, cy + big * 1.32, Math.max(20, big * 0.3), PALETTE.cream);
    const tierLabel = p.tier >= 0 ? `RUNG ${p.tier + 1}/${TIER_LADDER.length}` : p.tags.join(' · ').toUpperCase();
    textCenter(ctx, tierLabel, cx, cy + big * 1.62, Math.max(10, big * 0.13), p.tier >= 0 ? TIER_COLORS[p.tier] : PALETTE.dim);
    ctx.restore();
  }

  // -------------------------------------------------------------------------
  // HUD drawn inside the canvas: the running total, right next to the machines
  // -------------------------------------------------------------------------

  private shownTotal(r: Reel, beat: Beat, u: number): number {
    const dur = beat.durationMs;
    const hold = beat.holdMs;
    const transitDur = Math.max(1, (dur - hold) * TRANSIT);
    if (beat.kind === 'crate') return beat.batchAfter;
    if (u < transitDur + hold) return beat.batchBefore;
    const v = ease(clamp01((u - transitDur - hold) / Math.max(1, dur - hold - transitDur)));
    return Math.round(beat.batchBefore + (beat.batchAfter - beat.batchBefore) * v);
  }

  private drawPlayHud(r: Reel, beat: Beat, u: number, beltY: number, size: number): void {
    const ctx = this.ctx;
    const shown = this.shownTotal(r, beat, u);
    if (this.onTick !== null) this.onTick(shown);
    const cx = this.w * 0.5;
    textCenter(ctx, 'SHIPMENT', cx, 20, 11, PALETTE.dim);
    const grow = beat.kind === 'crate' ? 1.08 : 1;
    textCenter(ctx, fmt(shown), cx, 48, Math.min(46, this.w * 0.13) * grow, PALETTE.cream);
    if (beat.kind === 'machine' && beat.holdMs > 0) {
      const transitDur = (beat.durationMs - beat.holdMs) * TRANSIT;
      const s = u - transitDur;
      if (s >= 0 && s < beat.holdMs) {
        ctx.save();
        ctx.globalAlpha = 0.55 + 0.45 * Math.sin(s / 50);
        textCenter(ctx, 'GAMBLE', cx, 74, 14, PALETTE.gold);
        ctx.restore();
      }
    }
  }

  // -------------------------------------------------------------------------
  // attract loop — the pitch, in four seconds, with no words
  // -------------------------------------------------------------------------

  private drawAttract(): void {
    const ctx = this.ctx;
    const n = TIER_LADDER.length;
    const per = 900;
    const total = per * n;
    const t = ((this.attractT % total) + total) % total;
    const i = Math.max(0, Math.min(n - 1, Math.floor(t / per)));
    const f = (t % per) / per;
    const j = Math.min(n - 1, i + 1);
    const k = f < 0.62 ? 0 : ease((f - 0.62) / 0.38);
    const a = TIER_LADDER[i];
    const b = TIER_LADDER[j];
    const cx = this.w * 0.5;
    const cy = this.h * 0.46;
    const size = Math.min(this.w, this.h) * 0.28;
    const pop = 1 + Math.sin(clamp01(k) * Math.PI) * 0.2;

    drawToken(ctx, {
      defFrom: a.def, defTo: b.def, t: k,
      color: mixColor(TIER_COLORS[i], TIER_COLORS[j], k),
      x: cx, y: cy, size: size * pop, alpha: 1, rot: 0, glow: Math.sin(clamp01(k) * Math.PI) * 0.7,
    });
    textCenter(ctx, (k < 0.5 ? a.name : b.name).toUpperCase(), cx, cy + size * 1.5, size * 0.26, PALETTE.cream);
    const rung = k < 0.5 ? i : j;
    textCenter(ctx, `RUNG ${rung + 1} / ${n}`, cx, cy + size * 1.85, size * 0.13, TIER_COLORS[rung]);
  }
}
