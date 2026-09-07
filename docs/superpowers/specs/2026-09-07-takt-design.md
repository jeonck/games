# TAKT — Design Spec

> A factory-line roguelike. Parts flow left to right through machines you own.
> The machines are non-commutative: the same eight machines in a different order
> are a different game.

**Goal (revised 2026-09-07):** a premium roguelike that a player finishes a run
of and immediately tells someone about — **a game that converts if one lucky
break arrives.**

> The original goal read "#1 on the App Store paid games chart". It has been
> rewritten, and the reason is recorded rather than quietly dropped. A veteran
> designer's review (`docs/design/VETERAN-REVIEW.md`) established that no
> mobile-first premium game has reached #1 on mechanical merit — every case
> that got there had a *free seat*: Apple editorial, a borrowed megaphone, a
> free tier, or a premise that was itself the marketing. This spec declared
> marketing and distribution out of scope (§6) while naming a goal that only
> distribution can deliver, and that contradiction was silently distorting
> every decision beneath it — including the decision to build a 20,000-run bot
> benchmark before a single human had touched the game. "Converts on one lucky
> break" is the same ambition stated honestly, and it is the only version
> anyone has actually achieved.

---

## 0. The bet, stated honestly

The only reproducible precedent for "#1 paid game on the App Store" built by a
very small team is **Balatro** (LocalThunk, solo, $9.99, ~$1M in its first 7
days on mobile, displaced Minecraft at #1). Its formula:

1. A **universally pre-known object** (poker hands) → zero tutorial cost.
2. A **multiplicative** score so builds go exponential → the "broken run" high.
3. **Two nested decision layers** (play a hand / buy jokers) → skill expression.
4. Cheap art. The depth is in the math, not the pixels.

Two properties this spec originally missed, added after review:

5. **The primitive is already emotional.** A flush *feels* like something before
   any joker touches it. Balatro reveals a hand one card at a time, with the
   number stacking audibly — the grammar of a slot machine payline. The emotion
   comes from the skeleton, not the math.
6. **Cheap art is also a commercial vulnerability.** Threes spent 14 months on
   design and lost its audience to 2048, a free weekend clone. An abstract
   systems game with flat shapes and a two-tone palette is the *easiest possible
   thing to clone*, and TAKT becomes worth cloning the moment it is visible.

TAKT keeps properties 1–4 and changes the mechanic so it is not a reskin:

| | Balatro | TAKT |
|---|---|---|
| Pre-known object | poker hands | a factory conveyor: stuff goes in the left, comes out the right, worth money |
| Source of combinatorics | which cards you play | **the order of your machines** |
| Core math | chips × mult | **function composition** (non-commutative operators) |

### The primitive emotion: transmutation, not ordering

Ordering is the *skill*. It is not a feeling — "the order of my machines" is a
correct answer, not an experience, and optimization puzzles have a small and
commercially thin audience.

The feeling TAKT sells is **alchemy**: a rusted bolt goes in the left and a gold
monument comes out the right. That is ancient, universal, needs no tutorial, and
is the screenshot. Therefore:

- Parts are **objects with identities**, not `{value, mult, tags}` with a label.
  They have names and characters: a bolt, a fish, a battery, a cursed doll.
- Machines **transmute** — they rewrite `Part.def`, promoting a part up a tier
  ladder, fusing two into one, corrupting a batch into scrap worth triple.
- A shipment resolves into **an absurd object arriving in a crate**, not into a
  total appearing. The number is the score; the object is the reason to care.

This costs nothing in the frozen contract — `Part.def` is already writable.

**Why ordering is the right engine.** Eight machines have 40,320 orderings. The
correct one depends on the parts you drew this round. That means a tiny content
set generates an enormous, genuinely-non-obvious decision space — and it is
*trivially machine-evaluable*, which is what lets us measure depth instead of
arguing about it.

---

## 1. Core loop

A **run** is 8 **Shifts**. Each Shift has 3 **Rounds** (Order → Order → Audit).
Clear a round by meeting its **Quota**; fail and the run ends.

### Within a round

- You hold a **Hand** of 8 **Parts** drawn from your **Crate** (deck, ~20 parts).
- You have 4 **Shipments** and 3 **Scraps** per round.
- A **Shipment**: pick 1–5 parts from hand → they enter the **Line** as an
  ordered batch → each **Machine** in the Line, left to right, transforms the
  batch → the final batch's total value is added to round score. Parts used are
  discarded; you redraw to 8.
- A **Scrap**: discard any parts from hand and redraw. No score.
- Meet Quota within 4 Shipments → round cleared, earn **Credits**.

### Between rounds — the Shop

- Buy **Machines** (the "jokers"). Line capacity starts at 4, expands to 8.
- **Reorder the Line — always free, always allowed.** This is the skill.
- Buy/upgrade/delete **Parts**.
- Buy **Blueprints** (run-long modifiers).

**Where the variance lives.** Round-to-round variance belongs in the *parts and
the shop*, not in invalidating the line. The line accumulates across a run and is
restructured at shift boundaries — once per shift, as a large satisfying move,
not three times per shift as a chore. See BENCHMARK amendment A1.

**Losing must be survivable.** A fully deterministic line means every loss is the
player's own stupidity, which is the worst available feeling for a $5 mobile
game where a hundred alternatives are one thumb away. Shop offers vary, and a
small number of machines (~6) resolve with visible, clearly-labelled variance
("50%: ×8 the last part, else nothing") so a defeated player can say "it never
gave me the duplicator" and press retry in two seconds. Preview must still equal
play: variance is keyed off `(shipment slot, machine index)` so bots and the
benchmark stay reproducible.

---

## 2. Why this is measurable (the depth gate)

The whole design exists to be falsifiable. A game where a random player scores
about as well as a thinking player is a shallow game, no matter how it looks.

We ship a **headless simulator** and four bots of increasing intelligence:

| Bot | Policy |
|---|---|
| `random` | legal random shipment, random shop buy, never reorders |
| `greedy` | best single shipment this instant, no lookahead, never reorders |
| `planner` | evaluates all line orderings for the current hand; 1-ply shop lookahead |
| `oracle` | planner + beam search over the shop across the whole shift |

The **skill gap** between these tiers is the primary depth metric. Details and
pass/fail thresholds live in `docs/bench/BENCHMARK.md`; that file is the gate.

---

## 3. Data model (the contract)

All agents build against these types. They are frozen; changing one is a spec
change, not an implementation decision.

### Part

```ts
type Tag = 'metal' | 'organic' | 'volatile' | 'precision' | 'scrap';

interface Part {
  id: string;         // unique instance id within a run
  def: string;        // content id, e.g. 'ingot'
  value: number;      // base value, integer >= 0
  tags: Tag[];
  mult: number;       // per-part multiplier, default 1
  sticky?: boolean;   // not discarded after a shipment
}
```

### Batch

A batch is an **ordered array of parts**. Machines rewrite it. Order within the
batch is meaningful — several machines read position ("first", "last", "the
highest").

```ts
type Batch = Part[];
```

### Machine

```ts
interface Machine {
  id: string;
  def: string;              // content id, e.g. 'doubler'
  level: number;            // 1..3, upgrades
  apply(batch: Batch, ctx: RunCtx): Batch;   // pure; must not mutate input
  cost: number;
  rarity: 'common' | 'uncommon' | 'rare' | 'legendary';
}
```

**Hard rule: `apply` is pure and deterministic given `(batch, ctx)`.** Any
randomness draws from `ctx.rng`, which is a seeded PRNG. This is what makes the
simulator reproducible, and reproducibility is what makes the gate real.

### Scoring

```ts
score(batch) = sum over parts of (part.value * part.mult)
```

Rounded down, floored at 0. Applied only to the batch that exits the last
machine.

### RunState

```ts
interface RunState {
  seed: number;
  rng: RNG;
  shift: number;        // 1..8
  round: number;        // 1..3
  quota: number;
  score: number;
  shipmentsLeft: number;
  scrapsLeft: number;
  credits: number;
  line: Machine[];      // ordered; length <= lineCap
  lineCap: number;      // 4..8
  crate: Part[];        // full deck
  drawPile: Part[];
  hand: Part[];
  discard: Part[];
  blueprints: Blueprint[];
}
```

---

## 4. Content requirements

These are floors, not targets. Below them the combinatorics collapse.

- **≥ 60 machine defs**, spread across archetypes: `arithmetic` (+/×),
  `positional` (first/last/reverse/rotate), `filter` (drop/keep by predicate),
  `generative` (duplicate/spawn), `conditional` (if-tag/if-count/if-parity),
  `economic` (credits, draws), `transmutation` (change tags/values).
- **≥ 5 archetypes must each support a winning build.** Measured, not asserted.
- **≥ 20 part defs**, ≥ 4 per tag.
- **8 shift bosses (Audits)** that invalidate a strategy each — e.g. "positional
  machines do nothing", "batches over 3 parts score half". A boss must be
  *answerable by reordering*, not merely survivable.

### Non-commutativity is a design requirement, not a happy accident

Every machine set must fail this test to be accepted: for a random pair of
machines (A, B) and a random batch, `A(B(x)) != B(A(x))` for **at least 60% of
pairs**. A content set of mostly-commutative machines (all `+n`, all `×n`)
produces a game where ordering does not matter, the planner bot ties the greedy
bot, and the depth gate fails. Ordering-sensitivity is the product.

---

## 5. Presentation

Mobile-first portrait, 60fps, no engine, no framework. Canvas for the line
animation, DOM for chrome. The line is a horizontal conveyor; a shipment is a
2-second animation of parts physically moving through machines, each machine
popping its transform as the batch passes. The *readability of the transform* is
the entire game feel: the player must see **why** the number changed.

Art budget is deliberately near-zero: flat shapes, two-tone palette, heavy
typography. The screenshot has to read as "systems game", not "asset flip".

---

## 6. Out of scope

Not in this build, and saying so plainly:

- Actual App Store submission, pricing, review, or featuring. Cannot be done
  from here.
- Marketing, streamer seeding, launch timing — the factors that decide chart
  position *given* a good game.
- Native iOS wrapper (the web build is structured to be Capacitor-wrappable, but
  we do not wrap it).
- Audio.

---

## 7. What "done" means

Two gates, and the second one is not optional.

**Gate 1 — the machine gate.** `docs/bench/BENCHMARK.md` passes on a clean
simulation of ≥ 20,000 runs, **or** the loop demonstrates it cannot be passed and
says so plainly.

**Gate 2 — the human gate.** The benchmark cannot distinguish TAKT from an
NP-hard scheduling puzzle with pretty numbers, which would pass every one of
G1–G7 and which nobody would buy twice. So the following are recorded, and a
pass on Gate 1 with a failure here is a failure:

- Time to the first "oh" for someone who has never seen it.
- Whether a stranger understands a 20-second clip of it.
- Whether a defeated player presses retry within two seconds.
- Whether someone who played one run can explain it to a friend.

This project can produce those honestly only up to the limits of a session with
no human playtesters, and that limitation is stated in the final verdict rather
than papered over. A verdict of "measurably deep, emotionally unproven" is the
most likely honest outcome and gets reported exactly that way.
