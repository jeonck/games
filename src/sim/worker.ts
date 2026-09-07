// TAKT — one simulation worker.
//
// Four cores, one worker each, seeds handed out in chunks by src/sim/cli.ts. The
// worker owns exactly one bot instance for its lifetime: constructing a bot probes
// the content set (stochastic.ts, credits.ts) and that probe should be paid once
// per process, not once per run. `bot.startRun` clears everything a run can carry.
//
// Records cross the thread boundary as plain objects through structuredClone —
// RunRecord and its harness extension are data, so nothing needs serialising by
// hand. Seeds are independent, so which worker plays which chunk cannot change any
// record; the CLI sorts by seed on the way in and the result is bit-identical to a
// single-threaded run of the same seed set.

import { parentPort } from 'node:worker_threads';
import '../content/index.ts';
import { makeBot } from '../bots/index.ts';
import type { BotOptions } from '../bots/index.ts';
import { runOne } from './harness.ts';
import type { HarnessRecord } from './harness.ts';
import type { BotName } from './telemetry.ts';
import type { Bot } from '../bots/types.ts';

export interface WorkerTask {
  bot: BotName;
  opts: BotOptions;
  seeds: number[];
}

export interface WorkerResult {
  records: HarnessRecord[];
  /** wall-clock spent inside runOne, for the throughput number */
  ms: number;
}

const cache = new Map<string, Bot>();

function botFor(name: BotName, opts: BotOptions): Bot {
  const key = `${name}|${opts.samples ?? ''}|${opts.fishing === true ? 'F' : ''}`;
  let b = cache.get(key);
  if (b === undefined) {
    b = makeBot(name, opts);
    cache.set(key, b);
  }
  return b;
}

if (parentPort !== null) {
  parentPort.on('message', (task: WorkerTask) => {
    const bot = botFor(task.bot, task.opts);
    const t0 = performance.now();
    const records: HarnessRecord[] = new Array(task.seeds.length);
    for (let i = 0; i < task.seeds.length; i++) records[i] = runOne(bot, task.seeds[i]);
    const res: WorkerResult = { records, ms: performance.now() - t0 };
    (parentPort as NonNullable<typeof parentPort>).postMessage(res);
  });
}
