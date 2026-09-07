// TAKT — hot-path microbenchmark.
//
// `previewShipment` is called ~10^8 times across a full benchmark sweep. The budget
// is 3 microseconds for a 5-part batch through an 8-machine line. This test FAILS
// when that budget is exceeded; it is a gate, not a report.
//
// Method: 1,000 blocks of 100 calls (100,000 calls total), timed per block with
// process.hrtime.bigint(), median of the 1,000 per-call block times. Timing whole
// blocks keeps the clock-read overhead (~30-60ns) out of the measurement, and the
// median discards GC pauses and scheduler noise.

import test from 'node:test';
import assert from 'node:assert/strict';

import type { Machine } from '../src/engine/types.ts';
import { PARTS_PER_SHIPMENT } from '../src/engine/types.ts';
import { getRegistry, hasRegistry } from '../src/content/registry.ts';
import { installPlaceholder } from '../src/content/placeholder.ts';
import { newRun, previewShipment } from '../src/engine/run.ts';

const BUDGET_US = 3;
const BLOCKS = 1000;
const PER_BLOCK = 100;
const WARMUP = 200_000;

// Benchmark against the real content set when it exists; fall back to the stub so
// the engine gate holds standalone.
let source = 'placeholder';
// Resolved at runtime rather than as a literal specifier: the real content set is
// written by a parallel agent and may not exist yet.
const CONTENT_URL = new URL('../src/content/index.ts', import.meta.url).href;
try {
  await import(CONTENT_URL);
  if (hasRegistry()) source = 'content';
  else installPlaceholder();
} catch {
  installPlaceholder();
}

function eightMachineLine(): Machine[] {
  const defs = [...getRegistry().machines.keys()];
  const out: Machine[] = [];
  for (let i = 0; i < 8; i++) {
    out.push({ id: `perf${i}`, def: defs[i % defs.length], level: 1 + (i % 3) });
  }
  return out;
}

function median(xs: number[]): number {
  const a = xs.slice().sort((p, q) => p - q);
  return a[a.length >> 1];
}

function measure(label: string, call: () => number): number {
  let sink = 0;
  for (let i = 0; i < WARMUP; i++) sink += call();

  const perCall: number[] = new Array(BLOCKS);
  for (let b = 0; b < BLOCKS; b++) {
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < PER_BLOCK; i++) sink += call();
    const t1 = process.hrtime.bigint();
    perCall[b] = Number(t1 - t0) / PER_BLOCK / 1000; // microseconds
  }
  assert.ok(Number.isFinite(sink), 'result was actually consumed');

  const sorted = perCall.slice().sort((p, q) => p - q);
  const med = median(perCall);
  console.log(
    `  ${label} [${source}]  median ${med.toFixed(3)}us  ` +
    `p95 ${sorted[Math.floor(BLOCKS * 0.95)].toFixed(3)}us  ` +
    `min ${sorted[0].toFixed(3)}us  budget ${BUDGET_US}us`,
  );
  return med;
}

test('previewShipment: 5 parts through an 8-machine line stays under 3us', () => {
  const s = newRun(20260907);
  const l = eightMachineLine();
  const idx = [0, 1, 2, 3, 4];
  assert.equal(idx.length, PARTS_PER_SHIPMENT);
  assert.equal(l.length, 8);
  assert.ok(s.hand.length >= PARTS_PER_SHIPMENT);

  const med = measure('preview 5x8', () => previewShipment(s, idx, l).gained);
  assert.ok(
    med < BUDGET_US,
    `previewShipment median ${med.toFixed(3)}us exceeds the ${BUDGET_US}us budget`,
  );
});

test('previewShipment: the bot reorder-search loop stays under 3us per call', () => {
  // What the planner actually does: same state, a different candidate ordering
  // every call. Guards against a fast path that only exists for a stable `line`.
  const s = newRun(20260908);
  const l = eightMachineLine();
  const idx = [0, 1, 2, 3, 4];
  let k = 0;
  const med = measure('preview 5x8 (rotating line)', () => {
    const rot = l.slice(k % 8).concat(l.slice(0, k % 8));
    k++;
    return previewShipment(s, idx, rot).gained;
  });
  assert.ok(
    med < BUDGET_US,
    `reorder-search median ${med.toFixed(3)}us exceeds the ${BUDGET_US}us budget`,
  );
});

test('previewShipment stays pure across 100k calls', () => {
  const s = newRun(20260909);
  const l = eightMachineLine();
  const before = JSON.stringify(s, (key, v) => (key === 'rng' ? undefined : v));
  for (let i = 0; i < 100_000; i++) previewShipment(s, [0, 1, 2, 3, 4], l);
  assert.equal(JSON.stringify(s, (key, v) => (key === 'rng' ? undefined : v)), before);
});
