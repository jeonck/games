# The Gate

This file decides whether TAKT is finished. It is written **before** the game
exists so that the thresholds cannot be quietly relaxed to fit whatever we
happen to build.

## Rules of the gate

1. Thresholds are set here, once. Changing a threshold requires writing the
   change, the date, the reason, and the metric value that motivated it into
   the Amendments section at the bottom. A silent edit is cheating.
2. The gate runs on **≥ 20,000 simulated runs** per bot tier, fresh seeds.
3. A metric is either PASS or FAIL. There is no partial credit and no "close
   enough".
4. **The gate failing is an acceptable outcome and gets reported as plainly as
   a pass.** The purpose of this file is to be able to say "no".

## Honest limitation, stated up front

These thresholds are derived from design reasoning about what a deep
build-expression roguelike must look like numerically. They are **not**
measured against Balatro or Slay the Spire — those games cannot be run
headlessly here, so no empirical competitor baseline exists. That means:

> Passing this gate proves the game has measurable strategic depth and no
> dominant strategy. **It does not prove the game would be #1 on the App
> Store.** Chart position is decided by discovery, price, featuring, timing and
> streamer luck — none of which are in this repository. Passing means "the
> mechanic is not the reason it would fail". Nothing more.

---

## G1 — Skill gap (primary)

The reason a game is worth $10 is that playing it better makes you win more. If
thinking does not beat not-thinking, there is no game.

| Metric | Threshold |
|---|---|
| G1.1 `random` win rate | **< 2%** |
| G1.2 `greedy` win rate | **8% – 25%** |
| G1.3 `planner` win rate | **40% – 60%** |
| G1.4 `oracle` win rate | **65% – 88%** |
| G1.5 `planner ÷ greedy` win rate ratio | **≥ 2.5×** |
| G1.6 `oracle − planner` win rate | **≥ 10 percentage points** |

G1.5 says ordering and per-hand optimization matter. G1.6 says there is still
headroom above solving the current hand — i.e. long-term planning is a real
skill, so mastery has somewhere to go.

## G2 — Ordering is load-bearing (the product claim)

TAKT's entire differentiation is that machine order is the game. If these fail,
we built a worse Balatro.

| Metric | Threshold |
|---|---|
| G2.1 Median score gain from optimal reorder vs. arrival order | **≥ 25%** |
| G2.2 Rounds where the optimal ordering differs from the previous round's | **≥ 50%** |
| G2.3 Non-commutative machine pairs (`A∘B ≠ B∘A` on random batches) | **≥ 60%** |

G2.2 is the one that matters most. If the best order is found once and never
changes, reordering is a puzzle you solve at minute three and then never think
about again.

## G3 — Build diversity (no dominant strategy)

| Metric | Threshold |
|---|---|
| G3.1 Most-used archetype's share of `planner` wins | **≤ 55%** |
| G3.2 Archetypes appearing in ≥ 15% of wins | **≥ 5** |
| G3.3 Normalized Shannon entropy over archetype usage in wins | **≥ 0.80** |
| G3.4 Any single machine def in > 60% of wins | **0 such machines** |

G3.4 catches the classic failure: one accidentally-overtuned card that every
winning run takes.

## G4 — Tension curve

| Metric | Threshold |
|---|---|
| G4.1 `planner` win rate (same as G1.3) | **40% – 60%** |
| G4.2 Largest share of losses concentrated in any single shift | **≤ 35%** |
| G4.3 Runs lost in shifts 1–2 | **≤ 20%** of all losses |

G4.2/G4.3 catch difficulty walls. A game that kills 60% of its losses at one
shift has a tuning bug, not a difficulty curve. Early deaths feel like the game
wasted your time.

## G5 — Snowball ceiling (the "broken run" high)

| Metric | Threshold |
|---|---|
| G5.1 p95 final-shift score ÷ final quota | **≥ 20×** |
| G5.2 p99 ÷ p50 final-shift score | **≥ 50×** |

This is the screenshot-and-post moment. Without a fat right tail there is no
word of mouth, and word of mouth is the only free distribution a premium game
gets.

## G6 — Decisions are non-obvious

| Metric | Threshold |
|---|---|
| G6.1 Shipment decisions where 2nd-best is within 10% of best | **20% – 45%** |

Below 20%: the right move is always obvious, so the player is executing, not
deciding. Above 45%: the choices barely matter, so the player is guessing.

## G7 — Session shape

| Metric | Threshold |
|---|---|
| G7.1 Median `planner` run length | **120 – 260 decisions** |
| G7.2 Median winning-run wall-clock estimate | **15 – 35 min** |

---

## Verdict format

Every loop iteration appends a row to `docs/bench/RESULTS.md`:

```
## Iteration N — <date> — <commit>
G1.1 <value> PASS/FAIL   ... (all metrics)
GATE: PASS | FAIL (n failing: <list>)
Weakest metric: <id> — next loop targets this.
```

The loop stops when GATE is PASS, or when a Critic pass concludes the gate is
unreachable with this design and says why.

---

## Amendments

*(none yet — every entry here must state date, metric, old value, new value,
reason, and what was measured that motivated it)*
