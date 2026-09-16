# Open question: how much taxonomy do we actually need?

Raised by Lachlan, 2026-09-17, unresolved. Written down so it survives a compaction.

**His question, in his words:** "I get we want taxonomy for item types and locations
to some extent, but do we need otherwise is the question." And earlier: "Are we
limiting the primary function being AI coordinating everything?"

## What the taxonomy carries today (schema 0.15.0, 589 nodes, 446 open)

| Piece | What it does | Could the AI do it instead? |
|---|---|---|
| The category itself | The agreed word, so "Trek MTB" and "push bike" meet | Partly — meaning-matching already runs beside it. Untested without the category. |
| `reserved` | Jobs, property, licensed trades, dating are closed | No. This is policy, and it is the network's only deliberate limit. |
| `attributes` (per leaf) | Typed fields (suspension: rigid/hardtail/full), so postings stay thin and comparable | Maybe — free text would carry the same facts and more leakage. |
| `phrase` / `article` | "your mountain bike" reads right in every sentence | Yes, an AI writes fluent English unaided. This exists because the SWITCHBOARD writes sentences, not the AI. |
| `default_reach` (new, built, NOT wired in) | A bike is local, a book posts, Italian practice is anywhere | Yes — manual v43 already tells the AI the rule. This is belt and braces. |

## The case for less

Every per-leaf field is a judgement I made across hundreds of leaves, each one
arguable, each one a thing to maintain, and each one a place the network's
opinion can be wrong in a way a capable model would not have been. 41 of 446
`default_reach` values were honestly unanswerable. The vision is AIs coordinating;
a fat central vocabulary is the opposite instinct.

## The case for more

Postings are anonymous and thin BECAUSE they are structured. Free text is where a
name, a street or a reason leaks, and the screen that catches those relies on
there being few places for them to hide. Matching on category plus attributes is
cheap and explainable; matching on embeddings alone is neither. And a silent
failure (a reach too narrow, a category nobody else uses) is invisible to the
human, so the network defaulting well matters more than it looks.

## What is actually decided

- Categories and locations: keep. Not in dispute.
- `reserved`: keep. It is policy, not vocabulary.
- `default_reach`: BUILT, NOT WIRED IN, deliberately. Manual v43 ships the same
  rule as guidance. Wire it only if measurement shows assistants get reach wrong.
- `phrase` / `attributes`: open. This is the real question.

## The test that would settle it

Post the same twenty things through the taxonomy and through a free-text-plus-
meaning path, and compare: do the same pairs meet, how much personal detail
leaks, and how do the sentences read. Nobody has run it. Until then both cases
above are argument rather than evidence.
