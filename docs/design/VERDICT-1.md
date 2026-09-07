# VERDICT 1 — the Chart Critic

Written 2026-09-07 against branch `claude/app-store-game-rank-one-9mdidq`, HEAD
`ec35426`. I did not write any of this game and I did not change any game code.
Everything below that is a number is either reproduced from the repo's own
instruments or measured by probes I wrote in a scratchpad outside the tree; every
probe states its sample size, and every one of them is re-runnable.

**Verdict: WOULD NOT CHART.**

The mechanic is real. That is not the problem. The problem is that the mechanic
is *absent from the only window in which a stranger decides*, and the score
ceiling is six digits, so there is no clip. Details in §4.

---

## 0. What already went wrong — verified, plus what is newly wrong

The brief told me not to take any agent's report at face value. I extended that
to the brief itself, and that turned out to be necessary.

### 0.1 The four documented failures — status

| # | Claim | Status |
|---|---|---|
| 1 | UI reported "complete and working"; every asset 404'd in a real browser | **Fixed.** I loaded the page in Chromium at 390×844 with console, `pageerror`, `requestfailed` and `response>=400` all trapped. Zero errors, zero failed requests, zero 4xx. |
| 2 | UI reported it had "looked at real screenshots"; two text collisions were visible in the first one the coordinator took | **Fixed, and the method was fixed.** I captured 24 frames through a shipment and inspected the title, play, reorder, reel and result screens. No text collisions at 390×844. One *new* visual defect found — see 0.3. |
| 3 | Content shipped rules R1/R3 written to protect a benchmark metric | **Fixed.** `machines.ts` header now states the rules were removed and that "the benchmark serves the game". Six gamble machines exist and say so in their rule text. R4 (only `press` and `tally` are permutation-invariant) survives, and I judge that one a design principle rather than a metric-defence. |
| 4 | Rng-fishing: a searching bot could enumerate orderings until a gamble machine's coin landed well | **Closed, and provably.** `src/bots/ev.ts` ranks candidates by the mean over K=8 rng streams that `playShipment` will never use. `tests/bots.test.ts` carries both the positive test and the negative control that fails when the fix is removed. Priced at ±1–2 pp in RESULTS.md. **G1.3 and G1.5 are not measuring PRNG-fishing.** |

All 124 committed tests pass (`npm test`, 37.6 s, 2 skipped — the two `TAKT_BENCH`
long-runners). The UI report's claim that `tests/bots.test.ts` hangs `npm test` is
now stale.

### 0.2 New false statements — in the critic brief itself

The brief that commissioned this review contains four claims I could not confirm
and one I disproved. I record them because the project's stated failure mode is
"confident reports that were false", and the coordinator's own summary of the
measured state is one of them.

1. **"`docs/bench/RESULTS.md` holds four iterations."** It holds three
   (lines 5, 138, 320). There is no iteration 4. **The gate has not been re-run
   since amendment A2 landed**, so no measurement of the current, amended gate
   exists in the repository at all. I ran one; see §1.4.

2. **"Iteration 3 (20,000 runs per tier, commit 66a3c50) is the authoritative
   one… G2.1 = 55.61%, G3.3 = 0.941, G6.1 = 81.76%, G5.1 = 11.44×,
   G5.2 = 16.80×, G4.2 = 46.50%."** Every one of those six figures is
   **iteration 2's**, not iteration 3's. Iteration 2 is the n=1500 run that the
   report itself stamps `⚠ UNDERSAMPLED` and `GATE FORCED TO FAIL: a gate passed
   on thin data is not passed`. Iteration 3's actual values are 55.92%, 0.943,
   81.81%, 12.10×, 19.88×, 45.59%. Nothing material turns on the differences, which
   is exactly why nobody caught it. The instrument was honest; the summary of it
   was not.

3. **"G1.2 = 0.00% … That is the median player."** It is not, and this is the
   most consequential error in the brief. See §1.2 — I measured it.

4. **"[A1 and A2 were] both times making a threshold easier to reach."** A1 did
   not. Under the pre-amendment threshold the shipped build **passed** G2.2 at
   65.96%; under A1's amended threshold it **fails** at 64.04%. A1 made the gate
   harder and the build worse. See §3b.

### 0.3 One new defect, found by looking

Not previously reported anywhere. The reorder panel (`#order-panel`) is
translucent: at 390×844 the underlying "THE LADDER" caption, the "BEST EVER ·
NOTHING YET" line and the hand-card outlines are legible *through* the panel,
directly behind its rows and its DONE button. It is not a collision — the prior
UI sweep was looking for collisions — it is a background that does not mask.
Screenshot: `scratchpad/critic/06-order.png`.

---

## 1. Gate audit — did the instrument lie?

Short answer: the instrument is unusually honest and unusually well documented,
and it is pointed at four things that are not what their labels say. Two of them
matter.

### 1.1 G2.3 does not measure what it claims (minor, but it inflates the headline)

`measureNonCommutativity` (`src/content/index.ts:73`) declares two machines
non-commutative when `A∘B` and `B∘A` produce a **different output batch**, where
the comparison string is joined in batch order. But `scoreBatch` is
`sum(value × mult)` — a **permutation-invariant sum**. A pair whose only
difference is the order of the parts coming out therefore counts as
non-commutative and scores identically.

I reproduced the shipped number exactly and then re-measured it at the level that
matters (20,000 trials, same seed, same generator):

| reading | rate |
|---|---:|
| G2.3 as shipped — output batch differs | **62.73%** |
| output multiset differs (order ignored) | 57.81% |
| **final score differs at all** | **53.18%** |
| final score differs by ≥ 1% | 47.13% |
| final score differs by ≥ 10% | 28.00% |
| **median score gap between the two orders of a random pair** | **0.48%** |
| p90 score gap | 40.18% |

G2.3 passes at 62.73% against a ≥60% threshold. On the honest reading — the score
changes — it is 53.18% and **fails**. The design claim survives (28% of pairs
swing the score by ≥10%, and the p90 gap is 40%), but the metric as written is
0.4 pp of slack away from being decided by the pure-permutation pairs, and it is
scored against a threshold set for the score reading. Recompute it on score.

The deeper reading of that table is the one to carry into §2: **the median
pairwise swap changes the score by half a percent.** Ordering pays off in
aggregate and in a minority of pairings, not in the individual move a player
makes.

### 1.2 G1.2 measures the greedy bot's shopping, not the median player

This is the important one. The gate's greedy tier "buys the cheapest machine it
can afford" (`src/bots/greedy.ts:117`), never buys a line slot, never buys an
upgrade, never rerolls, and never reorders. It wins 0.00% of 20,000 runs, and the
brief reads that as "that is the median player."

I built four variants that differ from the shipped greedy **only** in what they
buy, and one family that differs only in whether it reorders. No ordering search
inside the shipment in any of them — every variant picks the best subset of the
hand in one fixed heaviest-first order, which is what a person actually does.

Shop policy alone (400 seeds each, identical seed set):

| shop policy | win rate | median end shift |
|---|---:|---:|
| cheapest machine (**the shipped greedy tier**) | 0.00% | 3 |
| dearest affordable machine | 0.00% | 3 |
| + buy a line slot when the line is full | 0.00% | 4 |
| + buy upgrades | **2.75%** | 5 |

Reordering, with the sane shop policy held fixed (300 seeds each):

| line handling | win rate | median end shift |
|---|---:|---:|
| never reorder | 4.00% | 5 |
| **one pass of pairwise swaps, once per shift** | **11.67%** | 5 |
| one pass of pairwise swaps, every round | 20.33% | 6 |
| swap-descent to convergence, every round | 22.00% | 6 |

Read those two tables together and G1.2 dissolves. **A player who does the game's
own signature action once per shift, with no search of any kind, wins 11.67% —
inside the gate's 8–25% band.** G1.2 = 0.00% is not a fact about the game; it is
the compound of two handicaps the greedy bot carries that no human carries. The
rebalance report already suspected this ("it buys the cheapest machine it can
afford"); nobody measured it, and the conclusion propagated into the brief as a
fact about players.

There is a real finding underneath, and it is *better* than the false one: the
game's central verb is worth **+7.7 pp of win rate for one pass of swaps per
shift** and **+16.3 pp for one pass per round**. That is the product claim,
measured, and it holds.

### 1.3 The skill ladder has no rung that resembles a person

`random` → `greedy` → `planner` → `oracle`. The planner scores a median of 250
ordered selections per shipment decision and issues a median of **141,454
`previewShipment` calls per run**, plus a full line hill-climb every round and a
mid-round re-nudge before every shipment. No human is within three orders of
magnitude of that. `greedy` is the strawman above. So the ladder is
{noise, strawman, superhuman, superhuman+lookahead}, and **the entire human range
is unmeasured**.

That matters because it is load-bearing for the gate's headline claim. G1.3's band
of 40–60% was written for "a good player". It is being satisfied by a search
engine. My middle rungs suggest the real band for an engaged human sits somewhere
around 12–22% — below G1.2's floor for a *median* player and far below G1.3's
floor for a good one. On that reading the game is substantially harder for humans
than the gate reports, and G1.3's PASS is the weakest PASS on the board.

### 1.4 Was any threshold amended, and did the bots get tuned?

**Bots: no.** I read every commit touching `src/bots/`. There are exactly two:
the creation commit (`b9cc3c9`) and one revision (`66a3c50`) that added
`refineLine`, `subsetMarginPct` and an oracle rework. The suspicious reading —
that the "skilled player" bot was handed a new ability right after G1.3 failed at
15.93% — does not survive the dates: planner had already reached 60.00% at
`2228b50`, **before** `refineLine` existed, and it measured *lower* (58.61%) after
it. The 15.93% → 58.61% jump traces entirely to the quota rebalance
(`QUOTA_BASE` 300→210, `ROUND_MULT` [1,1.5,2.4]→[1,1.35,1.55]), which is a content
change with a self-critical commit message that names the two things it does not
fix. **No evidence of threshold-chasing in the bots.** This is the cleanest part
of the project.

**Thresholds: two amendments, judged in §3b.**

**The reporting defect that neither amendment note fully owns:** amendment A1 was
written into `BENCHMARK.md` and **never wired into `gate.ts`**. All three
iterations' headline `GATE:` lines therefore score the *superseded* G2.2 (≥50%)
and report `G2.2 65.96% PASS` — against a threshold the governing document
replaced. The amended value (64.04% vs ≤30%, FAIL) appears only in a supplement
table produced by a different file. **The scoreboard has been reporting a PASS on
a metric that fails, for three iterations.** A2's commit message concedes this in
passing; the RESULTS.md rows do not.

### 1.5 Sample adequacy

Adequate and honestly handled. 20,000 runs per tier on a shared seed set, Wilson
intervals on every rate, an `UNDERSAMPLED` stamp that force-fails a thin gate, and
a `MARGINAL` stamp when an interval straddles a threshold (iteration 3 correctly
flags G1.4 = 65.30%, CI [64.63, 65.95], against a 65% floor). I have no criticism
of the statistics. The instrument's failure mode is *what it points at*, not *how
carefully it points*.

### 1.6 Two metrics are double-counted

G4.1 is defined as "planner win rate (same as G1.3)" — the same number scored
twice, inflating the PASS column. G1.5 (planner ÷ greedy ≥ 2.5×) is reported as
"not measured → FAIL" because greedy is zero, inflating the FAIL column.

**On G1.5 I take the opposite reading to the gate.** The metric's stated intent is
"ordering and per-hand optimization matter". Greedy at zero makes the ratio
unbounded, which satisfies that intent as completely as it is possible to satisfy
it. Counting it as a *separate* failure records one defect twice: G1.5 fails only
and exactly because G1.2 fails. The honest headline is **8 distinct defects, not
9**, and G1.5 should read `VACUOUS — subsumed by G1.2`.

### 1.7 G6.1 = 81.8%: the metric is confounded, but the finding is real anyway

`marginStats` reports the "different subset" reading as identical to the strict
reading to five significant figures (81.81% / 81.81%) in every iteration. That is
not a coincidence and not a bug in the analysis: in `search.ts` each candidate in
`cands` corresponds to exactly one subset mask, so `finalists[1]` **is** a
different subset by construction. The two "readings" are the same computation.
Both should not be reported as if they cross-check each other.

What the number actually says, with ~51% of those being exact ties: the
**immediate** score landscape over shipments is flat, largely because a shipment
can be padded with a part the line scores at zero. That is a genuine confound —
spending a part has a cost across the round that the metric cannot see. But
81.8% against a 20–45% band is far too large to be explained away by padding, and
it is corroborated by my pairwise measurement (§1.1: median swap worth 0.48%).
**G6.1's failure is real. The turn-to-turn decision does not matter much.**

Which produces the project's sharpest internal contradiction, and it deserves to
be said plainly: **G2.1 says optimal reordering is worth 55.9% of your score, and
G6.1 says the choice you make on any given turn barely matters.** Both are true.
The depth in TAKT lives in a *structural* decision made a handful of times per run
(what the line is, and in what order), and almost none of it lives in the ~96
shipment decisions the player actually spends the run making. A player therefore
makes about 250 decisions per run of which perhaps a dozen are load-bearing.
That is the shape of a puzzle game with a lot of filler, not the shape of Balatro.

---

## 2. The mechanic, judged cold

### 2.1 Is ordering felt, or is it a spreadsheet fact?

Both, and the split is exactly where it hurts.

I enumerated the score of **every** permutation of the line (all n! for n ≤ 6, 720
sampled above that) at every round start of 40 planner runs — 860 round-starts,
priced against a fixed probe set so permutations are compared on identical work.

| | median |
|---|---:|
| gain, best ordering vs. **arrival** order | **61.9%** |
| gain, best ordering vs. **median** ordering | **87.6%** |
| gain, best ordering vs. **worst** ordering | **222.5%** |
| share of all orderings within 5% of the best | **5.8%** |
| share of all orderings within 1% of the best | **2.8%** |

That is a genuinely rugged landscape. G2.1's 55.9% is if anything conservative.
The product claim — "the same machines in a different order are a different game"
— is **true**, and it is the strongest thing in this repository.

Now the same table by line length:

| line | n | median gain vs arrival | orderings within 5% of best |
|---:|---:|---:|---:|
| 3 | 49 | **0.0%** | 33% |
| 4 | 128 | 16.2% | 17% |
| 5 | 220 | 48.0% | 8% |
| 6 | 240 | 91.9% | 4% |
| 7 | 113 | 160.4% | 2% |
| 8 | 110 | 203.4% | 1% |

And when the player gets those lines (40 planner runs):

| line reaches | median shift |
|---|---:|
| 4 machines | 1 |
| 5 machines | 2 |
| **6 machines** | **4** |
| 7 machines | 5 |

**The mechanic that is the entire product does essentially nothing until the
player owns six machines, and the median player owns six machines at shift 4 —
about twelve minutes into a twenty-four-minute run.**

And on turn one it is worse than nothing. Every run in this game opens with the
identical line, `press → foundry → doubler` (`STARTER_LINE`,
`src/content/index.ts:24`). Over 200 seeds, enumerating all six permutations
against the best available shipment:

- **In 86% of runs the order you are handed is already the optimal order.**
- Median gain from reordering on turn one: **0.0%**. p90: 5.0%.

The game opens by putting a button labelled **ORDER** in front of a new player,
next to a panel headed **"REORDER THE LINE — drag"**, and in 86% of runs dragging
anything makes the number go down or stay the same. The pitch and the first
ninety seconds of play are in direct contradiction.

### 2.2 Would a player understand why their score changed?

**Yes — this is done better than Balatro does it, and it is the build's best
work.** I watched the reel frame by frame. During the reveal the screen carries a
"WHY THE NUMBER MOVED" panel with one row per station, each showing the station's
own contribution (`RAW PARTS +56 / 1 PRESS +25 / 2 FOUNDRY +59 / 3 DOUBLER …`) as
both a figure and a proportional bar, filling in as each station fires; the firing
machine is highlighted, its rule text is printed under it, and the parts are
visibly *objects* travelling the belt and changing identity as they pass. The
reorder panel prices each machine's contribution live as you drag.

The transform chain is not opaque. The veteran's change #1 was executed, and
executed well.

### 2.3 Is there a 30-second hook?

There is one, and it is not the one on the box.

**The hook that works:** a Bolt goes in the left, the Foundry promotes it, and a
Gear comes out the right and lands in the crate with its name under it. That is
the alchemy emotion the veteran asked for, it is legible in one shipment, it needs
no vocabulary, and it screenshots. It is genuinely there.

**The hook that does not work:** ordering. Per §2.1, on turn one it is a no-op in
86% of runs and it stays a no-op until roughly the twelve-minute mark.

So the game's first thirty seconds sell "junk becomes treasure" — which is a
perfectly good pitch that **Balatro does not compete with and any pixel-art
crafting game does** — and do not sell the one thing that makes TAKT not a
Balatro-alike.

### 2.4 Is there a screenshot-worthy moment?

**No, and this one is structural rather than a tuning miss.**

Measured over 40 planner runs, the biggest single shipment a player ever sees:

| | value |
|---|---:|
| final-shift quota | 11,305 |
| p50 of each run's largest shipment | **5,623** |
| p95 | 140,454 |
| largest observed, 40 runs | 286,740 |
| winning final score, p50 | 20,305 |

**The biggest number a median winning player sees in a whole run is four digits.**
Balatro's viral genre is screenshots of scientific notation — `1.798e308`,
"naneinf", the score display physically breaking. TAKT's ceiling is six digits at
p95, and that is why G5.1 (12.1× vs ≥20×) and G5.2 (19.9× vs ≥50×) fail.

They fail for an architectural reason and no amount of number tuning fixes it. A
shipment makes **one pass** through **at most 8 machines** over **at most 12
parts**, with `MAX_VALUE = 1e9` and `MAX_MULT = 1e4` as hard clamps and no
retrigger, no loop, and no mult that persists across shipments. Eight machines
each roughly doubling gets you ~256×, and the measurements land exactly where that
arithmetic predicts. Balatro's numbers explode because its scoring is a nested
loop — every scoring card × every joker, with retriggers multiplying the loop
count — so the exponent grows with *content acquired*, not with slot count. TAKT's
does not.

`COMPETITIVE-BASELINE.md` is right that G5 is "a marketing requirement wearing a
math costume". The costume is currently empty.

### 2.5 The reveal is spoiled before it starts

This is the defect I would fix first and it is not in any report.

`web/src/app.ts:166`:

```js
ship.innerHTML = pv.ok
  ? `SHIP<b>+${fmt(pv.score)}${pv.cleared ? ' · CLEARS' : ''}</b>`
  : 'SHIP<b>pick parts</b>';
```

The SHIP button reads **`SHIP +137 · CLEARS`** *before you press it*. Then
`onShip` calls `playShipment`, calls `renderHud()` immediately — so the HUD reads
`225/210` with a full green quota bar and the credits already paid — and *only
then* starts a 1.6-second animation to reveal a number the player read two seconds
ago. I have the frames: at `STATION 1 OF 5`, the HUD already shows the final
score, the cleared bar, and the round reward.

TAKT has no reveal. It has a re-enactment.

The veteran's diagnosis of Balatro was exact — "anticipation, then payoff… the
grammar of a slot machine payline" — and this build has payoff, then a slow
re-statement of the payoff. It also flattens the six gamble machines: the UI
report concedes this as defect #9 and scopes it to the gambles, but the button
spoils *every* shipment, not just the stochastic ones. There are ~96 shipments in
a run. That is 96 reveals with the answer printed on the button.

The fix is small and is a design decision, not an engineering one: the reorder
panel needs exact numbers (it is a planning surface and it is excellent), the
commit button does not. Show the raw pre-line total, or a range, or nothing, and
defer `renderHud()` to `stage.onDone`.

### 2.6 No audio, at all

`grep` for `Audio|AudioContext|\.mp3|\.wav|vibrate` across `web/` returns nothing.
Spec §6 lists audio as out of scope; the veteran review says the feeling of numbers
going up is "40% audio and animation timing". The timing half was done well. The
other 40% is not merely missing from the build — it is missing from the plan.

### 2.7 Run-to-run variance is low for a roguelike

Every run opens with the same three machines in the same order
(`STARTER_LINE`), and every run faces the same eight bosses in the same order —
`reg.audits[s.shift - 1]`, a fixed index, eight audits, one per shift, no
randomisation. Balatro draws its boss blind from a pool per ante. A TAKT player's
second run has the identical opening line and the identical boss sequence as their
first. Variance is confined to the crate draw, the shop, and six gamble machines
out of 110. For a genre whose whole retention model is "one more run, it'll be
different", that is thin.

---

## 3. Against Balatro specifically

### Better than Balatro

1. **Score attribution.** The "WHY THE NUMBER MOVED" panel and the live per-machine
   deltas in the reorder screen teach the engine as you play. Balatro shows you
   numbers flying; TAKT shows you a bar chart of *whose* numbers. For a game about
   composition this is not a nicety, it is the difference between depth being
   visible and invisible, and TAKT gets it right.
2. **A richer structural decision.** 110 machines over up to 8 ordered slots, with
   a landscape where only 5.8% of orderings are within 5% of optimal, is a genuinely
   larger and more rugged combinatorial object than joker ordering in Balatro, where
   order matters for a minority of joker pairs and most players never touch it.
3. **A different fantasy that is not a card game.** The 7-rung ladder
   (Offcut → Bolt → Gear → Pump → Engine → Reactor → Monument) and the
   transmutation machines produce a real "I made a thing" beat. It is not a reskin.
   That clears bar 3 of `COMPETITIVE-BASELINE.md`.

### Worse than Balatro

1. **No reveal (§2.5).** Balatro's core loop is anticipation → payoff. TAKT's is
   payoff → replay. This is the single largest feel gap and it is the cheapest to fix.
2. **No audio (§2.6).**
3. **No viral number (§2.4).** Four digits at the median, six at p95, against
   Balatro's scientific notation. There is no clip.
4. **Losses are the player's fault.** The veteran warned about this precisely; the
   content answered with 6 gamble machines out of 110 (5.5%), and then the SHIP
   button reveals the coin flip before you commit. The excuse the veteran wanted
   available to a defeated player ("it never offered me the duplicator") exists in
   the shop but not in the line.
5. **No meta-progression.** Balatro ships 5 decks × 8 stakes × a large unlock
   ladder — hundreds of hours of *structured* reasons to replay. TAKT persists a
   "best object" rung and nothing else. A 24-minute run with a fixed opening and a
   fixed boss order is a weekend, not a season.
6. **No run save.** `RunState` carries a live RNG whose cursor is not observable,
   so a run cannot be serialised (UI report #3). On mobile, a phone call ends your
   run. Balatro saves mid-blind.
7. **Comprehension.** "Poker hand" is pre-installed in every adult's head. "The
   order of your machines" is a systems-programmer's sentence, and TAKT further
   requires learning invented vocabulary — Offcut, Gasket, Monument, Audit, Takt —
   before anything reads.

### Does a Balatro owner buy this too?

A Balatro *superfan* does — the ordering mechanic is genuinely a different kind of
thinking (spatial and combinatorial rather than probabilistic), which is the exact
bar `COMPETITIVE-BASELINE.md` sets. The five-million-copy audience does not,
because on a store page — five stills and a video most people skip, with no audio
and no absurd number to put in the thumbnail — TAKT reads as "Balatro-shaped, less
feel, less content". The delta is real; it is not *visible* in the channel where
the purchase decision happens.

---

## 3b. The amendments and the goal change

I verified all three claims independently rather than reading the write-ups.

### A1 — G2.2 reversed, G2.4 added: **honest correction, and the record understates the team's own rigour**

The brief and A1's own "honest note" both describe A1 as relaxing a threshold.
**In effect it did the opposite.**

| | threshold | measured (iteration 3, n=20,000) | verdict |
|---|---|---:|---|
| G2.2 before A1 | ≥ 50% | 65.96% | **PASS** |
| G2.2 after A1 | ≤ 30% (within-shift) | 64.04% | **FAIL** |
| G2.4 (new) | ≥ 60% (across boundary) | 70.41% | PASS |

A1 converted a metric the build was passing comfortably into one it fails by a
factor of two, and added a second metric alongside it. Whatever else it is, it is
not goalpost-moving — nobody moves a goalpost onto their own foot. It was
proposed by an outside reviewer who had seen no measurement, for a stated design
reason (a metric demanding the line be re-solved every round is a formal guarantee
the line never becomes the player's), and I think the design reason is correct.

**Ruling: honest.** Two caveats, one of them serious:

- **Serious:** A1 never reached `gate.ts`. Three iterations of headline `GATE:`
  lines have scored and reported the superseded threshold as a PASS. The
  authoritative gate state for the shipped build is **not** the 9 failures printed
  in RESULTS.md; G2.2-amended belongs on that list.
- **And the amendment's design goal is not met by the content.** A1 asked for a
  line that is stable within a shift. The build re-solves within a shift 64% of the
  time, and my own measurement prices the chore: reordering every round rather than
  once a shift is worth **+8.7 pp of win rate** (11.67% → 20.33%). The incentive to
  do homework three times a shift is large and the player will feel it. A1 was the
  right amendment; the content has not yet honoured it.

### A2 — G3.1/G3.4 exclude the starter line: **correct bug fix, one real PASS bought, and it leaves G3.4 nearly vacuous**

The technical claim checks out in about five minutes, as promised.
`presenceShare` (`src/sim/metrics.ts:140`) counts *presence* — does this def or
archetype appear anywhere in a winning run — and `STARTER_LINE` is the constant
`['press', 'foundry', 'doubler']`. `press` and `doubler` are `arithmetic`. So
`arithmetic` sits at 100% and those three defs sit at 100% **for any content
whatsoever**. G3.1's ≤55% threshold was not hard, it was **unreachable by
construction**, and G3.4 could never read below 3. A metric that returns the same
value regardless of what it measures is not measuring it. That is a bug.

I then did what the project has not: I re-ran the gate with A2 live
(`--runs 3000 --bots planner`, 446 s of wall clock, HEAD `ec35426`).

| | before A2 (iter 3, n=20,000) | after A2 (mine, n=3,000) |
|---|---|---|
| G3.1 most-used archetype share | 100.00% FAIL | **70.73% FAIL** |
| G3.4 defs in > 60% of wins | 3 FAIL | **0 PASS** |
| G3.2 archetypes ≥15% of wins | 7 PASS | 7 PASS |
| G3.3 archetype entropy | 0.943 PASS | 0.972 PASS |

**Ruling: correction, not goalpost-moving — with a caveat the note does not
raise.** The evidence that decides it for me is not the reasoning, which is
well-written and which the brief correctly says proves nothing. It is that A2
**left G3.1 failing at 70.73%.** A goalpost-mover with the pen in his hand and a
metric he had just declared broken would have set the threshold at 75% and taken
two passes. He took one and published the other as a failure.

The caveat: post-A2, G3.4 asks whether any *acquired* def appears in >60% of
winning runs, when a winning run acquires roughly four machines from a pool of
107. A uniformly random shopper puts a given def in ~4% of wins. **G3.4 will now
read 0 for almost any content that is not catastrophically broken** — the fix
traded a metric pinned at FAIL for one pinned at PASS. The diversity signal with
teeth is G3.1, and it fails.

### The pattern, judged

Two amendments, both by the author who set the thresholds, both self-flagged. The
pattern is worth distrusting on its face and I did distrust it. Having checked
both: **net across A1 and A2, the gate got one PASS harder and one PASS easier,
and the build still fails nine metrics.** There is no drift here. What there *is*
is a process failure of a different kind — an amendment that lived in the
governing document but not in the code that scores it, for three iterations, while
the scoreboard printed a PASS. Fixing the amendment mechanism matters more than
re-litigating either amendment.

### The goal change — reading (a), with a sharp qualification

The brief offers two readings and demands one. **I take (a): the project
discovered its goal was incoherent and fixed it.** The incoherence is real and
checkable — spec §6 declared marketing, launch timing, featuring and streamer
seeding out of scope, in the same document that named a goal which
`COMPETITIVE-BASELINE.md` correctly demonstrates is decided by exactly those four
things. "#1 paid on the App Store" was never a goal this plan could pursue; it was
a wish sitting on top of a plan that had excluded every mechanism for reaching it.
Removing it is bookkeeping, not retreat, and the changed goal — "a game that
converts if one lucky break arrives" — is strictly more falsifiable than what it
replaced.

Two things stop me from giving it a clean bill.

**First, the team took the cheaper of the two options it was offered.** The
veteran's change #4 was explicitly a *fork*: pick a free-look surface (a PC build
with a Steam demo, or a free mobile tier), **or** delete the goal. The team
deleted the goal, and §6 still lists distribution as out of scope. So the
project's answer to "the biggest risk in this repo is a single line in §6" was to
edit a different line. The reasoning is sound and the choice is convenient, and
the fact that the reasoning is well-written is — as the brief says — not evidence
either way. What settles it for me is that the *rest* of the veteran's list was
acted on properly: transmutation shipped, variance shipped, A1 shipped. This is a
team that executes recommendations. It executed three of four and rewrote the
fourth. That reads as a real constraint (nobody in this repo can ship a Steam
demo) honestly declared, rather than as evasion — but it should be written down as
an open problem in §6, not resolved by deleting the sentence that pointed at it.

**Second, the replacement goal is not yet measurable either.** Spec §7 now names a
"Gate 2 — the human gate" (time to first "oh", clip legibility, retry within two
seconds, can a player explain it) and then concedes that this project cannot run
it. The decisive gate is unrun, and this verdict — including everything in §2 —
is one more machine's opinion in place of ten humans'.

---

## 4. The verdict

# WOULD NOT CHART

Not because the mechanic is shallow. It is not: line ordering is worth 61.9% of
score against arrival order and 87.6% against a median ordering, only 5.8% of
orderings are within 5% of optimal, 28% of machine pairs swing the score by ≥10%
when swapped, and the build is a clean, legible, bug-free, 124-test, 110-machine
game that a person can sit down and play right now. This is a competent piece of
work and considerably better than "a competent but unremarkable Balatro-alike" —
the ordering engine is a real and different idea, and the attribution UI is better
than the game it is chasing.

**The single biggest reason: TAKT's differentiator does not exist during the only
window in which a stranger decides.**

Concretely, and every number here is measured above: on turn one the line you are
handed is already optimal in **86%** of runs and reordering is worth a median of
**0.0%**; the mechanic only becomes decisive at six machines, which the median run
reaches at **shift 4**, roughly **twelve minutes** in; the largest number a median
winning player ever sees is **four digits**, so there is no clip; the SHIP button
prints the score and `· CLEARS` before you press it, so there is no reveal to clip
even if the number were large; and there is no audio. A premium mobile game with
no free-look surface gets one shot — five store stills, a skippable video, and a
stranger's first two minutes. In that window TAKT is a dark, silent, competently
made card-and-shop game with a conveyor belt, and the reason to buy it instead of
the game it resembles has not happened yet.

Every one of those is fixable, and none of them is fixable by tuning a threshold.

For completeness, the two things that would have to be true for this to be
**COULD CHART WITH LUCK** — and they are the same list as "what would make the
mechanic stop being the limiting factor": (i) the differentiator visible inside
sixty seconds and inside a 20-second clip, and (ii) a right tail that produces a
number worth posting. Fix those two and the verdict moves, and the remaining
obstacles are the ones nobody in this repository can do anything about, which is
the honest place for a project like this to end up.

---

## The three highest-leverage changes, ranked

### 1. Take the answer off the SHIP button, and stop the HUD from landing before the reel

*Addresses:* the spec's own Gate 2 in full (time-to-"oh", clip legibility, retry
in two seconds), the qualitative failure in §2.5, and most of the value of the six
gamble machines. Not currently addressed by **any** gate metric, which is itself
the finding.

`web/src/app.ts:166` prints `SHIP +137 · CLEARS` before the player commits, and
`onShip` calls `renderHud()` before `stage.play()`, so the score, the quota bar
and the round reward have all resolved at frame 0 of a 1.6-second reveal. Show the
raw pre-line total, or a range when the line contains a gamble, or nothing; defer
`renderHud()` into `stage.onDone`. Keep exact numbers in the reorder panel, which
is a planning surface and is the best thing in the build.

This is roughly a day of work and it is the difference between having a payoff
moment ~96 times per run and having none. Do it before anything else, because
every other feel judgement in this document is being made through a build with no
reveal in it.

### 2. Put the mechanic on screen in the first ninety seconds

*Addresses:* G1.2 (measured at 11.67% for a once-per-shift reorderer, i.e. inside
the band, so the metric's problem is the bot **and** the onboarding), the 30-second
hook in §2.3, the store-page pitch, and the §2.7 sameness problem.

Today: one fixed starter line (`press → foundry → doubler`) in every run, already
optimal in 86% of them, worth a median 0.0% to reorder, in a game whose one-line
pitch is "the order of your machines is the whole game".

Start the player with **four or five machines** whose handed order is
**deliberately wrong** — at four machines the median gain is already 16.2%, at
five it is 48.0% — and vary the opening line across runs. The first shipment
should be followed by a prompt to drag one machine and ship again, and the number
should jump by a third. That is the twenty-second clip, and it currently does not
exist at any point in the first three rounds.

### 3. Break the score ceiling: give the line a way to compound

*Addresses:* G5.1 (12.1× vs ≥20×) and G5.2 (19.9× vs ≥50×), and the "clip-worthy
failure mode" that `COMPETITIVE-BASELINE.md` names as bar 1.

These two are not failing by a tuning margin, they are failing by architecture. A
shipment is **one pass** through ≤8 machines over ≤12 parts, clamped at
`MAX_VALUE = 1e9` and `MAX_MULT = 1e4`, with nothing carried between shipments.
Eight machines each roughly doubling is ~256×, and the measurements land exactly
there: p50 largest shipment 5,623; p95 140,454. No rebalance of the quota curve
reaches 20× and 50× from that structure.

What the structure is missing is what makes Balatro's numbers explode: a loop
count that grows with content acquired. The cheapest candidates are a **retrigger**
(a machine that sends the batch through some span of the line a second time), a
**mult that persists across the shipments of a round**, or a legendary that
uncaps `MAX_MULT` for one round. Any of these turns a linear chain into something
with an exponent in it, and the exponent is the screenshot.

---

### A fourth, which is not a game change but is the one that would have prevented
### most of this document

Add a bot tier that resembles a person: best-subset shipment with no ordering
search, a shop policy that buys the good item rather than the cheap one, and one
pass of pairwise line swaps per shift. I measured it at **11.67%** (300 seeds) and
it took an afternoon. The gate has spent its whole life measuring a strawman at
one end and a search engine at the other, and reporting the strawman's 0.00% as a
fact about players. Until that rung exists, G1.2, G1.3 and G1.5 are describing
bots, and the project's central claim — that it has measured its own skill gap —
is measuring a gap between two things that are not players.

---

## Method and limits

Reproducible: `scratchpad/ordprobe.ts` (permutation landscape, 40 seeds, 860
round-starts), `scratchpad/firstturn.ts` (turn-one reorder value, 200 seeds),
`scratchpad/humanbot.ts` (shop-policy variants, 400 seeds each),
`scratchpad/casual.ts` (the missing rung, 300 seeds each), `scratchpad/bignum.ts`
(score ceiling, 40 seeds), `scratchpad/ncscore.ts` (score-level
non-commutativity, 20,000 trials), `scratchpad/critic-*.mjs` (Playwright, Chromium
1194, 390×844 @2x). Gate re-run: `--runs 3000 --bots planner --no-write`.

My samples are 40–3,000 runs where the gate uses 20,000. Every win-rate figure I
quote carries a Wilson half-width of roughly ±2–5 pp at those sizes, which is
wide enough to move 11.67% inside the 8–25% band but not wide enough to move
0.00% out of it, and not remotely wide enough to affect any of the structural
findings. The permutation, ceiling and non-commutativity numbers are not rates and
are stable across the sample.

**And the limit that outranks all of them: no human has played this game.** Spec
§7's Gate 2 is the gate that decides whether there is a product, it has never been
run, and this document is one more machine's opinion standing where ten people's
should be. Everything in §2 about *feel* — the reveal, the hook, the clip —
is a reasoned judgement from frames and code, not an observation of a person. The
single cheapest thing this project could do next is not on my list of three,
because it is not a change to the game: put the build in ten hands and watch where
they stop.
