// TAKT — which content is random, discovered rather than declared.
//
// The rng-fishing fix (see `ev.ts`) is expensive: it prices every candidate as a
// mean over several independent rng streams instead of one. Paying that on a line
// of purely deterministic machines is pure waste, and 104 of the 110 machines are
// deterministic.
//
// So we need to know which machines draw from `ctx.rng`. We do NOT hard-code the
// six gamble defs and we do NOT grep the source: either would silently go stale the
// moment content changes, and a stale answer here reopens the exploit without
// failing a test. Instead each `MachineDef.apply` is PROBED at first use — run it on
// a spread of synthetic batches under two different rng streams and see whether
// anything observable (the batch, or the credits it granted) differs. A machine that
// is sensitive to the stream is stochastic, whatever its source says.
//
// The probe is one-shot and cached; it costs a few hundred microseconds per process.
//
// FALSE NEGATIVES are the danger (they reopen the exploit), so the probe is
// deliberately over-broad: many batch shapes, all three levels, both empty and full
// batches, and 8 stream pairs. `tests/bots.test.ts` cross-checks the discovered set
// against the six machines the content set documents as gambles.

import type { Batch, MachineDef, Part, RunCtx, Tag } from '../engine/types.ts';
import { makeRng } from '../engine/rng.ts';
import { getRegistry } from '../content/registry.ts';
import type { AuditDef } from '../content/registry.ts';

const TAGSETS: Tag[][] = [
  ['metal'], ['organic'], ['volatile'], ['precision'], ['scrap'],
  ['metal', 'precision'], ['organic', 'volatile'],
];

function probeBatch(n: number, k: number): Batch {
  const out: Batch = new Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = {
      id: `probe${k}_${i}`,
      def: ['offcut', 'bolt', 'gear', 'pump', 'engine'][(i + k) % 5],
      value: 3 + ((i * 7 + k * 13) % 40),
      tags: TAGSETS[(i + k) % TAGSETS.length],
      mult: 1 + ((i + k) % 3) * 0.5,
    };
  }
  return out;
}

interface ProbeCtx { ctx: RunCtx; granted: { n: number } }

function probeCtx(seed: number): ProbeCtx {
  const granted = { n: 0 };
  return {
    granted,
    ctx: {
      rng: makeRng(seed),
      shift: 4, round: 2, quota: 3000, score: 900, shipmentIndex: 1,
      lineCap: 6, handSize: 8, credits: 30,
      memo: {},
      grantCredits(x: number): void { granted.n += x; },
    },
  };
}

/** Everything about a batch that can change the score or a later machine's read. */
function observe(b: Batch, granted: number): string {
  if (!Array.isArray(b)) return `!${String(b)}`;
  const parts: string[] = new Array(b.length);
  for (let i = 0; i < b.length; i++) {
    const p = b[i] as Part;
    parts[i] = p == null
      ? 'null'
      : `${p.def}:${p.value}:${Math.round(p.mult * 1e6)}:${(p.tags ?? []).join(',')}:${p.sticky ? 1 : 0}`;
  }
  return `${granted}|${parts.join('/')}`;
}

/** True when `apply` is sensitive to the rng stream it is handed. */
function isStochasticApply(
  apply: (b: Batch, c: RunCtx, l: number) => Batch, levels: number[],
): boolean {
  for (let k = 0; k < 8; k++) {
    for (const n of [0, 1, 2, 3, 5, 8]) {
      const b = probeBatch(n, k);
      for (const level of levels) {
        const a = probeCtx(0x51ed270b + k * 7919);
        const z = probeCtx(0x2545f491 + k * 104729);
        let ra: string;
        let rb: string;
        try {
          ra = observe(apply(b, a.ctx, level), a.granted.n);
        } catch { ra = 'throw'; }
        try {
          rb = observe(apply(b, z.ctx, level), z.granted.n);
        } catch { rb = 'throw'; }
        if (ra !== rb) return true;
      }
    }
  }
  return false;
}

let machineCache: Set<string> | null = null;

/** Machine defs whose output depends on the rng stream. Computed once, cached. */
export function stochasticMachineDefs(): Set<string> {
  if (machineCache !== null) return machineCache;
  const out = new Set<string>();
  for (const def of getRegistry().machines.values()) {
    if (isStochasticApply((b, c, l) => (def as MachineDef).apply(b, c, l), [1, 2, 3])) {
      out.add(def.def);
    }
  }
  machineCache = out;
  return out;
}

let auditCache: boolean[] | null = null;

/** Per shift (index = shift-1): does that shift's Audit read the rng stream? */
export function stochasticAudits(): boolean[] {
  if (auditCache !== null) return auditCache;
  auditCache = getRegistry().audits.map((a: AuditDef) =>
    isStochasticApply((b, c) => a.modify(b, c), [1]));
  return auditCache;
}

/** Reset the caches. Only for tests that install a different registry. */
export function resetStochasticCache(): void {
  machineCache = null;
  auditCache = null;
}
