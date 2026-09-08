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
| G2.2 Rounds where the optimal ordering differs from the previous round's | **≤ 30%** (amended) |
| G2.4 Shift boundaries where the optimal ordering changes | **≥ 60%** (new) |
| G2.3 Non-commutative machine pairs (`A∘B ≠ B∘A` on random batches) | **≥ 60%** |

G2.2 and G2.4 together are the ones that matter most, and their direction was
**reversed by amendment A1** — see Amendments. The original G2.2 demanded the
optimal order change *every round*, which would have been a formal requirement
that the player's structure be invalidated three times per shift. The corrected
pair asks for a line that is **stable within a shift and restructured between
shifts**: reordering stays a live decision (G2.4) without becoming a chore
(G2.2). If the best order is found once and never changes at all, both fail and
reordering is a puzzle solved at minute three.

## G3 — Build diversity (no dominant strategy)

| Metric | Threshold |
|---|---|
| G3.1 Most-used archetype's share of `planner` wins, **starter line excluded** | **≤ 55%** (amended A2) |
| G3.2 Archetypes appearing in ≥ 15% of wins | **≥ 5** |
| G3.3 Normalized Shannon entropy over archetype usage in wins | **≥ 0.80** |
| G3.4 Any single **acquired** machine def in > 60% of wins | **0 such machines** (amended A2) |

G3.4 catches the classic failure: one accidentally-overtuned card that every
winning run takes. **Both metrics count only machines the player chose to
acquire** — see amendment A2. Counting the fixed starter line made them measure
the starter line rather than the player's build.

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

### A1 — 2026-09-07 — G2.2 direction reversed, G2.4 added

- **Metric:** G2.2, "rounds where the optimal ordering differs from the previous round's"
- **Old:** ≥ 50%   **New:** ≤ 30%, plus a new G2.4 (shift boundaries where the
  optimal ordering changes, ≥ 60%)
- **What motivated it:** not a measurement — a design review. An outside veteran
  designer (`docs/design/VETERAN-REVIEW.md`) observed that G2.2 was *at war with
  the game's own fantasy*. A factory game sells the feeling of owning a machine
  you built that runs without you. A metric demanding the optimal order change
  every round is a formal guarantee that the line never becomes the player's —
  it makes reordering homework three times per shift rather than a structural
  decision. The metric was measuring depth by pricing it in ownership, and
  ownership is the reason the factory metaphor was chosen in the first place.
- **Honest note, as originally written:** "this amendment *relaxes* a threshold,
  which is exactly the move this file exists to prevent... If a later reader judges
  this to be goalpost-moving, the record is here to be judged on."

- **CORRECTION — 2026-09-07, after the Chart Critic's audit. The note above is
  false, and it was false in the author's own favour's opposite direction.** The
  amendment does not relax anything for this build. Measured: the shipped content
  scores **65.96% against the old threshold (≥ 50%) — a PASS**, and **64.04%
  against the amended threshold (≤ 30%) — a FAIL**. A1 made the gate *harder* to
  pass, not easier. The author confessed twice, in this file and in the reviewer
  brief, to a goalpost-move that the numbers say did not happen. Self-criticism is
  not a substitute for checking, and this entry is left standing as the evidence
  of that.

- **SECOND DEFECT, same audit: A1 never reached the code.** `src/sim/gate.ts` was
  amended in this document and nowhere else, so it kept scoring the retired
  `≥ 50%` threshold. **Iterations 1, 2 and 3 all printed `G2.2 ... PASS` against a
  threshold this file had already retired.** The true failing count for iteration 3
  is **10, not 9** — G2.2 fails under its own amended definition. The supplement
  block in `docs/bench/RESULTS.md`, written by the simulation agent, carried the
  correct amended figures the whole time; nobody reconciled them with the gate's
  own scoring. The A2 amendment below was wired into the CLI specifically to avoid
  repeating this, but G2.2 itself remains unwired: it needs the telemetry to
  distinguish within-shift from across-boundary transitions, which the frozen
  `RunRecord` cannot currently express.

### A2 — 2026-09-07 — G3.1 and G3.4 exclude the fixed starter line

- **Metrics:** G3.1 (most-used archetype's share of wins), G3.4 (any single
  machine def in > 60% of wins)
- **Old:** computed over every machine on the line at the end of a run.
  **New:** computed over acquired machines only — the fixed starter line is
  excluded from both.
- **What was measured that motivated it:** iteration 3, 20,000 planner runs.
  G3.1 = 100.00% and G3.4 = 3 — and both were 100% / 3 in iteration 1 as well, on
  different content, before and after a balance pass that changed the game
  substantially. A metric that returns the same value regardless of the thing it
  claims to measure is not measuring it.
- **The defect:** every run begins with the same line — `press` (arithmetic),
  `foundry` (transmutation), `doubler` (arithmetic). Both metrics are computed as
  *presence* — "does this appear in a winning run" — so `arithmetic` is in 100% of
  wins and those three defs are in 100% of wins by construction, whatever the
  player builds. The threshold was unreachable no matter how diverse builds were.
- **Why this is a correction and not goalpost-moving:** G3.4's own rationale in
  this file reads "catches the classic failure: one accidentally-overtuned card
  that every winning run takes." A starter machine is not an overtuned card the
  player took; it is a machine the player was handed. The amended metric measures
  what the original rationale describes. The ambiguity was in the spec — "share of
  wins" was written intending a usage distribution and implemented as presence,
  and both readings are defensible from the original wording.
- **Honest note (corrected 2026-09-07):** this is the second amendment in this
  project. It was written claiming to be "the second to make a threshold easier to
  reach"; the audit above shows A1 in fact made its threshold *harder*, so A2 is
  the first and so far only relaxation. Two relaxations by the same author who set the
  thresholds is a pattern worth distrusting on its face, and the reviewer brief for
  this project asks the critic to judge exactly that. Two facts are offered in
  defence, both checkable: the defect reproduces identically across two different
  content sets, and it was reported by the simulation agent before the coordinator
  noticed it. Neither fact settles the question.
