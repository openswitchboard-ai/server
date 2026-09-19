# The Jev shadow

An outside model is asked two of this switchboard's own judgements, its answer
is written down beside ours, and **nothing the switchboard does changes because
of it**. That is the whole arrangement. It runs on dev and nowhere else.

The code: `src/shadow/jev.ts` (the client), `src/shadow/jevTrials.ts` (the two
trials and the boundary of what is sent), `migrations/047_jev_shadow.sql` (the
table), `scripts/ops/jev-shadow-report.mts` (the only thing that reads it).

## Why

Two of the decisions this service makes are closed questions with a small set
of answers, and both are currently answered by a cosine over Titan embeddings
and a weighted blend:

- **Which taxonomy node a posting belongs under.** The door files it, snapping
  a path the catalogue has never heard of onto the nearest node it knows
  (`src/domain/categoryBackfill.ts`). Run 9 on dev is what made this a
  question: a have went up under an invented branch and the want for the same
  object went up somewhere else, and the two never met.
- **Whether a want and a have are about the same thing.** The engine scores the
  pair and the score decides whether anybody is introduced.

Nobody knows how often either is wrong, because there has never been a second
opinion to compare against. TypeSafe AI's System One model ("Jev") answers
exactly this shape of question — pick one of these, score this on this ladder,
how true is this — so asking it the same questions and keeping both answers is
the cheapest honest way to find out.

## What is sent

**Trial A, category at the door.** After a posting passes screening:

```json
{ "kind": "road bike, 56cm", "attributes": { "size": "56cm", "condition": "used" } }
```

`kind` is the poster's own handful of words for the thing, which is already
shown to the other side of every introduction. `attributes` are the structured
facts they chose to assert, reduced to strings, numbers and booleans.

The question is one `choice` over at most seven taxonomy nodes — the top five
from the existing suggester, plus the node we filed it under and the one the
assistant actually wrote where the catalogue knows them — described by their
label path in plain words, plus `none_of_these`.

The suggester is run on the posting's OWN words and stated facts, with nothing
about the filing in them. It used to be run on the node we had already chosen,
which scores 1.0 against itself and brings its own neighbours up behind it, so
every option on the ballot was a variation on our answer and Jev could only
agree with us. Our node still goes on the ballot by name — agreement has to be
possible — and the row records it under `ours.filed`.

**Trial B, want against have.** For the five best-scoring pairs of a matching
run at 0.45 and above:

```json
{ "want": { "kind": "...", "category_label": "Secondhand consumer goods > Bicycles > Road bikes",
            "attributes": { } },
  "have": { "kind": "...", "category_label": "...", "attributes": { } } }
```

The questions are three nouls and one four-level score: is it the same kind of
thing, is everything stated on both sides compatible, is it the same specific
product or model where one is named, and how well does it fit.

## What is never sent

No price and no price band. No geography of any kind — bucket, latitude,
longitude, radius, country. No account id, no email, no card id, no ask, no
urgency, no conversation, no message, no photograph, and no free text beyond
the two fields above. The builders in `jevTrials.ts` are the only place that
decides this, and the suite asserts on their **exact key sets** rather than on
the absence of a few names, so a field added to a card later cannot quietly
join the request.

The API key is never logged, never put in an error and never written down. The
state is never logged either, at any level.

## Reading the answers

Both readings are TypeSafe's own illustrative figures from their consistency
cookbook, and **neither is ours until somebody has validated it against our own
labelled postings**. They are recorded as derived fields, not applied to
anything.

- A `choice` counts as **decided** when the top probability is at least `0.60`
  (`JEV_CHOICE_DECIDED_MIN_P`); below that the row is uncertain and the report
  counts the two agreement rates separately.
- A `noul` reads as **yes** above `0.70`, **no** below `0.30`, and uncertain
  in between (`JEV_NOUL_YES`, `JEV_NOUL_NO`). The raw value is stored beside
  the band so these rows can be re-read under different bands for nothing.

Options are kept to a handful because their tested range for a choice question
is four to six mutually exclusive options with a short description each; the
API would take 255 and that is not a reason to send them. Their throwaway `uid`
field is deliberately **not** sent: it exists for independent repeat sampling in
their own experiments, and we want the same posting to get the same answer.

## Dev only, and shadow only

Three separate things have to be true before a single request goes out:

1. `JEV_SECRET_ARN` is set. Infra passes it to **dev tasks only**
   (`infra/lib/core-stack.ts`, search "jev"); the secret `osb/dev/jev` is
   imported by name, never created by CloudFormation, so the key itself never
   passes through a template. **There is no `osb/prod/jev` and infra never
   makes one** — the prod template is byte-for-byte unchanged by this work.
2. `envName` is not `prod`. The client refuses to initialise in prod even with
   the variable set, and says so in a boot line, because one infra deploy
   reaches both environments and "prod got the env var by accident" is a thing
   that happens to every project eventually.
3. The call site is one of the two trials. Nothing else asks.

Nothing reads `jev_shadow` except the report script an operator runs by hand.
The matching run's outcome and the screening verdict are byte-for-byte what
they would have been with the shadow off; both hooks are started rather than
awaited, wrapped in `try`/`catch` at the call site and again inside, and the
client never throws. A shadow that something acts on is not a shadow.

## The rehearsal transcript scorer

`scripts/eval/jev-transcript-score.mts` (`npm run jev-transcript`) is a third,
separate use of the same model, and it is **offline and eval-only**: it reads a
markdown transcript file from disk, scores each assistant turn against the
manual's speech rules, and prints a table. It is not a route, it is not wired
into the server, no running switchboard calls it, and nothing an assistant can
reach goes near it. It fetches the key itself from `osb/dev/jev` and does not
come through the server's config, boot path or database.

```
AWS_PROFILE=openswitchboard AWS_REGION=us-east-1 \
  npm run jev-transcript -- rehearsals/run9.md --json run9-scores.json
```

The rubric is nine nouls (`scripts/eval/transcriptScore.mts`), every one
phrased so that **yes means the slip happened**, read through the same bands as
trial B: an invented figure, a claimed queue, machine detail read aloud, an
offer of contact on a near miss, a promise to notify with nothing behind it, a
picture described before the human has looked, the PIN touched in any way, a
question the switchboard already answers, and an area vaguer than a suburb.

**Two of those nine are not in the manual in so many words**, and the rubric
and the report both say so. `machine_detail_aloud` extends the manual's rule
about field names and "the machinery's vocabulary stays under the water" to
dotted category paths and ids, which the manual does not mention;
`describes_unseen_picture` is not in the manual at all. A count against either
is a finding about the rubric as much as about the assistant. Findings written
under a step (`> …`) are never scored — they are somebody's conclusion about
the turn above, and feeding a conclusion back in would score the reader.

**It runs only on transcripts of our own rehearsals.** The switchboard never
sees, never stores and never scores what a real assistant says to its human —
those conversations do not pass through this service and are not ours to read.
That is a decision taken on 2026-09-19, not a gap waiting to be filled.

## The report

```
AWS_PROFILE=openswitchboard npm run jev-report
AWS_PROFILE=openswitchboard npm run jev-report -- --days 30 --limit 40
```

Agreement rate for trial A split by decided and uncertain, the disagreements in
full with both answers and Jev's confidence, the pair table read through the
bands, the two corners that matter (we introduced and Jev says a different kind
of thing; we did not introduce and Jev says the same kind and compatible), and
mean latency and token totals for each trial. It refuses to run against prod,
where the table exists and is permanently empty.

## TypeSafe's terms, and what has to happen before any prod use

TypeSafe states that it does not train on user data, and offers a data
processing agreement with zero data retention on its enterprise plan. **Neither
of those is in hand.** This deployment is running on ordinary terms, against
dev data, with the smallest state either question can be answered from.

**A DPA with ZDR is required before any prod use of this model, in shadow or
otherwise, and before anything in prod is sent to it in any form.** A decision
to let an outside model touch a live judgement is a separate decision again,
and neither belongs in a small edit to a call site.

## Truncating it

`TRUNCATE jev_shadow;` at any time. Nothing depends on a row, and the answer
this table exists to produce is a rate, not a record.
