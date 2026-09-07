# TAKT — benchmark results

_Appended by `src/sim/cli.ts`. Each iteration is one sweep of every tier on one shared seed set, scored against `docs/bench/BENCHMARK.md`._

## Iteration 1 — 2026-09-07 — b6cd207

**NOT MEASURED (1): G1.5** — no samples reached the gate for these. They are counted as FAIL: an unmeasured threshold is not a met threshold.

| tier | runs | win rate | 95% CI (Wilson) | median decisions | median win time |
|---|---:|---:|---|---:|---:|
| `random` | 20,000 | 0.00% | [0.00%, 0.02%] | 16 | n/a |
| `greedy` | 20,000 | 0.00% | [0.00%, 0.02%] | 30 | n/a |
| `planner` | 20,000 | 15.93% | [15.42%, 16.44%] | 171 | 33.0 min |
| `oracle` | 20,000 | 15.39% | [14.90%, 15.90%] | 181 | 22.8 min |

```text
G1.1 0.00% PASS   threshold: < 2%   95% CI [0.00%, 0.02%]   random win rate
G1.2 0.00% FAIL   threshold: 8% – 25%   95% CI [0.00%, 0.02%]   off by 100.0%   greedy win rate
G1.3 15.93% FAIL   threshold: 40% – 60%   95% CI [15.42%, 16.44%]   off by 60.2%   planner win rate
G1.4 15.39% FAIL   threshold: 65% – 88%   95% CI [14.90%, 15.90%]   off by 76.3%   oracle win rate
G1.5 n/a (not measured) FAIL   threshold: ≥ 2.5×   95% CI [803.21×, ∞]   planner / greedy win-rate ratio
G1.6 -0.53 pp FAIL   threshold: ≥ 10 percentage points   95% CI [-1.25 pp, 0.18 pp]   off by 105.4%   oracle − planner win rate
G2.1 47.59% PASS   threshold: ≥ 25%   median score gain from optimal reorder
G2.2 63.77% PASS   threshold: ≥ 50%   rounds where optimal ordering changed
G2.3 62.73% PASS   threshold: ≥ 60%   non-commutative machine pairs
G3.1 100.00% FAIL   threshold: ≤ 55%   off by 81.8%   most-used archetype share of planner wins
G3.2 7 PASS   threshold: ≥ 5   archetypes appearing in ≥ 15% of wins
G3.3 0.947 PASS   threshold: ≥ 0.80   normalized Shannon entropy over archetype usage
G3.4 3 FAIL   threshold: 0 such machines   off by 3   machine defs in > 60% of wins
G4.1 15.93% FAIL   threshold: 40% – 60%   95% CI [15.42%, 16.44%]   off by 60.2%   planner win rate (tension)
G4.2 43.58% FAIL   threshold: ≤ 35%   off by 24.5%   largest share of losses in one shift
G4.3 3.37% PASS   threshold: ≤ 20%   losses in shifts 1–2
G5.1 4.00× FAIL   threshold: ≥ 20×   off by 80.0%   p95 final score / final quota
G5.2 51.94× PASS   threshold: ≥ 50×   p99 / p50 final score
G6.1 83.33% FAIL   threshold: 20% – 45%   off by 85.2%   shipments where 2nd-best is within 10% of best
G7.1 171 PASS   threshold: 120 – 260 decisions   median planner run length
G7.2 33.0 min PASS   threshold: 15 – 35 min   median winning-run wall clock
```

GATE: FAIL (11 failing: G1.2, G1.3, G1.4, G1.5, G1.6, G3.1, G3.4, G4.1, G4.2, G5.1, G6.1)

Weakest metric: G3.4 — next loop targets this.

_Passing this gate means the mechanic is not the reason the game would fail. It does not predict chart position — see the stated limitation in docs/bench/BENCHMARK.md._

### Supplement — measurements the frozen gate does not carry

_Produced by `src/sim/analysis.ts`. `src/sim/gate.ts` is frozen for this agent and still scores the PRE-AMENDMENT G2.2 (`≥ 50%`) and has no G2.4; the amended pair from `docs/bench/BENCHMARK.md` §A1 is computed here._

| metric | value | n | threshold (amended) | verdict |
|---|---:|---:|---|---|
| G2.2 optimal order changed, WITHIN a shift | 62.20% | 236090 | ≤ 30% | FAIL |
| G2.4 optimal order changed, ACROSS a shift boundary | 67.57% | 98122 | ≥ 60% | PASS |
| (gate.ts's G2.2: all transitions pooled) | 63.77% | 334212 | — | — |
| strict variant, within a shift (full def sequence) | 69.84% | 236090 | — | — |
| strict variant, across a boundary | 71.67% | 98122 | — | — |

`optOrderChanged` compares the RELATIVE order of the machines the line kept between the two rounds; the strict variant compares the full def sequence, so buying a machine counts as a change on its own. Both are reported so the choice is the reader's.

#### G6.1 read two ways

| reading | value | n | threshold |
|---|---:|---:|---|
| 2nd-best ORDERED SELECTION within 10% (what gate.ts scores) | 83.33% | 1764974 | 20–45% |
| …of those, exact ties | 53.04% | 1764974 | — |
| 2nd-best DIFFERENT-SUBSET shipment within 10% | 83.33% | 1764974 | — |

The first runner-up is usually the same shipment with one scoreless part added or two commuting parts swapped, which ties exactly. The second asks whether a genuinely different shipment was nearly as good.

#### Losses by round type — where runs actually die

| tier | round 1 | round 2 | Audit (round 3) | losses |
|---|---:|---:|---:|---:|
| `random` | 0.56% | 25.38% | **74.06%** | 20000 |
| `greedy` | 0.07% | 0.66% | **99.27%** | 20000 |
| `planner` | 0.11% | 0.70% | **99.19%** | 16815 |
| `oracle` | 0.04% | 0.33% | **99.63%** | 16922 |

G4.2/G4.3 measure loss concentration across SHIFTS. This table measures it across ROUND TYPES, which the gate has no metric for. A third of rounds are Audits, so a healthy game concentrates roughly a third of its losses here.

#### Per-Audit kill rates (`planner`)

| shift | Audit | reached | died on it | kill rate | share of all losses |
|---:|---|---:|---:|---:|---:|
| 1 | Spot Check (`spot_check`) | 19999 | 134 | 0.67% | 0.80% |
| 2 | Tolerance Check (`tolerance_check`) | 19858 | 425 | 2.14% | 2.53% |
| 3 | Weight Limit (`weight_limit`) | 19415 | 666 | 3.43% | 3.96% |
| 4 | Line Freeze (`line_freeze`) | 18718 | 1158 | 6.19% | 6.89% |
| 5 | Monoculture Review (`monoculture`) | 17514 | 7282 | 41.58% | 43.31% |
| 6 | Parts Embargo (`parts_embargo`) | 10216 | 2214 | 21.67% | 13.17% |
| 7 | Ratio Control (`ratio_control`) | 7987 | 3706 | 46.40% | 22.04% |
| 8 | Final Inspection (`final_inspection`) | 4279 | 1094 | 25.57% | 6.51% |

#### Bot integrity

Strict dominance (oracle ≥ planner ≥ greedy ≥ random) on 20000 shared seeds: **VIOLATED**

- `oracle - planner` = -0.53 pp
- `planner - greedy` = 15.93 pp
- `greedy - random` = 0.00 pp

**INVERSION — this is a bug in the bots, not a finding about the game:**
- oracle (15.39%) < planner (15.93%)

Planner search coverage, per shipment decision:

- ordered selections scored: median **261**, min 31, max 519
- the full ordered-selection space from a hand of 8 at 1–5 parts is **8,800**; all 218 SUBSETS are enumerated exactly, and ordering search is bounded (best-insertion + swap descent) on the best few
- `previewShipment` calls per run: median **104,297**
- runs where a search hit its preview budget: 3933

Throughput:

| tier | ms/run/core | runs/s/core | wall for this sweep |
|---|---:|---:|---:|
| `random` | 0.2 | 5087.68 | 1.2s |
| `greedy` | 8.9 | 112.10 | 45.0s |
| `planner` | 219.7 | 4.55 | 1113.9s |
| `oracle` | 684.5 | 1.46 | 3435.1s |

Content self-measurement fed to G2.3: non-commutative machine pairs = 62.73% over 20,000 trials (57.45% including 1-part batches).

#### The rng-fishing exploit, priced

On the same 2000 seeds:

| planner | win rate |
|---|---:|
| with the fix (expected value over independent rng streams) | 15.00% |
| with the bug (evaluated on the stream `playShipment` will use) | 16.00% |
| difference | 1.00 pp |

The bug is not "the bot gets luckier". It is that `previewShipment` is exact, so a searching bot reads every coin flip in the line before it commits and sizes its shipment to the answer. See `src/bots/ev.ts`.


---

## Iteration 2 — 2026-09-07 — 2228b50

⚠ UNDERSAMPLED (n=1500) — tier `random` is below the 20,000-run floor set by the gate.
⚠ UNDERSAMPLED (n=1500) — tier `greedy` is below the 20,000-run floor set by the gate.
⚠ UNDERSAMPLED (n=1500) — tier `planner` is below the 20,000-run floor set by the gate.
⚠ UNDERSAMPLED (n=1500) — tier `oracle` is below the 20,000-run floor set by the gate.

**GATE FORCED TO FAIL: a gate passed on thin data is not passed.**

**NOT MEASURED (1): G1.5** — no samples reached the gate for these. They are counted as FAIL: an unmeasured threshold is not a met threshold.

**MARGINAL (3): G1.3, G1.4, G4.1** — the 95% Wilson interval straddles the threshold, so the verdict on these rows would flip inside sampling noise. Treat as unproven in either direction.

| tier | runs | win rate | 95% CI (Wilson) | median decisions | median win time |
|---|---:|---:|---|---:|---:|
| `random` ⚠ | 1,500 | 0.00% | [0.00%, 0.26%] | 30 | n/a |
| `greedy` ⚠ | 1,500 | 0.00% | [0.00%, 0.26%] | 44 | n/a |
| `planner` ⚠ | 1,500 | 60.00% | [57.50%, 62.45%] | 256 | 24.1 min |
| `oracle` ⚠ | 1,500 | 66.33% | [63.90%, 68.68%] | 259 | 24.0 min |

```text
G1.1 0.00% PASS   threshold: < 2%   95% CI [0.00%, 0.26%]   random win rate
G1.2 0.00% FAIL   threshold: 8% – 25%   95% CI [0.00%, 0.26%]   off by 100.0%   greedy win rate
G1.3 60.00% PASS MARGINAL   threshold: 40% – 60%   95% CI [57.50%, 62.45%]   planner win rate
G1.4 66.33% PASS MARGINAL   threshold: 65% – 88%   95% CI [63.90%, 68.68%]   oracle win rate
G1.5 n/a (not measured) FAIL   threshold: ≥ 2.5×   95% CI [225.09×, ∞]   planner / greedy win-rate ratio
G1.6 6.33 pp FAIL   threshold: ≥ 10 percentage points   95% CI [2.88 pp, 9.76 pp]   off by 36.7%   oracle − planner win rate
G2.1 55.61% PASS   threshold: ≥ 25%   median score gain from optimal reorder
G2.2 65.71% PASS   threshold: ≥ 50%   rounds where optimal ordering changed
G2.3 62.73% PASS   threshold: ≥ 60%   non-commutative machine pairs
G3.1 100.00% FAIL   threshold: ≤ 55%   off by 81.8%   most-used archetype share of planner wins
G3.2 7 PASS   threshold: ≥ 5   archetypes appearing in ≥ 15% of wins
G3.3 0.941 PASS   threshold: ≥ 0.80   normalized Shannon entropy over archetype usage
G3.4 3 FAIL   threshold: 0 such machines   off by 3   machine defs in > 60% of wins
G4.1 60.00% PASS MARGINAL   threshold: 40% – 60%   95% CI [57.50%, 62.45%]   planner win rate (tension)
G4.2 46.50% FAIL   threshold: ≤ 35%   off by 32.9%   largest share of losses in one shift
G4.3 0.17% PASS   threshold: ≤ 20%   losses in shifts 1–2
G5.1 11.44× FAIL   threshold: ≥ 20×   off by 42.8%   p95 final score / final quota
G5.2 16.80× FAIL   threshold: ≥ 50×   off by 66.4%   p99 / p50 final score
G6.1 81.76% FAIL   threshold: 20% – 45%   off by 81.7%   shipments where 2nd-best is within 10% of best
G7.1 256 PASS   threshold: 120 – 260 decisions   median planner run length
G7.2 24.1 min PASS   threshold: 15 – 35 min   median winning-run wall clock
```

GATE: FAIL (9 failing: G1.2, G1.5, G1.6, G3.1, G3.4, G4.2, G5.1, G5.2, G6.1)

Weakest metric: G3.4 — next loop targets this.

_Passing this gate means the mechanic is not the reason the game would fail. It does not predict chart position — see the stated limitation in docs/bench/BENCHMARK.md._

### Supplement — measurements the frozen gate does not carry

_Produced by `src/sim/analysis.ts`. `src/sim/gate.ts` is frozen for this agent and still scores the PRE-AMENDMENT G2.2 (`≥ 50%`) and has no G2.4; the amended pair from `docs/bench/BENCHMARK.md` §A1 is computed here._

| metric | value | n | threshold (amended) | verdict |
|---|---:|---:|---|---|
| G2.2 optimal order changed, WITHIN a shift | 63.58% | 22397 | ≤ 30% | FAIL |
| G2.4 optimal order changed, ACROSS a shift boundary | 70.60% | 9715 | ≥ 60% | PASS |
| (gate.ts's G2.2: all transitions pooled) | 65.71% | 32112 | — | — |
| strict variant, within a shift (full def sequence) | 70.00% | 22397 | — | — |
| strict variant, across a boundary | 74.15% | 9715 | — | — |

`optOrderChanged` compares the RELATIVE order of the machines the line kept between the two rounds; the strict variant compares the full def sequence, so buying a machine counts as a change on its own. Both are reported so the choice is the reader's.

#### G6.1 read two ways

| reading | value | n | threshold |
|---|---:|---:|---|
| 2nd-best ORDERED SELECTION within 10% (what gate.ts scores) | 81.76% | 172148 | 20–45% |
| …of those, exact ties | 51.20% | 172148 | — |
| 2nd-best DIFFERENT-SUBSET shipment within 10% | 81.76% | 172148 | — |

The first runner-up is usually the same shipment with one scoreless part added or two commuting parts swapped, which ties exactly. The second asks whether a genuinely different shipment was nearly as good.

#### Losses by round type — where runs actually die

| tier | round 1 | round 2 | Audit (round 3) | losses |
|---|---:|---:|---:|---:|
| `random` | 5.33% | 18.93% | **75.73%** | 1500 |
| `greedy` | 7.47% | 27.27% | **65.27%** | 1500 |
| `planner` | 0.83% | 3.83% | **95.33%** | 600 |
| `oracle` | 0.20% | 3.56% | **96.24%** | 505 |

G4.2/G4.3 measure loss concentration across SHIFTS. This table measures it across ROUND TYPES, which the gate has no metric for. A third of rounds are Audits, so a healthy game concentrates roughly a third of its losses here.

#### Per-Audit kill rates, by name

_"reached" = runs that got past round 2 of that shift. "kill rate" = of the runs that faced this Audit, the share it ended. This is the table the rebalance should be steered by: a per-shift histogram cannot show it, because the concentration is on the ROUND axis, not the shift axis._

`random`

| shift | Audit | reached | died on it | kill rate | share of all losses |
|---:|---|---:|---:|---:|---:|
| 1 | Spot Check (`spot_check`) | 1473 | 634 | 43.04% | 42.27% |
| 2 | Tolerance Check (`tolerance_check`) | 734 | 308 | 41.96% | 20.53% |
| 3 | Weight Limit (`weight_limit`) | 279 | 153 | 54.84% | 10.20% |
| 4 | Line Freeze (`line_freeze`) | 75 | 21 | 28.00% | 1.40% |
| 5 | Monoculture Review (`monoculture`) | 21 | 19 | 90.48% | 1.27% |
| 6 | Parts Embargo (`parts_embargo`) | 1 | 1 | 100.00% | 0.07% |
| 7 | Ratio Control (`ratio_control`) | 0 | 0 | n/a | 0.00% |
| 8 | Final Inspection (`final_inspection`) | 0 | 0 | n/a | 0.00% |

`greedy`

| shift | Audit | reached | died on it | kill rate | share of all losses |
|---:|---|---:|---:|---:|---:|
| 1 | Spot Check (`spot_check`) | 1500 | 66 | 4.40% | 4.40% |
| 2 | Tolerance Check (`tolerance_check`) | 1432 | 53 | 3.70% | 3.53% |
| 3 | Weight Limit (`weight_limit`) | 1308 | 724 | 55.35% | 48.27% |
| 4 | Line Freeze (`line_freeze`) | 201 | 136 | 67.66% | 9.07% |
| 5 | Monoculture Review (`monoculture`) | 0 | 0 | n/a | 0.00% |
| 6 | Parts Embargo (`parts_embargo`) | 0 | 0 | n/a | 0.00% |
| 7 | Ratio Control (`ratio_control`) | 0 | 0 | n/a | 0.00% |
| 8 | Final Inspection (`final_inspection`) | 0 | 0 | n/a | 0.00% |

`planner`

| shift | Audit | reached | died on it | kill rate | share of all losses |
|---:|---|---:|---:|---:|---:|
| 1 | Spot Check (`spot_check`) | 1500 | 0 | 0.00% | 0.00% |
| 2 | Tolerance Check (`tolerance_check`) | 1500 | 1 | 0.07% | 0.17% |
| 3 | Weight Limit (`weight_limit`) | 1498 | 0 | 0.00% | 0.00% |
| 4 | Line Freeze (`line_freeze`) | 1498 | 2 | 0.13% | 0.33% |
| 5 | Monoculture Review (`monoculture`) | 1495 | 174 | 11.64% | 29.00% |
| 6 | Parts Embargo (`parts_embargo`) | 1316 | 94 | 7.14% | 15.67% |
| 7 | Ratio Control (`ratio_control`) | 1216 | 37 | 3.04% | 6.17% |
| 8 | Final Inspection (`final_inspection`) | 1164 | 264 | 22.68% | 44.00% |

`oracle`

| shift | Audit | reached | died on it | kill rate | share of all losses |
|---:|---|---:|---:|---:|---:|
| 1 | Spot Check (`spot_check`) | 1500 | 0 | 0.00% | 0.00% |
| 2 | Tolerance Check (`tolerance_check`) | 1500 | 1 | 0.07% | 0.20% |
| 3 | Weight Limit (`weight_limit`) | 1499 | 0 | 0.00% | 0.00% |
| 4 | Line Freeze (`line_freeze`) | 1499 | 0 | 0.00% | 0.00% |
| 5 | Monoculture Review (`monoculture`) | 1498 | 133 | 8.88% | 26.34% |
| 6 | Parts Embargo (`parts_embargo`) | 1365 | 71 | 5.20% | 14.06% |
| 7 | Ratio Control (`ratio_control`) | 1287 | 31 | 2.41% | 6.14% |
| 8 | Final Inspection (`final_inspection`) | 1245 | 250 | 20.08% | 49.50% |

#### Bot integrity

Strict dominance (oracle ≥ planner ≥ greedy ≥ random) on 1500 shared seeds: **HOLDS**

- `oracle - planner` = 6.33 pp
- `planner - greedy` = 60.00 pp
- `greedy - random` = 0.00 pp

Planner search coverage, per shipment decision:

- ordered selections scored: median **250**, min 31, max 518
- the full ordered-selection space from a hand of 8 at 1–5 parts is **8,800**; all 218 SUBSETS are enumerated exactly, and ordering search is bounded (best-insertion + swap descent) on the best few
- `previewShipment` calls per run: median **142,549**
- runs where a search hit its preview budget: 462

Throughput:

| tier | ms/run/core | runs/s/core | wall for this sweep |
|---|---:|---:|---:|
| `random` | 0.9 | 1137.25 | 0.5s |
| `greedy` | 16.4 | 60.83 | 6.4s |
| `planner` | 240.1 | 4.16 | 94.8s |
| `oracle` | 999.1 | 1.00 | 395.4s |

Content self-measurement fed to G2.3: non-commutative machine pairs = 62.73% over 20,000 trials (57.45% including 1-part batches).

#### The rng-fishing exploit, priced

On the same 1000 seeds:

| planner | win rate |
|---|---:|
| with the fix (expected value over independent rng streams) | 60.50% |
| with the bug (evaluated on the stream `playShipment` will use) | 58.50% |
| difference | -2.00 pp |

The bug is not "the bot gets luckier". It is that `previewShipment` is exact, so a searching bot reads every coin flip in the line before it commits and sizes its shipment to the answer. See `src/bots/ev.ts`.


---

## Iteration 3 — 2026-09-07 — 66a3c50

**NOT MEASURED (1): G1.5** — no samples reached the gate for these. They are counted as FAIL: an unmeasured threshold is not a met threshold.

**MARGINAL (1): G1.4** — the 95% Wilson interval straddles the threshold, so the verdict on these rows would flip inside sampling noise. Treat as unproven in either direction.

| tier | runs | win rate | 95% CI (Wilson) | median decisions | median win time |
|---|---:|---:|---|---:|---:|
| `random` | 20,000 | 0.00% | [0.00%, 0.02%] | 29 | n/a |
| `greedy` | 20,000 | 0.00% | [0.00%, 0.02%] | 43 | n/a |
| `planner` | 20,000 | 58.61% | [57.93%, 59.29%] | 255 | 24.3 min |
| `oracle` | 20,000 | 65.30% | [64.63%, 65.95%] | 258 | 24.0 min |

```text
G1.1 0.00% PASS   threshold: < 2%   95% CI [0.00%, 0.02%]   random win rate
G1.2 0.00% FAIL   threshold: 8% – 25%   95% CI [0.00%, 0.02%]   off by 100.0%   greedy win rate
G1.3 58.61% PASS   threshold: 40% – 60%   95% CI [57.93%, 59.29%]   planner win rate
G1.4 65.30% PASS MARGINAL   threshold: 65% – 88%   95% CI [64.63%, 65.95%]   oracle win rate
G1.5 n/a (not measured) FAIL   threshold: ≥ 2.5×   95% CI [3016.40×, ∞]   planner / greedy win-rate ratio
G1.6 6.69 pp FAIL   threshold: ≥ 10 percentage points   95% CI [5.73 pp, 7.63 pp]   off by 33.1%   oracle − planner win rate
G2.1 55.92% PASS   threshold: ≥ 25%   median score gain from optimal reorder
G2.2 65.96% PASS   threshold: ≥ 50%   rounds where optimal ordering changed
G2.3 62.73% PASS   threshold: ≥ 60%   non-commutative machine pairs
G3.1 100.00% FAIL   threshold: ≤ 55%   off by 81.8%   most-used archetype share of planner wins
G3.2 7 PASS   threshold: ≥ 5   archetypes appearing in ≥ 15% of wins
G3.3 0.943 PASS   threshold: ≥ 0.80   normalized Shannon entropy over archetype usage
G3.4 3 FAIL   threshold: 0 such machines   off by 3   machine defs in > 60% of wins
G4.1 58.61% PASS   threshold: 40% – 60%   95% CI [57.93%, 59.29%]   planner win rate (tension)
G4.2 45.59% FAIL   threshold: ≤ 35%   off by 30.3%   largest share of losses in one shift
G4.3 0.37% PASS   threshold: ≤ 20%   losses in shifts 1–2
G5.1 12.10× FAIL   threshold: ≥ 20×   off by 39.5%   p95 final score / final quota
G5.2 19.88× FAIL   threshold: ≥ 50×   off by 60.2%   p99 / p50 final score
G6.1 81.81% FAIL   threshold: 20% – 45%   off by 81.8%   shipments where 2nd-best is within 10% of best
G7.1 255 PASS   threshold: 120 – 260 decisions   median planner run length
G7.2 24.3 min PASS   threshold: 15 – 35 min   median winning-run wall clock
```

GATE: FAIL (9 failing: G1.2, G1.5, G1.6, G3.1, G3.4, G4.2, G5.1, G5.2, G6.1)

Weakest metric: G3.4 — next loop targets this.

_Passing this gate means the mechanic is not the reason the game would fail. It does not predict chart position — see the stated limitation in docs/bench/BENCHMARK.md._

### Supplement — measurements the frozen gate does not carry

_Produced by `src/sim/analysis.ts`. `src/sim/gate.ts` is frozen for this agent and still scores the PRE-AMENDMENT G2.2 (`≥ 50%`) and has no G2.4; the amended pair from `docs/bench/BENCHMARK.md` §A1 is computed here._

| metric | value | n | threshold (amended) | verdict |
|---|---:|---:|---|---|
| G2.2 optimal order changed, WITHIN a shift | 64.04% | 297622 | ≤ 30% | FAIL |
| G2.4 optimal order changed, ACROSS a shift boundary | 70.41% | 129056 | ≥ 60% | PASS |
| (gate.ts's G2.2: all transitions pooled) | 65.96% | 426678 | — | — |
| strict variant, within a shift (full def sequence) | 70.55% | 297622 | — | — |
| strict variant, across a boundary | 73.96% | 129056 | — | — |

`optOrderChanged` compares the RELATIVE order of the machines the line kept between the two rounds; the strict variant compares the full def sequence, so buying a machine counts as a change on its own. Both are reported so the choice is the reader's.

#### G6.1 read two ways

| reading | value | n | threshold |
|---|---:|---:|---|
| 2nd-best ORDERED SELECTION within 10% (what gate.ts scores) | 81.81% | 2282783 | 20–45% |
| …of those, exact ties | 51.35% | 2282783 | — |
| 2nd-best DIFFERENT-SUBSET shipment within 10% | 81.81% | 2282783 | — |

The first runner-up is usually the same shipment with one scoreless part added or two commuting parts swapped, which ties exactly. The second asks whether a genuinely different shipment was nearly as good.

#### Losses by round type — where runs actually die

| tier | round 1 | round 2 | Audit (round 3) | losses |
|---|---:|---:|---:|---:|
| `random` | 5.25% | 18.54% | **76.20%** | 20000 |
| `greedy` | 7.08% | 24.44% | **68.47%** | 20000 |
| `planner` | 0.77% | 4.37% | **94.85%** | 8278 |
| `oracle` | 0.72% | 3.17% | **96.11%** | 6941 |

G4.2/G4.3 measure loss concentration across SHIFTS. This table measures it across ROUND TYPES, which the gate has no metric for. A third of rounds are Audits, so a healthy game concentrates roughly a third of its losses here.

#### Per-Audit kill rates, by name

_"reached" = runs that got past round 2 of that shift. "kill rate" = of the runs that faced this Audit, the share it ended. This is the table the rebalance should be steered by: a per-shift histogram cannot show it, because the concentration is on the ROUND axis, not the shift axis._

`random`

| shift | Audit | reached | died on it | kill rate | share of all losses |
|---:|---|---:|---:|---:|---:|
| 1 | Spot Check (`spot_check`) | 19731 | 8755 | 44.37% | 43.77% |
| 2 | Tolerance Check (`tolerance_check`) | 9461 | 3892 | 41.14% | 19.46% |
| 3 | Weight Limit (`weight_limit`) | 3632 | 2030 | 55.89% | 10.15% |
| 4 | Line Freeze (`line_freeze`) | 926 | 301 | 32.51% | 1.50% |
| 5 | Monoculture Review (`monoculture`) | 272 | 253 | 93.01% | 1.26% |
| 6 | Parts Embargo (`parts_embargo`) | 10 | 9 | 90.00% | 0.04% |
| 7 | Ratio Control (`ratio_control`) | 1 | 0 | 0.00% | 0.00% |
| 8 | Final Inspection (`final_inspection`) | 1 | 1 | 100.00% | 0.01% |

`greedy`

| shift | Audit | reached | died on it | kill rate | share of all losses |
|---:|---|---:|---:|---:|---:|
| 1 | Spot Check (`spot_check`) | 19989 | 893 | 4.47% | 4.46% |
| 2 | Tolerance Check (`tolerance_check`) | 19080 | 675 | 3.54% | 3.38% |
| 3 | Weight Limit (`weight_limit`) | 17499 | 10410 | 59.49% | 52.05% |
| 4 | Line Freeze (`line_freeze`) | 2468 | 1706 | 69.12% | 8.53% |
| 5 | Monoculture Review (`monoculture`) | 18 | 11 | 61.11% | 0.06% |
| 6 | Parts Embargo (`parts_embargo`) | 0 | 0 | n/a | 0.00% |
| 7 | Ratio Control (`ratio_control`) | 0 | 0 | n/a | 0.00% |
| 8 | Final Inspection (`final_inspection`) | 0 | 0 | n/a | 0.00% |

`planner`

| shift | Audit | reached | died on it | kill rate | share of all losses |
|---:|---|---:|---:|---:|---:|
| 1 | Spot Check (`spot_check`) | 20000 | 3 | 0.01% | 0.04% |
| 2 | Tolerance Check (`tolerance_check`) | 19997 | 28 | 0.14% | 0.34% |
| 3 | Weight Limit (`weight_limit`) | 19965 | 8 | 0.04% | 0.10% |
| 4 | Line Freeze (`line_freeze`) | 19945 | 24 | 0.12% | 0.29% |
| 5 | Monoculture Review (`monoculture`) | 19898 | 2234 | 11.23% | 26.99% |
| 6 | Parts Embargo (`parts_embargo`) | 17581 | 1529 | 8.70% | 18.47% |
| 7 | Ratio Control (`ratio_control`) | 15938 | 442 | 2.77% | 5.34% |
| 8 | Final Inspection (`final_inspection`) | 15306 | 3584 | 23.42% | 43.30% |

`oracle`

| shift | Audit | reached | died on it | kill rate | share of all losses |
|---:|---|---:|---:|---:|---:|
| 1 | Spot Check (`spot_check`) | 20000 | 2 | 0.01% | 0.03% |
| 2 | Tolerance Check (`tolerance_check`) | 19998 | 17 | 0.09% | 0.24% |
| 3 | Weight Limit (`weight_limit`) | 19981 | 2 | 0.01% | 0.03% |
| 4 | Line Freeze (`line_freeze`) | 19979 | 10 | 0.05% | 0.14% |
| 5 | Monoculture Review (`monoculture`) | 19954 | 1749 | 8.77% | 25.20% |
| 6 | Parts Embargo (`parts_embargo`) | 18167 | 1072 | 5.90% | 15.44% |
| 7 | Ratio Control (`ratio_control`) | 17027 | 285 | 1.67% | 4.11% |
| 8 | Final Inspection (`final_inspection`) | 16593 | 3534 | 21.30% | 50.91% |

#### Bot integrity

Strict dominance (oracle ≥ planner ≥ greedy ≥ random) on 20000 shared seeds: **HOLDS**

- `oracle - planner` = 6.69 pp
- `planner - greedy` = 58.61 pp
- `greedy - random` = 0.00 pp

Planner search coverage, per shipment decision:

- ordered selections scored: median **250**, min 31, max 520
- the full ordered-selection space from a hand of 8 at 1–5 parts is **8,800**; all 218 SUBSETS are enumerated exactly, and ordering search is bounded (best-insertion + swap descent) on the best few
- `previewShipment` calls per run: median **141,454**
- runs where a search hit its preview budget: 5828

Throughput:

| tier | ms/run/core | runs/s/core | wall for this sweep |
|---|---:|---:|---:|
| `random` | 0.4 | 2439.36 | 2.3s |
| `greedy` | 15.3 | 65.38 | 77.3s |
| `planner` | 272.2 | 3.67 | 1385.1s |
| `oracle` | 1030.8 | 0.97 | 5209.2s |

Content self-measurement fed to G2.3: non-commutative machine pairs = 62.73% over 20,000 trials (57.45% including 1-part batches).


---

