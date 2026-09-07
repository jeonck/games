# Veteran review — TAKT

Outside read, 2026-09-07. I have shipped premium games that paid the rent and premium
games that sold four thousand copies to people who loved them. This document is about
which one TAKT currently is.

Short version up front, because you deserve it before the argument: **the engineering
here is better than the game design here, the gate is measuring the wrong half of the
funnel, and the biggest risk in this repo is a single line in §6 of the spec that says
marketing is out of scope.** Details follow.

---

## 1. The seven months

The baseline document is right, and it is right in a slightly more brutal way than it
states.

It frames Balatro's seven months as a *platform* problem — PC first, then mobile. It
isn't. It's a **free-look** problem. What those seven months bought was a place where
hundreds of thousands of people could see the game move, at length, without paying.
The demo, the Next Fest, the streamers, the GOTY lists. The App Store product page —
five static screenshots and a video most people skip — cannot do that job. It was never
designed to. It is a checkout counter, not a shop window.

So the honest version is worse than "no prior fame": **a premium mobile game has no
free-look surface at all.** That is the actual structural problem.

Now, does that kill the goal? No. But it kills *this route* to it. Let me tell you what
I have actually watched work, because there are only four things on the list and none of
them are "the mechanic was deep":

- **A visual that Apple's editorial team wants on a banner.** Monument Valley. That game
  charted on a screenshot. Its puzzles are, being honest among professionals, easy. It
  did not matter.
- **A borrowed megaphone.** Heads Up! charted because it was on a daytime TV show every
  week. Distribution was the product.
- **A free tier that is the funnel.** Geometry Dash, Bloons. The paid SKU sits on top of
  a free population that already knows the game.
- **A premise that is itself the marketing.** Plague Inc. is the cleanest mobile-first
  premium chart success I know, and it charted because "give everyone a disease and kill
  the world" is a sentence people repeat to each other. Nobody repeated its infection
  model.

Look at the list. Not one of those games charted on mechanical depth. Depth is why
people don't refund, why the reviews are good, why it sells for two more years. It has
never once been the reason a game got seen.

And here is the risk nobody in this repo has written down. **Threes.** Fourteen months of
genuinely world-class design, $1.99, and then 2048 — a free clone knocked out in a
weekend — took the audience and the mindshare. TAKT as specified is *maximally clonable*:
abstract systems, flat shapes, two-tone palette, near-zero art budget, and a mechanic
that is completely legible from a video. If TAKT ever becomes visible enough to chart, a
free version of it exists within three weeks. Balatro survived that because it had a
huge content surface, a distinct look, an audio identity, and a brand. Cheap art is a
production strategy and a *commercial vulnerability* at the same time, and the spec
currently treats it as pure upside.

**The play you are not seeing:** you do not need seven months of fame, you need a
free-look surface, and you should pick one and design toward it starting today.
The cheapest one that has actually worked repeatedly for a small team is a PC build with
a Steam demo — that is not a compromise on the mobile goal, it *is* the marketing budget,
and it costs a hundred dollars and a lot of patience. Second cheapest is a free mobile
tier with a paid unlock. If you will do neither, then remove "#1 paid" from the documents
and replace it with "a $5 game good enough that people tell their friends", which is an
excellent goal and implies quite different decisions.

---

## 2. Is TAKT the right game?

This is where I am going to be unkind, and I want to say first that the core is not
stupid. Function composition on a conveyor is a real engine. It generates combinatorics
from almost no content, it is machine-evaluable, and it is not a Balatro reskin. That is
all true and it is why I would not kill this.

But you asked about feeling, so:

**Poker hands are emotional before the game touches them.** That is exactly right, and
it is only half of why Balatro works. The other half is that a Balatro hand is *revealed*
— cards score one at a time, each with a sound, each number landing on top of the last.
That is the grammar of a slot machine payline. Anticipation, then payoff. Balatro is
wearing a card game's clothes over a gambling machine's skeleton, and the skeleton is
where the feeling comes from.

**What is TAKT's primitive?** A conveyor. Is that emotional? Yes — but not the way you
have built it. The factory-game emotion, the thing Factorio and Satisfactory actually
sell, is *pride in a machine that runs without you.* I built this, and now it works while
I do something else. It is an ownership emotion and it accrues slowly.

TAKT does not have that emotion. TAKT has a four-to-eight slot permutation that must be
re-solved every round. And here is the sentence I most want you to sit with:

> **G2.2 is at war with the fantasy.** "The optimal ordering differs from the previous
> round's in ≥ 50% of rounds" is a formal requirement that the player's structure be
> invalidated constantly. It is a superb depth metric. It is also a guarantee that the
> line never becomes *yours* — and "this is mine and it works" was the entire reason to
> borrow the factory metaphor in the first place.

Balatro never asks you to re-permute your jokers. You accumulate them, they compound,
and the compounding is the pleasure. TAKT as specified asks the player to redo their
homework three times per shift.

Second problem, and it is bigger than it looks. **Loss attribution.** When you lose in
Balatro you feel unlucky — the shop didn't offer you the thing, the boss blind was cruel.
That is a socially acceptable excuse and it is why you press "again" instantly. When you
lose an optimization puzzle, you feel *stupid*, because you were wrong and a correct
answer existed. Your machines file states, proudly, that no machine uses `ctx.rng` and
the line is fully deterministic. That is wonderful for the benchmark and it means every
single loss in TAKT is the player's fault. On mobile, at $5, with a hundred other things
one thumb-swipe away, that is a brutal position to be in.

**Does a normal person pick this up?** The first half of your pitch lands — "stuff goes
in the left, comes out the right, worth money", fine, everyone gets it. The second half,
"the order of your machines is the whole game", is a systems programmer's sentence. Order
of operations is a thing most adults actively remember disliking. You are asking a
stranger in a store to get excited about function composition. Some will! There are
maybe two hundred thousand of them worldwide and they already own Opus Magnum.

**So is there a primitive emotion available?** Yes, and you are not using it. It is not
ordering — it is **transformation**. The small-scale joy of a factory is alchemical: I
put in a rusty bolt and out came a gold cathedral. That emotion is ancient, it is
universal, it needs no tutorial, and it screenshots. But it requires the things on the
belt to be *things*. Right now a Part is `{ value: number, mult: number, tags: Tag[] }` —
a number wearing a label. There is no object in this game anyone could love, and no
moment where something visibly becomes something else.

That is fixable, it is a content decision, and content is precisely what has not been
finalised. Which is why I am writing this today and not next week.

---

## 3. The measurement trap

Both things are true: the gate is good work, and it is partly taste-substitution. Let me
separate them cleanly.

**What's genuinely wise about it.** Freezing thresholds before writing gameplay code,
requiring amendments to be logged, and stating in the file that failing is an acceptable
outcome — that is discipline most funded studios do not have. The limitation paragraph in
BENCHMARK.md ("passing means the mechanic is not the reason it would fail — nothing
more") is honest and correct, and it is the best paragraph in this repository.

**Where it is already hurting you.** Goodhart arrived before the content did. Look at the
header of `src/content/machines.ts`. Rule R1: *no machine may be the identity on a batch,
because a no-op commutes with everything.* You have banned a machine that sometimes does
nothing — in order to protect metric G2.3. But "sometimes this joker whiffs" is a
legitimate, beloved design; Balatro is full of conditionals that miss, and the missing is
part of the drama. You wrote a rule that forbids a fun thing to defend a number. That is
what taste-substitution looks like in practice, and it is happening in the first content
file, before the other fifty-seven machines exist.

**The deeper problem with G1.5 specifically.** Planner-÷-greedy measures *how much the
game rewards computation*. Chess has an enormous planner-to-greedy ratio. So does
Advanced Squad Leader. Neither has ever charted. Meanwhile Vampire Survivors has a nearly
nonexistent early-game skill gap and sold in the millions. A high skill gap is a
**retention** property — it keeps the top few percent playing for months. #1 paid is an
**acquisition** event. You have built an exquisite instrument and pointed it at the wrong
half of the funnel.

**Can you pass every gate and ship something nobody wants?** Yes, trivially. Here is the
existence proof: an NP-hard scheduling puzzle with pretty numbers would pass G1 through
G7 with room to spare — huge skill gap, non-obvious decisions, order load-bearing,
diverse strategies, fat tail. It would also be homework, and nobody would buy it twice.
Nothing in this gate can distinguish TAKT from that game.

**What is not measured, and predicts sales far better:**
- Time-to-first-"oh". Seconds, in a stranger's hands.
- Whether a 20-second clip is legible to someone who has never played.
- Whether a loss makes you press "again" within two seconds.
- Whether a player can explain the game to a friend after one run.
- Whether the numbers going up *feel* good — which is 40% audio and animation timing and
  0% math.

Every one of those needs ten humans and a rough build. It costs a weekend. The bot
benchmark cost weeks and cannot tell you a single one of them. Keep the gate — it is
cheap to run now that it exists, and it will catch a dominant strategy that a human
playtest would miss. But it is not the gate that decides whether you have a product, and
right now it is the only gate you have.

---

## 4. What I would do

I would keep TAKT. The engine is fine; the aim is wrong. Four changes, in priority order.
The first three cost content decisions only, and content is still open today.

**1. Give the parts identity and give the shipment a punchline.**
Stop shipping numbers. Ship objects — a bolt, a fish, a battery, a cursed doll — that
visibly become other objects as they cross the line. The end of a shipment should be one
absurd thing arriving in the crate, not a total appearing. This is your primitive
emotion, it is your screenshot, it is your ten-second explanation, and it is the one part
of your product a weekend clone cannot copy. Do this *before* the 60 machines are
written, because it changes what a good machine is.

**2. Stop invalidating the line every round. Invert G2.2.**
Move round-to-round variance into the **parts and the shop**, which is exactly where
Balatro puts it, and let the line be a structure the player builds up and restructures
rarely and decisively — once a shift, as a big satisfying moment, not three times a shift
as a chore. Yes, this is a gate amendment. Log it honestly: *the metric was buying depth
at the price of ownership, and ownership is the reason the theme was chosen.*

**3. Put luck back in, so that losing is the game's fault.**
Fully deterministic transforms are great for the simulator and poison for repeat play.
Variance in what the shop offers, variance in a few machines, anything that lets a losing
player say "I never got offered a Duplicator." Keep determinism for the benchmark by
seed-locking the sim; do not keep it in the player's experience. This is the highest-
leverage retention change available and it is currently designed out on purpose.

**4. Choose a free-look surface this week, or change the goal.**
PC build with a Steam demo, or a free mobile tier with a paid unlock. Pick one and put it
in the spec. If the answer is genuinely neither, then delete "#1 paid on the App Store"
from every document in this repo and replace it with a goal the plan can actually reach.
A stated goal that the plan explicitly declares out of scope (§6) is not a goal, it is a
wish, and it quietly distorts every decision underneath it — including, I would argue,
the decision to build a 20,000-run bot benchmark before anyone had held the game.

**What I would build instead, if you made me kill it:** nothing. A kill is not warranted.
This is a packaging and distribution failure, not a mechanic failure, and packaging is
cheap to fix at this exact moment.

---

## 5. The numbers

**Probability TAKT, as currently scoped, reaches #1 paid on the App Store: ~1%.**
Not because the game will be bad. Because the plan contains no mechanism by which enough
people see it. Mobile-first, premium, no free-look surface, marketing declared out of
scope, and a mechanic whose pitch selects for systems players. With change #4 above
actually executed — a PC demo and seven patient months — I would move this to somewhere
around 5%, which is roughly "one of the best outcomes available to a small team" and
still means you probably don't get there. Nobody gets there. That is what a prestige slot
means.

**Probability it produces a genuinely good game: ~60%**, and ~40% if changes 1–3 are not
made. The team profile here — freezing a falsifiable gate, researching the precedent
honestly enough to find the inconvenient answer, writing "failing is an acceptable
outcome" into the spec — is the profile of people who ship good things. The risk is not
competence. The risk is that the rigor is aimed at depth, and depth without a feeling
produces a game that reviews well, sells to four thousand systems players, and is
remembered fondly by all of them.

**What the gap means.** A 60-to-1 ratio says your constraint is not craft. It is
emotional design and distribution — the two things this repository has the least of and
currently treats as out of scope. So shift the resources accordingly: spend the next week
on parts-as-objects, on the two-second shipment animation, and on putting the build in
ten human hands, and spend approximately zero further engineering on the benchmark until
someone who is not on this team has played it and either laughed or shrugged.

And re-specify the goal. "#1 paid" as a target makes you optimize for a lottery.
"A game that converts if we get one lucky break" is the same ambition, honestly stated,
and it is the only version anyone has ever actually achieved.
