// TAKT — chrome and wiring. DOM only; every pixel of the game itself is in stage.ts,
// and every decision about what an animation *means* is in vm.ts.

import '../../src/content/index.ts';
import type { RunState } from '../../src/engine/types.ts';
import type { Shop, ShopItem } from '../../src/engine/api.ts';
import {
  buy, newRun, nextRound, playShipment, reorderLine, reroll, rollShop, roundCleared, scrapParts,
} from '../../src/engine/run.ts';
import { ROUNDS_PER_SHIFT, SHIFTS_PER_RUN } from '../../src/engine/types.ts';
import { getRegistry } from '../../src/content/registry.ts';
import { TIER_LADDER } from '../../src/content/parts.ts';
import type { Contribution, PartSnap, Reel } from './vm.ts';
import {
  buildReel, dragPerm, fmt, fmtMult, lineView, preview, quotaPct, snap,
} from './vm.ts';
import { ARCHETYPE_COLOR, ARCHETYPE_GLYPH, PALETTE, TIER_COLORS, colorOf } from './art.ts';
import { drawToken } from './draw.ts';
import { Stage } from './stage.ts';
import type { StationView } from './stage.ts';
import { loadMeta, noteObject, saveMeta } from './store.ts';

const $ = (id: string): HTMLElement => {
  const e = document.getElementById(id);
  if (e === null) throw new Error(`missing element #${id}`);
  return e;
};

const meta = loadMeta();
let run: RunState | null = null;
let sel: number[] = [];
let shop: Shop | null = null;
let bought: boolean[] = [];
let busy = false;

const stage = new Stage($('stage') as HTMLCanvasElement);
const attract = new Stage($('attract') as HTMLCanvasElement);

// ---------------------------------------------------------------------------
// screens
// ---------------------------------------------------------------------------

function show(which: 'title' | 'play' | 'shop'): void {
  ($('s-title') as HTMLElement).hidden = which !== 'title';
  ($('s-play') as HTMLElement).hidden = which !== 'play';
  ($('s-shop') as HTMLElement).hidden = which !== 'shop';
  if (which === 'title') { attract.resize(); attract.start(); stage.stop(); }
  else { attract.stop(); }
  if (which === 'play') { stage.resize(); stage.start(); }
  else if (which !== 'title') stage.stop();
}

function overlay(html: string, wire?: (root: HTMLElement) => void): void {
  const o = $('overlay');
  const inner = $('overlay-inner');
  inner.innerHTML = html;
  o.hidden = false;
  if (wire !== undefined) wire(inner);
}

function closeOverlay(): void { $('overlay').hidden = true; }

// ---------------------------------------------------------------------------
// small painters
// ---------------------------------------------------------------------------

function paintPart(canvas: HTMLCanvasElement, p: { def: string; tags: readonly string[] }, pad = 0.82): void {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const r = canvas.getBoundingClientRect();
  const w = Math.max(24, r.width || 44);
  const h = Math.max(24, r.height || 44);
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  if (ctx === null) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const size = (Math.min(w, h) / 2) * pad;
  drawToken(ctx, {
    defFrom: p.def, defTo: p.def, t: 0,
    color: colorOf(p.def, p.tags), x: w / 2, y: h / 2,
    size, alpha: 1, rot: 0, glow: 0,
  });
}

function stations(deltas?: readonly number[]): StationView[] {
  const s = run as RunState;
  const audit = s.round === ROUNDS_PER_SHIFT ? getRegistry().audits[s.shift - 1] : undefined;
  const out: StationView[] = lineView(s.line).map((m) => {
    const def = getRegistry().machines.get(m.def);
    return {
      name: m.name, archetype: m.archetype, level: m.level, gamble: m.gamble,
      // an Audit can switch a whole archetype off for the round; show it greyed out
      // on the belt rather than silently doing nothing
      dim: audit !== undefined && def !== undefined && !audit.allow(def),
      delta: deltas !== undefined ? deltas[m.index] : undefined,
    };
  });
  if (audit !== undefined) {
    out.push({ name: audit.name, archetype: 'filter', level: 0, gamble: false });
  }
  return out;
}

function selSnaps(): PartSnap[] {
  const s = run as RunState;
  return sel.map((i) => snap(s.hand[i]));
}

// ---------------------------------------------------------------------------
// rendering the play screen
// ---------------------------------------------------------------------------

function renderHud(): void {
  const s = run as RunState;
  $('hud-shift').textContent =
    `SHIFT ${s.shift}/${SHIFTS_PER_RUN} · ROUND ${s.round}/${ROUNDS_PER_SHIFT} · ${s.shipmentsLeft} LEFT`;
  $('hud-credits').textContent = `${s.credits}c`;
  $('hud-score').textContent = fmt(s.score);
  $('hud-quota').textContent = fmt(s.quota);
  $('hud-bar').style.width = `${(quotaPct(s.score, s.quota) * 100).toFixed(1)}%`;
  $('quota-bar').classList.toggle('done', s.score >= s.quota);
  const banner = $('hud-audit');
  if (s.round === ROUNDS_PER_SHIFT) {
    const a = getRegistry().audits[s.shift - 1];
    banner.hidden = false;
    banner.textContent = `AUDIT · ${a.name.toUpperCase()} — ${a.text}`;
  } else banner.hidden = true;
  ($('scrap-left') as HTMLElement).textContent = String(s.scrapsLeft);
}

function renderHand(): void {
  const s = run as RunState;
  const host = $('hand');
  host.innerHTML = '';
  s.hand.forEach((part, i) => {
    const p = snap(part);
    const card = document.createElement('div');
    card.className = 'card' + (sel.indexOf(i) >= 0 ? ' sel' : '');
    const order = sel.indexOf(i);
    card.innerHTML =
      (order >= 0 ? `<div class="badge">${order + 1}</div>` : '') +
      (p.sticky ? '<div class="stick">STICKY</div>' : '') +
      '<canvas></canvas>' +
      `<div class="vl">${fmt(p.value)}${p.mult !== 1 ? `<small>${fmtMult(p.mult)}</small>` : ''}</div>` +
      `<div class="nm">${p.name}</div>`;
    card.addEventListener('click', () => toggleSel(i));
    host.appendChild(card);
    paintPart(card.querySelector('canvas') as HTMLCanvasElement, p);
  });
}

function renderSel(): void {
  const strip = $('sel-strip');
  const s = run as RunState;
  if (sel.length === 0) {
    strip.innerHTML = '<span>TAP ORDER = BATCH ORDER · UP TO 5</span>';
  } else {
    strip.innerHTML = sel
      .map((i, k) => `<span class="selpill">${k + 1}. ${snap(s.hand[i]).name}</span>`)
      .join('');
  }
  const pv = preview(s, sel);
  const ship = $('btn-ship') as HTMLButtonElement;
  ship.disabled = !pv.ok;
  ship.innerHTML = pv.ok
    ? `SHIP<b>+${fmt(pv.score)}${pv.cleared ? ' · CLEARS' : ''}</b>`
    : 'SHIP<b>pick parts</b>';
  ($('btn-scrap') as HTMLButtonElement).disabled = sel.length === 0 || s.scrapsLeft <= 0;
  ($('btn-order') as HTMLButtonElement).disabled = s.line.length < 2;

  const batch = selSnaps();
  stage.showIdle(stations(pv.ok ? pv.perMachine : undefined), batch, {
    ladderBatch: batch.map((p) => p.tier).filter((t) => t >= 0),
    bestRung: meta.bestRung,
    bestName: meta.bestObject !== '' ? nameOf(meta.bestObject) : '',
  });
}

function renderPlay(): void {
  renderHud();
  renderHand();
  renderSel();
}

function toggleSel(i: number): void {
  if (busy) return;
  const at = sel.indexOf(i);
  if (at >= 0) sel.splice(at, 1);
  else if (sel.length < 5) sel.push(i);
  else return;
  renderHand();
  renderSel();
}

// ---------------------------------------------------------------------------
// the shipment — the moment the whole build exists for
// ---------------------------------------------------------------------------

function onShip(): void {
  const s = run as RunState;
  if (busy || sel.length === 0 || sel.length > 5) return;
  busy = true;
  const scoreBefore = s.score;
  const line = s.line.map((m) => ({ ...m }));
  const audit = s.round === ROUNDS_PER_SHIFT ? getRegistry().audits[s.shift - 1] : null;
  const res = playShipment(s, sel.slice());
  const reel = buildReel(res, {
    line,
    scoreBefore,
    quota: s.quota,
    targetMs: meta.fast ? 700 : 1600,
    crateMs: meta.fast ? 460 : 760,
    audit: audit === null ? null : { def: audit.def, name: audit.name, text: audit.text },
  });

  if (reel.punchline !== null) {
    if (noteObject(meta, reel.punchline.def, reel.punchline.tier)) saveMeta(meta);
  }

  sel = [];
  renderHand();
  renderHud();
  ($('btn-ship') as HTMLButtonElement).disabled = true;
  ($('btn-scrap') as HTMLButtonElement).disabled = true;
  ($('btn-order') as HTMLButtonElement).disabled = true;
  const hint = $('stage-hint');
  hint.hidden = false;
  hint.textContent = 'TAP TO SPEED UP · HOLD TO SKIP';
  // The reel is the product. While it runs it gets the whole screen, not a strip
  // above a hand of cards the player cannot act on anyway.
  $('s-play').classList.add('shipping');
  stage.resize();

  stage.onDone = () => {
    hint.hidden = true;
    $('s-play').classList.remove('shipping');
    stage.resize();
    // Let the object sit in the crate for a beat before the numbers arrive. The
    // reveal is the payoff; covering it instantly with a results panel throws it away.
    window.setTimeout(() => { busy = false; afterShipment(reel); }, meta.fast ? 120 : 340);
  };
  stage.play(reel, stations());
}

function afterShipment(reel: Reel): void {
  renderPlay();
  showResults(reel);
}

function showResults(reel: Reel): void {
  const s = run as RunState;
  const rows = reel.breakdown.map((c) => breakdownRow(c, reel)).join('');
  const cleared = roundCleared(s);
  const dead = s.over && !s.won;
  const p = reel.punchline;
  const next = dead ? 'SEE THE DAMAGE' : cleared ? 'TO THE SHOP' : 'KEEP GOING';
  overlay(`
    ${p !== null ? '<canvas class="ov-object" id="ov-obj"></canvas>' : ''}
    <div class="ov-title">${p !== null ? 'INTO THE CRATE' : 'NOTHING SHIPPED'}</div>
    <div class="ov-big">${reel.headline}</div>
    <div class="ov-sub">${p !== null && p.tier >= 0 ? `rung ${p.tier + 1} of ${TIER_LADDER.length} · ` : ''}worth ${fmt(reel.gained)}</div>
    ${ladderBar(p)}
    <div class="brk">${rows}</div>
    <div class="ov-sub">${fmt(reel.scoreBefore)} → <b style="color:var(--cream)">${fmt(reel.scoreAfter)}</b> of ${fmt(reel.quota)}</div>
    <div class="ov-actions"><button class="btn btn-big" id="ov-next">${next}</button></div>
  `, (root) => {
    const c = root.querySelector('#ov-obj') as HTMLCanvasElement | null;
    if (c !== null && p !== null) paintPart(c, p, 0.9);
    (root.querySelector('#ov-next') as HTMLElement).addEventListener('click', () => {
      closeOverlay();
      if (dead) showDefeat();
      else if (cleared) openShop();
      else renderPlay();
    });
  });
}

function breakdownRow(c: Contribution, reel: Reel): string {
  const peak = reel.beats[reel.peakBeat] !== undefined && reel.beats[reel.peakBeat].key === c.key
    && Math.abs(c.delta) > 0;
  const pct = Math.min(100, Math.abs(c.share) * 100);
  const cls = c.delta > 0 ? 'pos' : c.delta < 0 ? 'neg' : '';
  const idx = c.lineIndex >= 0 ? String(c.lineIndex + 1) : c.key === 'base' ? '·' : 'A';
  return `<div class="brk-row ${peak ? 'peak' : ''} ${c.fired ? '' : 'idle'}">
      <span class="i">${idx}</span>
      <span class="n">${c.name}${c.fired ? '' : ' <em style="font-style:normal;color:var(--dim)">— did nothing</em>'}</span>
      <span class="d ${cls}">${c.delta > 0 ? '+' : ''}${fmt(c.delta)}</span>
      <span class="brk-bar"><i class="${c.delta < 0 ? 'neg' : ''}" style="width:${pct.toFixed(1)}%"></i></span>
    </div>`;
}

function ladderBar(p: PartSnap | null): string {
  const cells = TIER_LADDER.map((t, i) => {
    const on = p !== null && p.tier >= i;
    return `<i style="background:${on ? TIER_COLORS[i] : PALETTE.panel}"></i>`;
  }).join('');
  return `<div class="ladder">${cells}</div>`;
}

// ---------------------------------------------------------------------------
// scrap
// ---------------------------------------------------------------------------

function onScrap(): void {
  const s = run as RunState;
  if (busy || sel.length === 0 || s.scrapsLeft <= 0) return;
  scrapParts(s, sel.slice());
  sel = [];
  renderPlay();
}

// ---------------------------------------------------------------------------
// reorder — the skill expression, made tangible while your thumb is down
// ---------------------------------------------------------------------------

let orderBase = 0;

function openOrder(returnTo: 'play' | 'shop'): void {
  if (busy || run === null) return;
  const s = run as RunState;
  orderReturn = returnTo;
  const pv = preview(s, orderSelection());
  orderBase = pv.ok ? pv.score : 0;
  ($('order-panel') as HTMLElement).hidden = false;
  show('play');
  renderOrder();
}

let orderReturn: 'play' | 'shop' = 'play';

/**
 * What the reorder preview is priced against. A live selection if the player has one,
 * otherwise the top of the hand as a sample batch — a preview of nothing is useless,
 * and a made-up batch that is labelled as made-up is honest.
 */
function orderSelection(): number[] {
  const s = run as RunState;
  if (sel.length > 0) return sel.slice();
  const n = Math.min(5, s.hand.length);
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(i);
  return out;
}

function renderOrder(): void {
  const s = run as RunState;
  const list = $('order-list');
  const view = lineView(s.line);
  const pv = preview(s, orderSelection());
  const score = $('order-score');
  score.textContent = pv.ok ? fmt(pv.score) : '—';
  score.className = 'order-score' + (pv.score > orderBase ? ' up' : pv.score < orderBase ? ' down' : '');
  $('order-sub').textContent = sel.length > 0
    ? `your ${sel.length}-part batch scores`
    : 'a sample batch from your hand scores';

  list.innerHTML = view.map((m, i) => `
    <div class="orow" data-i="${i}">
      <span class="idx">${i + 1}</span>
      <span class="glyph" style="color:${ARCHETYPE_COLOR[m.archetype]}">${ARCHETYPE_GLYPH[m.archetype]}</span>
      <span style="min-width:0">
        <span class="nm">${m.name}${m.level > 1 ? ` LV${m.level}` : ''}${m.gamble ? ' ◆' : ''}</span>
        <span class="tx" style="display:block">${m.text}</span>
      </span>
      <span class="contrib">${pv.ok && pv.perMachine[i] !== undefined ? (pv.perMachine[i] >= 0 ? '+' : '') + fmt(pv.perMachine[i]) : ''}</span>
      <span class="grip">≡</span>
    </div>`).join('');

  for (const row of Array.from(list.querySelectorAll('.orow'))) {
    row.addEventListener('pointerdown', onOrderDown as EventListener);
  }
}

let drag: { from: number; y0: number; rowH: number; el: HTMLElement } | null = null;

function onOrderDown(ev: PointerEvent): void {
  const el = (ev.currentTarget as HTMLElement);
  const from = Number(el.dataset.i);
  const rect = el.getBoundingClientRect();
  drag = { from, y0: ev.clientY, rowH: rect.height + 6, el };
  el.classList.add('dragging');
  el.setPointerCapture(ev.pointerId);
  el.addEventListener('pointermove', onOrderMove as EventListener);
  el.addEventListener('pointerup', onOrderUp as EventListener);
  el.addEventListener('pointercancel', onOrderUp as EventListener);
}

function onOrderMove(ev: PointerEvent): void {
  if (drag === null) return;
  const s = run as RunState;
  const steps = Math.round((ev.clientY - drag.y0) / drag.rowH);
  const to = Math.max(0, Math.min(s.line.length - 1, drag.from + steps));
  if (to === drag.from) return;
  // Reordering is free and always legal, so the cheapest correct way to give a live
  // preview is to actually perform the move and re-price the line.
  reorderLine(s, dragPerm(s.line.length, drag.from, to));
  drag.from = to;
  drag.y0 = ev.clientY;
  renderOrder();
  const el = $('order-list').querySelector(`.orow[data-i="${to}"]`) as HTMLElement | null;
  if (el !== null) {
    el.classList.add('dragging');
    drag.el = el;
    el.setPointerCapture(ev.pointerId);
    el.addEventListener('pointermove', onOrderMove as EventListener);
    el.addEventListener('pointerup', onOrderUp as EventListener);
    el.addEventListener('pointercancel', onOrderUp as EventListener);
  }
}

function onOrderUp(): void {
  if (drag !== null) drag.el.classList.remove('dragging');
  drag = null;
  renderOrder();
}

function closeOrder(): void {
  ($('order-panel') as HTMLElement).hidden = true;
  if (orderReturn === 'shop') { show('shop'); renderShop(); }
  else renderPlay();
}

// ---------------------------------------------------------------------------
// shop
// ---------------------------------------------------------------------------

function openShop(): void {
  const s = run as RunState;
  shop = rollShop(s);
  bought = shop.items.map(() => false);
  show('shop');
  renderShop();
}

function renderShop(): void {
  const s = run as RunState;
  const sh = shop as Shop;
  $('shop-credits').textContent = `${s.credits}c`;
  $('shop-title').textContent = s.round === ROUNDS_PER_SHIFT ? 'SHIFT CLEARED' : 'QUOTA MET';
  const lastRound = s.round === ROUNDS_PER_SHIFT;
  $('shop-sub').textContent = lastRound && s.shift === SHIFTS_PER_RUN
    ? 'one more push'
    : `next: shift ${lastRound ? s.shift + 1 : s.shift}, round ${lastRound ? 1 : s.round + 1}`;

  const host = $('shop-items');
  host.innerHTML = '';
  sh.items.forEach((it, i) => {
    const card = document.createElement('div');
    card.className = 'item' + (bought[i] ? ' bought' : '');
    card.innerHTML = shopItemHtml(it) +
      `<span class="buy"><button class="btn" ${s.credits < it.cost || bought[i] ? 'disabled' : ''}>${it.cost}c</button></span>`;
    const c = card.querySelector('canvas') as HTMLCanvasElement | null;
    host.appendChild(card);
    if (c !== null) {
      const pd = getRegistry().parts.get(it.def);
      if (pd !== undefined) paintPart(c, { def: pd.def, tags: pd.tags });
    }
    const btn = card.querySelector('button');
    if (btn !== null) {
      btn.addEventListener('click', () => {
        if (buy(s, sh, i)) {
          // `buy` splices the purchased item out; keep the row for feedback instead.
          sh.items.splice(i, 0, it);
          bought[i] = true;
          renderShop();
        }
      });
    }
  });

  $('shop-line').innerHTML = lineView(s.line)
    .map((m, i) => `<span class="mchip" style="border-color:${ARCHETYPE_COLOR[m.archetype]}">${i + 1}. ${m.name}${m.level > 1 ? ` LV${m.level}` : ''}</span>`)
    .join('') + `<span class="mchip" style="color:var(--dim)">${s.line.length}/${s.lineCap} SLOTS</span>`;

  const rr = $('btn-reroll') as HTMLButtonElement;
  rr.textContent = `REROLL ${sh.rerollCost}c`;
  rr.disabled = s.credits < sh.rerollCost;
  $('btn-next').textContent = lastRound
    ? (s.shift === SHIFTS_PER_RUN ? 'FINISH THE RUN' : `START SHIFT ${s.shift + 1}`)
    : 'NEXT ROUND';
}

function shopItemHtml(it: ShopItem): string {
  const reg = getRegistry();
  if (it.kind === 'machine' || it.kind === 'upgrade') {
    const d = reg.machines.get(it.def);
    const name = d !== undefined ? d.name : it.def;
    const arch = d !== undefined ? d.archetype : 'arithmetic';
    return `<span class="glyph" style="color:${ARCHETYPE_COLOR[arch]}">${ARCHETYPE_GLYPH[arch]}</span>
      <span class="body"><span class="kd">${it.kind === 'upgrade' ? 'UPGRADE · ' : ''}${arch.toUpperCase()}</span>
      <span class="nm">${name}${it.kind === 'upgrade' ? ' +1 LEVEL' : ''}</span>
      <span class="tx">${d !== undefined ? d.text(it.kind === 'upgrade' ? 2 : 1) : ''}</span></span>`;
  }
  if (it.kind === 'part') {
    const p = reg.parts.get(it.def);
    return `<canvas></canvas><span class="body"><span class="kd">PART · ${p !== undefined ? p.tags.join(' ').toUpperCase() : ''}</span>
      <span class="nm">${p !== undefined ? p.name : it.def}</span>
      <span class="tx">${p !== undefined ? `${p.value} value${p.mult !== 1 ? ` · x${p.mult} mult` : ''}${p.sticky === true ? ' · sticky' : ''}` : ''} — added to your crate</span></span>`;
  }
  if (it.kind === 'blueprint') {
    const b = reg.blueprints.get(it.def);
    return `<span class="glyph" style="color:var(--gold)">▤</span><span class="body"><span class="kd">BLUEPRINT</span>
      <span class="nm">${b !== undefined ? b.name : it.def}</span><span class="tx">${b !== undefined ? b.text : ''}</span></span>`;
  }
  return `<span class="glyph" style="color:var(--good)">＋</span><span class="body"><span class="kd">LINE</span>
    <span class="nm">One more machine slot</span><span class="tx">a longer line is a longer sentence</span></span>`;
}

function onNextRound(): void {
  const s = run as RunState;
  nextRound(s);
  if (s.over) {
    if (s.won) showVictory();
    else showDefeat();
    return;
  }
  sel = [];
  show('play');
  renderPlay();
}

// ---------------------------------------------------------------------------
// endings
// ---------------------------------------------------------------------------

function recordRun(won: boolean): void {
  const s = run as RunState;
  meta.runs++;
  if (won) meta.wins++;
  const reached = (s.shift - 1) * ROUNDS_PER_SHIFT + s.round;
  if (reached > meta.bestShift) meta.bestShift = reached;
  if (s.score > meta.bestScore) meta.bestScore = s.score;
  saveMeta(meta);
}

function showDefeat(): void {
  const s = run as RunState;
  recordRun(false);
  const best = meta.bestObject !== '' ? meta.bestObject : null;
  overlay(`
    <div class="ov-title">QUOTA MISSED</div>
    <div class="ov-big">SHIFT ${s.shift}</div>
    <div class="ov-sub">round ${s.round} · ${fmt(s.score)} of ${fmt(s.quota)}</div>
    <div class="ov-note">Best thing you have ever made: <b style="color:var(--gold)">${best !== null ? nameOf(best) : 'nothing yet'}</b></div>
    <div class="ov-actions" style="margin-top:16px">
      <button class="btn btn-big" id="ov-again">AGAIN</button>
      <button class="btn btn-ghost" id="ov-title">TITLE</button>
    </div>`, (root) => {
    (root.querySelector('#ov-again') as HTMLElement).addEventListener('click', () => { closeOverlay(); startRun(); });
    (root.querySelector('#ov-title') as HTMLElement).addEventListener('click', () => { closeOverlay(); toTitle(); });
  });
}

function showVictory(): void {
  const s = run as RunState;
  recordRun(true);
  overlay(`
    <div class="ov-title">EIGHT SHIFTS. NO MISSES.</div>
    <div class="ov-big">SHIPPED</div>
    <div class="ov-sub">final score ${fmt(s.score)}</div>
    <div class="ov-note">Highest rung reached: <b style="color:var(--gold)">${meta.bestRung >= 0 ? nameOf(meta.bestObject) : '—'}</b></div>
    <div class="ov-actions" style="margin-top:16px">
      <button class="btn btn-big" id="ov-again">RUN IT AGAIN</button>
      <button class="btn btn-ghost" id="ov-title">TITLE</button>
    </div>`, (root) => {
    (root.querySelector('#ov-again') as HTMLElement).addEventListener('click', () => { closeOverlay(); startRun(); });
    (root.querySelector('#ov-title') as HTMLElement).addEventListener('click', () => { closeOverlay(); toTitle(); });
  });
}

function nameOf(def: string): string {
  const p = getRegistry().parts.get(def);
  return p !== undefined ? p.name : def;
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

function startRun(): void {
  run = newRun((Math.random() * 0xffffffff) >>> 0);
  sel = [];
  busy = false;
  shop = null;
  closeOverlay();
  show('play');
  renderPlay();
}

function toTitle(): void {
  renderTitleMeta();
  attract.showAttract([]);
  show('title');
}

function renderTitleMeta(): void {
  const bits: string[] = [];
  if (meta.runs > 0) bits.push(`${meta.runs} run${meta.runs === 1 ? '' : 's'}`);
  if (meta.wins > 0) bits.push(`${meta.wins} finished`);
  if (meta.bestScore > 0) bits.push(`best ${fmt(meta.bestScore)}`);
  if (meta.bestRung >= 0) bits.push(`made a ${nameOf(meta.bestObject)}`);
  bits.push(meta.fast ? 'FAST ANIMATION' : 'FULL ANIMATION');
  $('title-meta').textContent = bits.join(' · ');
}

function howItWorks(): void {
  overlay(`
    <div class="ov-title">TAKT</div>
    <div class="ov-big" style="font-size:34px">THE LINE IS A SENTENCE</div>
    <div class="ov-sub">Parts enter on the left in the order you tapped them. Each machine rewrites
      the batch as it passes. <b style="color:var(--cream)">x2 then +5 is not +5 then x2</b> — the order
      of your machines is the whole game.</div>
    <div class="ov-sub">Some machines don't just add. They <b style="color:var(--gold)">promote</b>:
      an Offcut becomes a Bolt becomes a Gear becomes a Pump becomes an Engine becomes a Reactor
      becomes a Monument. Getting something absurd into the crate is the point.</div>
    ${ladderBar({ tier: 6 } as PartSnap)}
    <div class="ov-sub">Meet the quota before you run out of shipments. Eight shifts. Round three of
      every shift is an Audit, and the Audit changes what scoring even means.</div>
    <div class="ov-actions">
      <button class="btn btn-wide" id="ov-fast">${meta.fast ? 'ANIMATION: FAST' : 'ANIMATION: FULL'}</button>
      <button class="btn btn-big" id="ov-close">GOT IT</button>
    </div>`, (root) => {
    (root.querySelector('#ov-close') as HTMLElement).addEventListener('click', () => { closeOverlay(); renderTitleMeta(); });
    (root.querySelector('#ov-fast') as HTMLElement).addEventListener('click', (e) => {
      meta.fast = !meta.fast;
      saveMeta(meta);
      (e.currentTarget as HTMLElement).textContent = meta.fast ? 'ANIMATION: FAST' : 'ANIMATION: FULL';
      renderTitleMeta();
    });
  });
}

// --- input -----------------------------------------------------------------

$('btn-play').addEventListener('click', () => startRun());
$('btn-how').addEventListener('click', () => howItWorks());
$('btn-ship').addEventListener('click', () => onShip());
$('btn-scrap').addEventListener('click', () => onScrap());
$('btn-order').addEventListener('click', () => openOrder('play'));
$('btn-order-done').addEventListener('click', () => closeOrder());
$('btn-shop-order').addEventListener('click', () => openOrder('shop'));
$('btn-next').addEventListener('click', () => onNextRound());
$('btn-reroll').addEventListener('click', () => {
  const s = run as RunState;
  shop = reroll(s, shop as Shop);
  bought = (shop as Shop).items.map(() => false);
  renderShop();
});

// tap to speed the shipment up, hold to jump to the object landing in the crate
let holdTimer = 0;
$('stage').addEventListener('pointerdown', () => {
  if (!stage.playing) return;
  holdTimer = window.setTimeout(() => { holdTimer = 0; stage.skipToCrate(); }, 340);
});
const endHold = (): void => {
  if (holdTimer !== 0) { clearTimeout(holdTimer); holdTimer = 0; if (stage.playing) stage.faster(); }
};
$('stage').addEventListener('pointerup', endHold);
$('stage').addEventListener('pointercancel', endHold);

const ro = new ResizeObserver(() => { stage.resize(); attract.resize(); });
ro.observe($('stage-wrap'));
ro.observe($('attract'));
window.addEventListener('orientationchange', () => setTimeout(() => { stage.resize(); attract.resize(); }, 120));

toTitle();
