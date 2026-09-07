// TAKT — the worker pool. Dynamic chunk hand-out over `worker_threads`.
//
// Chunks are small relative to the total so that a core that draws a run of long
// games does not hold up the wall clock at the end; they are large enough that the
// per-message cost is noise. Nothing about scheduling can change a record: a run is
// a pure function of (bot config, seed).

import { Worker } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import type { BotOptions } from '../bots/index.ts';
import type { HarnessRecord } from './harness.ts';
import type { BotName } from './telemetry.ts';
import type { WorkerResult, WorkerTask } from './worker.ts';

const WORKER_URL = new URL('./worker.ts', import.meta.url);

export interface PoolResult {
  records: HarnessRecord[];
  /** summed in-worker run time; divide by records.length for per-run cost */
  workerMs: number;
  /** wall-clock for the whole sweep */
  wallMs: number;
  workers: number;
}

export function poolSize(requested?: number): number {
  if (requested !== undefined && requested > 0) return Math.floor(requested);
  const n = availableParallelism();
  return Math.max(1, Math.min(8, n));
}

export async function runPool(
  bot: BotName, opts: BotOptions, seeds: number[],
  workers: number, chunkSize: number,
  onProgress?: (done: number, total: number) => void,
): Promise<PoolResult> {
  const t0 = performance.now();
  const chunks: number[][] = [];
  for (let i = 0; i < seeds.length; i += chunkSize) chunks.push(seeds.slice(i, i + chunkSize));

  const n = Math.max(1, Math.min(workers, chunks.length));
  const out: HarnessRecord[] = [];
  let workerMs = 0;
  let next = 0;
  let done = 0;

  await new Promise<void>((resolve, reject) => {
    const pool: Worker[] = [];
    let live = 0;
    const feed = (w: Worker): void => {
      if (next >= chunks.length) { w.terminate(); live--; if (live === 0) resolve(); return; }
      const task: WorkerTask = { bot, opts, seeds: chunks[next++] };
      w.postMessage(task);
    };
    for (let i = 0; i < n; i++) {
      const w = new Worker(WORKER_URL);
      live++;
      pool.push(w);
      w.on('message', (r: WorkerResult) => {
        for (const rec of r.records) out.push(rec);
        workerMs += r.ms;
        done += r.records.length;
        if (onProgress !== undefined) onProgress(done, seeds.length);
        feed(w);
      });
      w.on('error', (e) => { for (const p of pool) void p.terminate(); reject(e); });
      feed(w);
    }
  });

  out.sort((a, b) => a.seed - b.seed);
  return { records: out, workerMs, wallMs: performance.now() - t0, workers: n };
}
