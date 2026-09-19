# Tier calibration (SURE / POSSIBLE / NOTHING)

Sets the tier lines for search-and-shelf matching by calculation on labelled
sample pairs. No AI assistant is involved: the only model called is the
production embedding model, read-only.

## Run it

```
AWS_PROFILE=openswitchboard AWS_REGION=us-east-1 npm run calibrate-tiers
```

The first run embeds every posting (about 260 texts, around 80 seconds) and
caches the vectors in `.cache.json`, keyed by model id and projection text. The
cache is gitignored. Later runs need no AWS unless a posting changes. Nothing
touches a database or anything deployed.

## Files

- `pairs.json`: 144 labelled pairs (34 sure, 40 possible, 70 nothing; 82 marked
  `obscure`). Each has a want and a have `{category, kind, attributes}` written
  the way a careful assistant would post them. Categories are real
  `taxonomy.v2.json` nodes. A few are invented leaves an assistant might make
  up (`goods.hobby.model-rocketry`, `goods.motoring.parts.tractor`,
  `goods.clothing.watches.parts`), and a few are bare `goods` for when the door
  was unsure. `why` gives the reason for the label.
- `signals.ts`: the word agreement signal. The header comment explains the
  weights: identifiers 3, content words 1, generic nouns and bare sizes 0.25,
  stopwords 0. The score is a weighted Dice.
- `run.mts`: embeds with `embeddings.embedText` over `matchRules.projectionText`
  (the production call and projection), then computes the signals, searches
  the rules and prints the report. If `src/domain/matchTiers.ts` exists, it
  also runs that module's `tierFor` and `wordAgreement` over the same pairs.

## What the numbers mean

- **cos**: cosine similarity of the two projection embeddings (Titan v2).
- **word**: word agreement from `signals.ts`, 0 to 1.
- **cat**: `categoryCloseness` from matchRules. It is 0 for incompatible
  shelves. It is reported but no rule uses it, because it separates the tiers
  badly (AUC 0.62 for sure vs nothing): the set deliberately puts the same
  thing on different shelves and different things on the same shelf.
- **Rule family**:
  - SURE = `cos >= sureCos AND word >= sureWord`
  - POSSIBLE = `cos >= possCos OR (word >= possWord AND cos >= possWordCos)`
  - NOTHING = everything else

  The run also fits a cosine-only version to compare against.
- **Fitting**:
  - A NOTHING pair tiered SURE is forbidden outright.
  - The remaining errors have costs: POSSIBLE shown as SURE 3, SURE missed
    entirely 3, POSSIBLE missed 1.5, NOTHING shown as POSSIBLE 1, SURE shown
    only as POSSIBLE 1.
  - Grid steps are 0.01 on cosine and 0.02 on words.
  - Ties go to the flattest spot: the lowest mean cost when each line moves
    ±0.02.
- **Held-out**: a stratified 70/30 split with seed 20260920. The run also totals
  20 seeds, because one 30% split has only about 10 SURE and 21 NOTHING pairs.
- **Sensitivity**: each line is moved on its own by ±0.02 and ±0.05, and the
  run prints how the counts move.
- **POSSIBLE trade-off**: false POSSIBLE on NOTHING against missed pairs as the
  POSSIBLE cosine line moves. Where this line sits is a product decision (how
  many false "may or may not be" looks is one real one worth), not a
  statistical one.

## What this set does NOT cover

- **Real postings.** Every pair was written by one agent in one session. Real
  assistants word things differently, leave attributes out, and file things
  in odd places. Treat the lines as a first cut and re-check them on the
  rehearsal data before trusting them. The same goes for any lines in
  `matchTiers.ts`.
- **Base rates.** The NOTHING pairs are almost all hard negatives (same brand,
  same noun, part vs whole). Most pairs a live search looks at are nowhere
  near each other. So the false-POSSIBLE rate here (about 40%) is far above
  what users would see per candidate. What users would see depends on how
  many candidates search brings back per posting (`CROSS_SHELF_TOP_N`).
- **Geo, price, urgency, mutes and reputation bumps.** All pairs sit in one
  place with no price.
- **Thin postings** with no `kind` and no attributes. Only a few are here.
- **Services and social**, beyond a handful of pairs. The set is mostly goods,
  because that is where obscure items live.
- **Languages other than English**, misspellings, and units in other systems.
- **Many wants to one have.** Every pair is judged on its own.
- **The labels.** They are one person's judgement. The line between SURE and
  POSSIBLE for "the same thing, one side vague" is a call, and some pairs
  would split a room.
