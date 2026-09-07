# Competitive baseline — what actually reaches #1 paid

The Chart Critic must argue against this document, not against a vibe.

## Sourcing limitation (read first)

`apps.apple.com`, `appbrain.com` and `similarweb.com` are blocked by this
environment's egress proxy, so **no live chart snapshot could be taken**. What
follows is assembled from web search results and general knowledge, and the
specific numbers cited to a source are marked. Treat unmarked structural claims
as reasoned, not measured. Anyone re-running this analysis with chart API access
should replace this file.

## The structural facts

**The top-paid games chart is a low-volume chart.** Almost all iOS game revenue
is free-to-play; the paid chart moves on a few thousand downloads a day in the
US. This is the *only* reason a solo developer can reach #1 there. It is also
why #1 paid is worth far less than it sounds — it is a prestige slot, not a
revenue slot.

**The chart is dominated by perennials, not newcomers.** Minecraft has held the
top paid slot for years (Apple's 2025 top paid game was *Minecraft*, per
[GSMArena's writeup of Apple's 2025 chart](https://www.gsmarena.com/most_downloaded_iphone_ipad_apps_games_2025-news-70667.php)).
Bloons TD 6, Geometry Dash, Stardew Valley, Plague Inc, and Heads Up! rotate
underneath it. Displacing that set requires an event, not merely a good game.

## The one precedent that matters — and what it actually proves

**Balatro.** Solo developer LocalThunk, published by Playstack, $9.99. On mobile
launch (26 Sep 2024) it took #1 paid on **both** the App Store and Google Play,
beating Minecraft, Slay the Spire and Heads Up!
([Pocket Tactics](https://www.pockettactics.com/balatro/mobile-release)), and
made close to $1M in seven days across both stores
([PocketGamer.biz](https://www.pocketgamer.biz/balatro-approaches-1-million-in-seven-days-on-mobile/));
it had passed 5M copies across all platforms by January 2025
([Wikipedia](https://en.wikipedia.org/wiki/Balatro_(video_game))).

**Now the part the team does not want to hear.**

Balatro did **not** chart on iOS from a standing start. It shipped on PC and
console in **February 2024** and spent roughly seven months becoming a
phenomenon — streamer saturation, a Game Awards nomination, "game of the year"
lists — *before* the mobile version existed. The App Store launch was a
**conversion event for an audience that already wanted it**, not a discovery
event.

So the honest reading of the precedent is:

> A solo-built premium roguelike can reach #1 paid on iOS **if it first becomes
> famous somewhere else.** Balatro is evidence that the mechanic class works. It
> is *not* evidence that a mobile-first premium launch can chart.

Any claim that TAKT "could be #1" that does not have an answer to the seven
months of prior fame is not a serious claim. This is the question the verdict
must answer head-on.

## What this implies for judging TAKT

The gate in `BENCHMARK.md` measures exactly one of the necessary conditions:
*is the mechanic deep enough to sustain the word-of-mouth phase*. The other
conditions, in rough order of how much they decide chart position:

| Factor | In this repo? |
|---|---|
| Prior fame on another platform | **No** |
| Streamer/creator legibility (is a clip of it good?) | Partly — depends on the snowball ceiling and the animation |
| Apple featuring | No |
| Price point and launch timing | No |
| Mechanical depth / retention | **Yes — this is what the gate measures** |
| Screenshot legibility on a store page | Partly — depends on the UI build |
| Zero-tutorial comprehensibility | **Yes — a design property we can judge** |

Three of seven are even partially addressable here. That ratio *is* the answer
to "would it be #1", and it does not improve by writing more code.

## The bar the mechanic must clear

For the mechanic not to be the limiting factor, TAKT needs, at minimum:

1. **A clip-worthy failure mode.** Balatro's virality is screenshots of
   preposterous numbers. TAKT needs a run where the line goes visibly insane.
   This is gate G5 (p95 ≥ 20× quota, p99 ≥ 50× median) and it is a *marketing*
   requirement wearing a math costume.
2. **A ten-second explanation.** "Stuff goes in the left, comes out the right,
   the order of your machines is the whole game." If that sentence does not
   land, there is no organic discovery.
3. **A reason to own it alongside Balatro, not instead of it.** Nobody buys the
   second-best version of a game they already have. The differentiator must be
   the ordering mechanic being genuinely a different kind of thinking — spatial
   and combinatorial rather than probabilistic. If TAKT reads as "Balatro with
   factories", it is dead on the store page.

## Verdict vocabulary

The Critic returns exactly one of:

- **WOULD NOT CHART** — the expected outcome for almost any new game, and the
  correct answer unless there is a specific reason otherwise.
- **COULD CHART WITH LUCK** — the mechanic is not the limiting factor, but
  charting still depends on the four things not in this repo.
- **CHART-PLAUSIBLE ON MERIT** — reserved for a game the Critic would personally
  bet on, at stated odds.

"CHART-PLAUSIBLE ON MERIT" requires an answer to the seven-months-of-fame
problem. There probably isn't one. Say so if there isn't.
