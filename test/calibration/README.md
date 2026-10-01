# Tier calibration (SURE / POSSIBLE / NOTHING)

Sets the tier lines for search-and-shelf matching by calculation on labelled
sample pairs. No AI assistant is involved: the only model called is the
production embedding model, read-only.

## Run it

```
OSB_CALIBRATION_PAIRS=/path/to/pairs.json AWS_PROFILE=<profile> AWS_REGION=us-east-1 npm run calibrate-tiers
```

The first run embeds every posting and caches the vectors in `.cache.json`, keyed by model id and projection text. The
cache is gitignored. Later runs need no AWS unless a posting changes. Nothing
touches a database or anything deployed.

## Files

- `pairs.json` (NOT in this repository): the labelled pairs are evaluation
  data. `run.mts` reads them from `OSB_CALIBRATION_PAIRS` (a path to the file),
  or from `server/test/calibration/pairs.json` under `OSB_INTERNAL_DIR`, or
  from a sibling checkout at `../internal`. Without one it says so and exits
  cleanly. To run it on your own deployment, write your own: a JSON array of
  `{id, label: "sure"|"possible"|"nothing", obscure?, why, want, have}`, where
  `want` and `have` are `{category, kind, attributes}` written the way a
  careful assistant would post them.
- `signals.ts`: the word agreement signal. The header comment explains the
  weights: identifiers 3, content words 1, generic nouns and bare sizes 0.25,
  stopwords 0. The score is a weighted Dice.
- `run.mts`: embeds with `embeddings.embedText` over `matchRules.projectionText`
  (the production call and projection), then computes the signals, searches
  the rules and prints the report. If `src/domain/matchTiers.ts` exists, it
  also runs that module's `tierFor` and `wordAgreement` over the same pairs,
  telling it the want is the `a` side (`wantIs`), which the covered rule
  needs.

## The borderline judge

```
OSB_INTERNAL_DIR=/path/to/internal AWS_PROFILE=<profile> AWS_REGION=us-east-1 npm run calibrate-jev
```

`jev-judge.mts` runs the matcher's own decision over the same pairs: the rules
tier, which pairs are put to Jev (`jevJudge.jevJudgesTier`), Jev's own tier,
and the tier after the near-miss floor (`jevJudge.flooredTier`), and prints
the three as confusion tables. A pair may also be labelled `near-miss` (close,
never an introduction); `run.mts` counts that as `nothing`, because its lines
only decide who is introduced. Jev's answers are cached in `.jev-cache.json`
(gitignored), keyed by the exact state and questions sent, so a re-run only
calls Jev for pairs it has not seen in that form; `--no-call` uses the cache
alone. The key is read from Secrets Manager and never printed.

## Shelf choice at the door

`npm run calibrate-shelf` (`jev-shelf.mts`) runs the publish door's shelf
decision over a labelled set of postings (`shelf-set.json` in the private
repository) with the rules alone and with Jev's shelf choice, and prints the
founder's bars. It embeds with the production model, so it needs AWS; Jev
answers are cached in `.jev-shelf-cache.json` (gitignored).

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

## What a labelled set like this does not cover

Pairs written by hand are not real postings: real assistants word things
differently, leave attributes out, and file things in odd places. A set of
mostly hard negatives also overstates the false-POSSIBLE rate a user would
see. Treat lines fitted this way as a first cut and re-check them on real
traffic before trusting them.
