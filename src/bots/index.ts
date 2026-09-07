// TAKT — bot construction, one place, so the harness and the tests cannot end up
// benchmarking two different configurations of the same tier.

import type { BotName } from '../sim/telemetry.ts';
import type { Bot } from './types.ts';
import { RandomBot } from './random.ts';
import { GreedyBot } from './greedy.ts';
import { PlannerBot } from './planner.ts';
import { OracleBot } from './oracle.ts';

export { RandomBot } from './random.ts';
export { GreedyBot } from './greedy.ts';
export { PlannerBot } from './planner.ts';
export { OracleBot } from './oracle.ts';
export type { Bot, ShipmentDecision, ReorderDecision, ShopAction } from './types.ts';
export { Evaluator, DEFAULT_EV } from './ev.ts';
export type { EvOptions } from './ev.ts';

export interface BotOptions {
  /** rng streams averaged per candidate on a stochastic line (the fishing fix) */
  samples?: number;
  /** true reproduces the rng-fishing bug. For measurement only. */
  fishing?: boolean;
}

export function makeBot(name: BotName, opts: BotOptions = {}): Bot {
  const ev = { samples: opts.samples ?? 8, fishing: opts.fishing === true };
  switch (name) {
    case 'random': return new RandomBot();
    case 'greedy': return new GreedyBot(ev);
    case 'planner': return new PlannerBot(ev);
    case 'oracle': return new OracleBot(ev);
    default: throw new Error(`unknown bot: ${String(name)}`);
  }
}
