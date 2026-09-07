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
import { ARCHETYPE_BADGE, ARCHETYPE_COLOR, PALETTE, TIER_COLORS, colorOf, mixColor } from './art.ts';
import { drawToken, drawValueTag, fitText, font, poly, roundRect, textCenter } from './draw.ts';
import { TIER_LADDER } from '../../src/content/parts.ts';

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
  /** what this machine would add to the batch currently selected, if anything */
  delta?: number;
}

/** Context the resting view needs to fill the frame with something worth looking at. */
export interface IdleInfo {
  /** rungs of the tier ladder the selected batch currently occupies */
  ladderBatch: number[];
  bestRung: number;
  bestName: string;
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
  private idleInfo: IdleInfo = { ladderBatch: [], bestRung: -1, bestName: '' };
  // layout, recomputed every frame from the canvas size — the stage goes full-bleed
  // during a shipment and back to a third of the screen at rest
  private step = 208;
  private bw = 104;
  private bh = 86;
  private tokSize = 24;
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
      this.advance(dt);
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
  showIdle(stations: StationView[], batch: PartSnap[], info?: IdleInfo): void {
    this.mode = 'idle';
    this.stations = stations;
    this.idleBatch = batch;
    if (info !== undefined) this.idleInfo = info;
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

  private advance(dt: number): void {
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

  /**
   * One place where every size in the conveyor comes from. The stage is roughly a
   * third of the screen while you are choosing and the ENTIRE screen while a
   * shipment runs, and the composition has to look deliberate at both — so the
   * machines, the belt and the parts are all a fraction of the canvas rather than
   * fixed pixel sizes floating in whatever space is left over.
   */
  private measure(): void {
    // width decides how many stations are on screen at once (two, plus a hint of the
    // next); height decides how tall the machinery stands.
    this.bw = Math.max(92, Math.min(140, this.w * 0.3));
    this.bh = Math.max(64, Math.min(152, this.h * 0.21));
    this.step = Math.max(186, this.bw * 1.58);
  }

  private stationX(i: number): number { return i * this.step; }

  /** Spacing follows the object size, so parts never overlap their own value tags. */
  private spacing(n: number): number {
    return this.tokSize * (n <= 3 ? 2.4 : n <= 6 ? 2.0 : 1.72);
  }

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

    this.measure();
    const r = this.reel;
    const beltY = Math.round(this.h * 0.5);
    const size = Math.max(15, Math.min(36, this.h * 0.05));

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

    if (beat !== null) {
      this.drawPlayHud(r, beat, u);
      // the rail is navigation; during the reveal it is just something else on top
      // of the object, so it steps out of the way
      if (beat.kind !== 'crate') this.drawRail(r, beat);
      this.drawTicker(r, beat, beltY);
    }
  }

  /**
   * Where the batch is in the line, as a row of pips. Two seconds is long enough
   * that "how much further" is a real question, and it is the cheapest possible
   * answer to it.
   */
  private drawRail(r: Reel, beat: Beat): void {
    const ctx = this.ctx;
    const n = r.beats.length;
    const pad = 18;
    const gap = 4;
    const cw = (this.w - pad * 2 - gap * (n - 1)) / n;
    const y = Math.round(this.h * 0.215);
    for (let i = 0; i < n; i++) {
      const x = pad + i * (cw + gap);
      const bt = r.beats[i];
      ctx.fillStyle = i === beat.index ? PALETTE.cream
        : i < beat.index ? (bt.delta > 0 ? PALETTE.accent : PALETTE.line)
          : PALETTE.panel;
      roundRect(ctx, x, y, cw, i === beat.index ? 7 : 4, 2);
      ctx.fill();
    }
    textCenter(ctx, beat.kind === 'crate' ? 'THE CRATE' : `STATION ${beat.index + 1} OF ${n}`,
      this.w * 0.5, y + 22, 10, PALETTE.dim);
  }

  /**
   * The breakdown, accumulating live under the belt as each machine fires. By the
   * time the object lands, the whole explanation of the number is already on screen
   * — which is the one thing this build exists to make true.
   */
  private drawTicker(r: Reel, beat: Beat, beltY: number): void {
    const ctx = this.ctx;
    interface Row { tag: string; name: string; delta: number; landed: boolean; cur: boolean; fired: boolean }
    const rows: Row[] = [{
      tag: '·', name: 'RAW PARTS', delta: r.beats[0].batchAfter,
      landed: true, cur: false, fired: true,
    }];
    for (const b of r.beats) {
      if (b.kind !== 'machine' && b.kind !== 'audit') continue;
      const landed = b.index < beat.index
        || (b.index === beat.index
          && this.t - b.startMs > (b.durationMs - b.holdMs) * TRANSIT + b.holdMs);
      rows.push({
        tag: b.lineIndex >= 0 ? String(b.lineIndex + 1) : 'A',
        name: b.name.toUpperCase(), delta: b.delta,
        landed, cur: b.index === beat.index, fired: b.fired,
      });
    }
    const top = beltY + Math.max(48, Math.min(58, this.h * 0.075));
    const avail = this.h - top - 24;
    const rowH = Math.max(15, Math.min(54, avail / rows.length));
    if (rowH < 14) return;
    const peak = Math.max(1, ...rows.map((b) => Math.abs(b.delta)));
    textCenter(ctx, 'WHY THE NUMBER MOVED', this.w * 0.5, top - 10, 10, PALETTE.line);
    let y = top + (avail - rowH * rows.length) * 0.28 + rowH * 0.5;
    ctx.textBaseline = 'middle';
    for (const b of rows) {
      ctx.globalAlpha = !b.landed ? 0.22 : b.fired ? (b.cur ? 1 : 0.7) : 0.32;
      ctx.font = font(Math.min(15, rowH * 0.42), b.cur && b.landed ? 900 : 800);
      ctx.textAlign = 'left';
      ctx.fillStyle = b.cur && b.landed ? PALETTE.cream : PALETTE.dim;
      ctx.fillText(`${b.tag}  ${b.name}`, 18, y);
      ctx.textAlign = 'right';
      ctx.fillStyle = !b.landed ? PALETTE.line
        : b.delta > 0 ? PALETTE.gold : b.delta < 0 ? PALETTE.bad : PALETTE.line;
      ctx.fillText(!b.landed ? '·' : b.fired ? `${b.delta >= 0 ? '+' : ''}${fmt(b.delta)}` : '—', this.w - 18, y);
      // a share bar under each row: the same explanation the results panel gives,
      // arriving one machine at a time while the batch is still moving
      const barW = b.landed ? (Math.abs(b.delta) / peak) * (this.w - 36) : 0;
      ctx.fillStyle = b.delta < 0 ? PALETTE.bad : PALETTE.accent;
      ctx.globalAlpha = b.landed ? (b.cur ? 0.9 : 0.45) : 0;
      if (barW > 0) { roundRect(ctx, 18, y + rowH * 0.26, barW, 3, 1.5); ctx.fill(); }
      ctx.globalAlpha = 1;
      y += rowH;
    }
  }

  // -------------------------------------------------------------------------
  // the resting view: the whole line as a schematic, the chosen batch above it
  // -------------------------------------------------------------------------

  private drawIdle(): void {
    const b = this.idleBatch;
    // Content-sized bands rather than fixed fractions: on a 640px Android the three
    // bands pack tight, on an 844px iPhone the slack is shared out between them, and
    // in neither case is there a hole in the middle of the screen.
    const n = this.stations.length + 2;
    const rows = this.schemRows(n);
    const objSize = b.length > 0 ? Math.min(46, (this.w - 18) / (b.length * 2.35)) : 24;

    let batchH = b.length > 0 ? 30 + objSize * 2 + 34 : 78;
    let schemH = 18 + rows * Math.min(78, Math.max(44, this.h * 0.17));
    // On a short canvas the ladder is the first thing to go: three bands crammed
    // into 250px collide, and two bands that breathe beat three that do not.
    let ladderH = this.h < 300 ? 0 : Math.max(40, Math.min(96, this.h * 0.22));

    const avail = this.h - 12;
    const bands = ladderH > 0 ? 3 : 2;
    const total = batchH + schemH + ladderH;
    if (total > avail) {
      const f = avail / total;
      batchH *= f; schemH *= f; ladderH *= f;
    }
    const slack = Math.max(0, avail - (batchH + schemH + ladderH));
    const gap = Math.min(34, slack / bands);
    let y = 6 + Math.max(0, (slack - gap * (bands - 1)) * 0.4);

    this.drawBatchBand(y, y + batchH);
    y += batchH + gap;
    this.drawSchematic(y, y + schemH);
    if (ladderH > 0) this.drawLadderRail(y + schemH + gap, y + schemH + gap + ladderH);
  }

  private schemRows(n: number): number {
    const perRowMax = Math.max(2, Math.floor((this.w - 16) / 58));
    return Math.max(1, Math.ceil(n / perRowMax));
  }

  private drawBatchBand(top: number, bottom: number): void {
    const ctx = this.ctx;
    const b = this.idleBatch;
    const h = bottom - top;
    textCenter(ctx, b.length === 0 ? 'THE BATCH' : 'THE BATCH — IN TAP ORDER',
      this.w * 0.5, top + 6, 11, PALETTE.dim);

    if (b.length === 0) {
      const cy = (top + bottom) / 2 + 6;
      textCenter(ctx, 'TAP PARTS BELOW', this.w * 0.5, cy - 8, Math.min(20, this.w * 0.058), PALETTE.dim);
      textCenter(ctx, 'the order you tap is the order they enter the line',
        this.w * 0.5, cy + 16, Math.min(12, this.w * 0.032), PALETTE.line);
      return;
    }
    const size = Math.max(11, Math.min((h - 44) * 0.42, (this.w - 18) / (b.length * 2.35)));
    const gap = size * 2.3;
    const y = top + 22 + (h - 22) * 0.44;
    for (let i = 0; i < b.length; i++) {
      const p = b[i];
      const x = this.w * 0.5 + (i - (b.length - 1) / 2) * gap;
      drawToken(ctx, {
        defFrom: p.def, defTo: p.def, t: 0, color: colorOf(p.def, p.tags),
        x, y, size, alpha: 1, rot: 0, glow: 0,
      });
      drawValueTag(ctx, x, y + size * 1.42, fmt(p.value),
        Math.abs(p.mult - 1) > 0.001 ? fmtMult(p.mult) : null, Math.max(9, size * 0.44));
      if (size >= 17 && bottom - (y + size * 1.42) > 30) {
        textCenter(ctx, p.name.toUpperCase(), x, y + size * 1.42 + 22,
          Math.max(8, Math.min(10, size * 0.4)), PALETTE.dim);
      }
      const br = Math.max(8, size * 0.34);
      ctx.fillStyle = PALETTE.accent;
      ctx.beginPath();
      ctx.arc(x - size * 0.9, y - size * 0.9, br, 0, Math.PI * 2);
      ctx.fill();
      textCenter(ctx, String(i + 1), x - size * 0.9, y - size * 0.9, br * 1.25, '#1a0c02');
    }
  }

  /**
   * IN ▸ machine ▸ machine ▸ … ▸ CRATE, wrapping onto more rows when the line gets
   * long, so an eight-machine line still shows eight readable NAMES rather than
   * eight identical glyphs.
   */
  private drawSchematic(top: number, bottom: number): void {
    const ctx = this.ctx;
    const n = this.stations.length + 2;
    const pad = 8;
    const rows = this.schemRows(n);
    // balance the rows so a five-station line never leaves the crate stranded alone
    const perRow = Math.ceil(n / rows);
    const cell = (this.w - pad * 2) / perRow;
    const rowH = (bottom - top - 16) / rows;
    const bw = Math.min(cell - 6, 96);
    const bh = Math.max(28, Math.min(rowH - 8, 60));

    textCenter(ctx, 'THE LINE', this.w * 0.5, top + 3, 11, PALETTE.dim);

    for (let i = 0; i < n; i++) {
      const row = Math.floor(i / perRow);
      const col = i % perRow;
      const cx = pad + cell * (col + 0.5);
      const cy = top + 16 + rowH * (row + 0.5);
      if (col > 0) textCenter(ctx, '▸', pad + cell * col, cy, Math.min(13, cell * 0.24), PALETTE.line);

      if (i === 0 || i === n - 1) {
        ctx.fillStyle = PALETTE.panel;
        roundRect(ctx, cx - bw / 2, cy - bh / 2, bw, bh, 7);
        ctx.fill();
        ctx.strokeStyle = PALETTE.line;
        ctx.lineWidth = 2;
        ctx.stroke();
        textCenter(ctx, i === 0 ? 'IN' : 'CRATE', cx, cy, Math.min(12, bw * 0.2), PALETTE.dim);
        continue;
      }
      const st = this.stations[i - 1];
      const accent = ARCHETYPE_COLOR[st.archetype] ?? PALETTE.dim;
      const roomy = bw >= 72;
      ctx.save();
      ctx.globalAlpha = st.dim === true ? 0.4 : 1;
      roundRect(ctx, cx - bw / 2, cy - bh / 2, bw, bh, 7);
      ctx.fillStyle = PALETTE.panel;
      ctx.fill();
      ctx.strokeStyle = st.gamble ? PALETTE.gold : PALETTE.line;
      ctx.lineWidth = 2;
      ctx.stroke();
      // clip to the chip: a long machine name must be squeezed, never spilled
      ctx.clip();
      // the family tag survives even when the chip is too narrow for a badge
      ctx.fillStyle = accent;
      ctx.fillRect(cx - bw / 2, cy - bh / 2, bw, 3);
      const label = st.name.toUpperCase();
      const px = fitText(ctx, label, bw - (roomy ? 24 : 8), Math.min(13, bh * 0.3), 6);
      textCenter(ctx, label, cx, cy - (st.delta !== undefined ? bh * 0.14 : 0), px, PALETTE.cream);
      // the live per-machine contribution: the ordering skill, visible before you ship
      if (st.delta !== undefined) {
        textCenter(ctx, `${st.delta >= 0 ? '+' : ''}${fmt(st.delta)}`, cx, cy + bh * 0.28,
          Math.min(12, bh * 0.26), st.delta > 0 ? PALETTE.gold : st.delta < 0 ? PALETTE.bad : PALETTE.line);
      }
      if (roomy) {
        this.badge(st.archetype, cx - bw / 2 + 9, cy - bh / 2 + 9, 5, accent);
        textCenter(ctx, String(i), cx + bw / 2 - 9, cy - bh / 2 + 9, 9, PALETTE.dim);
        if (st.level > 1) textCenter(ctx, `L${st.level}`, cx + bw / 2 - 9, cy + bh / 2 - 9, 9, PALETTE.gold);
      }
      ctx.restore();
    }
  }

  /**
   * The ladder, always on screen. It is the fantasy the whole game is selling, so it
   * is worth a permanent strip: the rungs this batch is standing on light up, and the
   * best thing the player has ever made is named underneath.
   */
  private drawLadderRail(top: number, bottom: number): void {
    const ctx = this.ctx;
    const n = TIER_LADDER.length;
    const h = bottom - top;
    if (h < 34) return;
    const pad = 10;
    const cell = (this.w - pad * 2) / n;
    const size = Math.max(8, Math.min(cell * 0.34, h * 0.30));
    const cy = top + 14 + size;
    const lit = new Set(this.idleInfo.ladderBatch);

    textCenter(ctx, 'THE LADDER', this.w * 0.5, top + 5, 10, PALETTE.dim);
    ctx.strokeStyle = PALETTE.line;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(pad + cell * 0.5, cy);
    ctx.lineTo(pad + cell * (n - 0.5), cy);
    ctx.stroke();

    for (let i = 0; i < n; i++) {
      const t = TIER_LADDER[i];
      const x = pad + cell * (i + 0.5);
      const on = lit.has(i);
      // drawToken sets its own globalAlpha, so dimming has to go through the token
      const a = on ? 1 : i <= this.idleInfo.bestRung ? 0.4 : 0.16;
      drawToken(ctx, {
        defFrom: t.def, defTo: t.def, t: 0, color: TIER_COLORS[i],
        x, y: cy, size: on ? size : size * 0.76, alpha: a, rot: 0, glow: on ? 0.3 : 0,
      });
    }
    if (h >= 52) {
      const best = this.idleInfo.bestRung >= 0 ? this.idleInfo.bestName.toUpperCase() : 'NOTHING YET';
      textCenter(ctx, `BEST EVER · ${best}`, this.w * 0.5, cy + size + 14, 10, PALETTE.dim);
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
    const w = this.bw * 0.8;
    const h = this.bh * 0.7;
    ctx.fillStyle = PALETTE.panel;
    roundRect(ctx, x - w / 2, beltY - 6 - h, w, h, 8);
    ctx.fill();
    ctx.strokeStyle = PALETTE.line;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = PALETTE.bg;
    ctx.fillRect(x - w / 2 + 12, beltY - 6 - h + 12, w - 24, h - 24);
    textCenter(ctx, 'INTAKE', x, beltY + 22, 10, PALETTE.dim);
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

    const bw = this.bw + pop * 14;
    const bh = this.bh + pop * 12;
    const accent = ARCHETYPE_COLOR[st.archetype] ?? PALETTE.dim;
    const on = active && fired;
    // the housing stops just above the belt so the belt itself stays legible and the
    // batch visibly passes THROUGH the machine rather than behind a solid slab
    const top = beltY - 6 - bh;

    ctx.save();
    ctx.globalAlpha = st.dim === true ? 0.45 : 1;
    ctx.fillStyle = on ? mixColor(PALETTE.panelHi, accent, 0.42) : PALETTE.panel;
    roundRect(ctx, x - bw / 2, top, bw, bh, 10);
    ctx.fill();
    ctx.strokeStyle = on ? PALETTE.cream : PALETTE.line;
    ctx.lineWidth = on ? 3 : 2;
    ctx.stroke();

    // legs, so it reads as machinery standing over the belt
    ctx.fillStyle = PALETTE.line;
    ctx.fillRect(x - bw / 2 + 10, beltY - 8, 9, 12);
    ctx.fillRect(x + bw / 2 - 19, beltY - 8, 9, 12);

    // NAME FIRST. An archetype glyph cannot tell Press from Doubler — they are the
    // same archetype — so the badge is a family tag in the corner and the machine's
    // name is the thing the eye lands on.
    roundRect(ctx, x - bw / 2, top, bw, bh, 10);
    ctx.clip();
    const label = st.name.toUpperCase();
    const px = fitText(ctx, label, bw - 18, Math.min(19, bh * 0.2), 8);
    textCenter(ctx, label, x, top + px * 0.95, px, PALETTE.cream);
    // family tag / level / gamble sit on their own line under the name, in the upper
    // third of the housing — the lower two thirds are where the parts travel through
    const tagY = top + px * 2.05;
    const tags: string[] = [];
    if (st.level > 1) tags.push(`LV${st.level}`);
    if (st.gamble) tags.push('◆ GAMBLE');
    this.badge(st.archetype, x - (tags.length > 0 ? 34 : 0), tagY, 6, accent);
    if (tags.length > 0) {
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.font = font(10, 800);
      ctx.fillStyle = st.gamble ? PALETTE.gold : PALETTE.dim;
      ctx.fillText(tags.join(' '), x - 22, tagY);
    }
    if (holding) textCenter(ctx, '?', x, top + bh * 0.55, bh * 0.4, PALETTE.gold);
    ctx.restore();

    if (active && fired && beat !== null && beat.fired && !holding) {
      this.drawRuleCard(x, beltY + 26, beat, clamp01((sinceFire - hold) / 200));
      if (beat.delta !== 0) this.drawDeltaChip(x, top - 16, beat.delta, clamp01((sinceFire - hold) / 420));
    }
  }

  /** The archetype family tag: a shape, not a character, so it survives being small. */
  private badge(archetype: string, x: number, y: number, r: number, color: string): void {
    const ctx = this.ctx;
    const shape = ARCHETYPE_BADGE[archetype];
    if (shape === undefined) return;
    ctx.fillStyle = color;
    poly(ctx, shape, r, x, y);
    ctx.fill();
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
    const w = this.bw;
    const h = this.bh * 0.72;
    ctx.save();
    ctx.fillStyle = active ? PALETTE.panelHi : PALETTE.panel;
    roundRect(ctx, x - w / 2, beltY - 6 - h, w, h, 8);
    ctx.fill();
    ctx.strokeStyle = active && k > 0.4 ? PALETTE.gold : PALETTE.line;
    ctx.lineWidth = active && k > 0.4 ? 3 : 2;
    ctx.stroke();
    ctx.strokeStyle = PALETTE.line;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x - w / 2, beltY - 6 - h * 0.45); ctx.lineTo(x + w / 2, beltY - 6 - h * 0.45);
    ctx.moveTo(x, beltY - 6 - h); ctx.lineTo(x, beltY - 6 - h * 0.45);
    ctx.stroke();
    textCenter(ctx, 'CRATE', x, beltY + 22, 10, PALETTE.dim);
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
    const widest = Math.max(2, beat.before.length, beat.after.length);
    this.tokSize = Math.max(12, Math.min(size, (this.w - 26) / (widest * 2.05)));
    size = this.tokSize;
    const y = beltY - size * 1.55 - 15;
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
    const y = beltY - this.tokSize * 1.55 - 15;
    size = this.tokSize;
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
    // The object gets the band between the running total and the breakdown, whole:
    // a Monument cropped by an edge, or sitting under the score, is the one frame
    // this build cannot afford.
    const hudBottom = Math.min(this.h * 0.135, this.w * 0.23) * 1.6;
    const bandTop = hudBottom;
    const bandBot = beltY + Math.max(48, Math.min(58, this.h * 0.075)) - 12;
    const bandH = Math.max(90, bandBot - bandTop);
    const room = Math.min(this.w * 0.3, (bandH - 30) / 3.0);
    const big = Math.max(30, room * (0.7 + 0.3 * r.awe));
    const cx = this.stationX(station);
    const cy = bandTop + big + Math.max(4, (bandH - (2.62 * big + 26)) * 0.35);

    // black out the whole conveyor behind the reveal — the last thing the player
    // looks at in a shipment should be the object, with nothing else competing
    ctx.save();
    ctx.globalAlpha = b * 0.97;
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

    const overshoot = 1 + Math.sin(clamp01((k - 0.34) / 0.42) * Math.PI) * 0.12;
    drawToken(ctx, {
      defFrom: p.def, defTo: p.def, t: 0, color: colorOf(p.def, p.tags),
      x: cx, y: cy, size: big * b * overshoot, alpha: 1, rot: 0, glow: (1 - b) * 0.8,
    });
    ctx.save();
    ctx.globalAlpha = b;
    const nameY = cy + big * overshoot + Math.max(18, big * 0.32);
    textCenter(ctx, p.name.toUpperCase(), cx, nameY, Math.max(20, big * 0.3), PALETTE.cream);
    const tierLabel = p.tier >= 0 ? `RUNG ${p.tier + 1} OF ${TIER_LADDER.length}` : p.tags.join(' · ').toUpperCase();
    textCenter(ctx, tierLabel, cx, nameY + Math.max(14, big * 0.26), Math.max(10, big * 0.13),
      p.tier >= 0 ? TIER_COLORS[p.tier] : PALETTE.dim);
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

  private drawPlayHud(r: Reel, beat: Beat, u: number): void {
    const ctx = this.ctx;
    const shown = this.shownTotal(r, beat, u);
    if (this.onTick !== null) this.onTick(shown);
    const cx = this.w * 0.5;
    const big = Math.min(this.h * 0.135, this.w * 0.23);
    textCenter(ctx, 'SHIPMENT', cx, big * 0.36, Math.max(10, big * 0.17), PALETTE.dim);
    const grow = beat.kind === 'crate' ? 1.06 : 1;
    textCenter(ctx, fmt(shown), cx, big * 1.05, big * grow, PALETTE.cream);
    if (beat.kind === 'machine' && beat.holdMs > 0) {
      const transitDur = (beat.durationMs - beat.holdMs) * TRANSIT;
      const s = u - transitDur;
      if (s >= 0 && s < beat.holdMs) {
        ctx.save();
        ctx.globalAlpha = 0.55 + 0.45 * Math.sin(s / 50);
        textCenter(ctx, 'GAMBLE', cx, big * 1.7, Math.max(11, big * 0.24), PALETTE.gold);
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
