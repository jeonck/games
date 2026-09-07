// TAKT — frozen telemetry schema. The harness emits these; metrics.ts consumes them.
import type { Archetype } from '../engine/types.ts';

export type BotName = 'random' | 'greedy' | 'planner' | 'oracle';

/** One record per completed run. */
export interface RunRecord {
  bot: BotName;
  seed: number;
  won: boolean;
  /** shift the run ended on, 1..8 (8 + won = cleared the game) */
  endShift: number;
  endRound: number;
  decisions: number;
  /** wall-clock estimate in seconds, from a decision-time model */
  estSeconds: number;
  /** machine defs owned at end of run */
  machines: string[];
  archetypes: Archetype[];
  /** score of the final shift attempted, and the quota it faced */
  finalScore: number;
  finalQuota: number;
  /** G2: per-round samples, may be empty for cheap bots */
  reorderGainPct: number[];
  /** G2.2: true when this round's optimal ordering != previous round's */
  optOrderChanged: boolean[];
  /** G6: per-shipment, (best - secondBest) / best; may be empty for cheap bots */
  decisionMarginPct: number[];
}

/** Aggregate emitted by metrics.ts, one per bot tier. */
export interface TierMetrics {
  bot: BotName;
  runs: number;
  winRate: number;
  medianDecisions: number;
  medianEstSeconds: number;
  lossShiftHistogram: number[];   // index 0 = shift 1
  p50FinalScore: number;
  p95FinalRatio: number;          // p95(finalScore / finalQuota)
  p99OverP50: number;
  archetypeWinShare: Record<string, number>;
  machineWinShare: Record<string, number>;
  archetypeEntropy: number;       // normalized Shannon, 0..1
  medianReorderGainPct: number;
  optOrderChangedRate: number;
  closeCallRate: number;          // G6.1
}

export interface GateResult {
  id: string;
  value: number | string;
  threshold: string;
  pass: boolean;
}

export interface GateReport {
  iteration: number;
  date: string;
  commit: string;
  tiers: TierMetrics[];
  results: GateResult[];
  gatePass: boolean;
  failing: string[];
  weakest: string | null;
}
