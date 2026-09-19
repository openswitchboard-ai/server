-- THE SWITCHBOARD KEEPS THE SEARCH (Lachlan, 20 September 2026).
--
-- The founder asked whether an assistant could simply read the whole board and
-- judge for itself. The answer is no: an open, queryable board ends the
-- anonymity the whole thing rests on, makes scraping trivial, breaks the sealed
-- best-offer sale and the one-at-a-time line, and feeds strangers' words to
-- assistants at scale. So the search stays here, and what changes is the
-- MATERIAL the assistant has and what it can do with it — scoped strictly to
-- its own human's postings and the introductions already made to them.
--
-- 1. THE HUMAN'S OTHER WORDS FOR THE THING.
--
-- `kind` is one short phrase, and one phrase is all the switchboard has ever
-- had to go on. A person has more: the trade name, the part number, the thing
-- everyone in that hobby calls it, and — just as useful — the near neighbour it
-- is emphatically NOT. Both go here, as plain phrases, on the posting itself.
--
--   also_called  up to six short phrases, the human's other words for the same
--                thing. They join the projection the embedding is built from
--                and the word bag the tiers are decided on, so the search
--                itself gets better (src/domain/matchRules.ts projectionText,
--                src/domain/matchTiers.ts).
--   not_these    up to six short phrases the human says it is NOT. A NEGATIVE
--                WORD SIGNAL and nothing more: a candidate whose words are
--                dominated by one of them cannot be sure and loses its word
--                agreement. Never a hard filter, and never used to hide
--                anything from the human — they still hear about it as a maybe
--                and they still decide.
--
-- Both are the human's own free words, so both are screened at the posting door
-- of the one intake pipe exactly as `kind` is (src/intake, promptSafe and the
-- model screen: no figures, no contact details, no instructions to an AI).
ALTER TABLE cards ADD COLUMN IF NOT EXISTS also_called jsonb;
ALTER TABLE cards ADD COLUMN IF NOT EXISTS not_these jsonb;

COMMENT ON COLUMN cards.also_called IS
  'Up to six short phrases: the human''s other words for the same thing. Folded into the projection the embedding is built from and into the word agreement. Screened at the posting door like kind.';
COMMENT ON COLUMN cards.not_these IS
  'Up to six short phrases the human says it is NOT. A negative word signal only: never a filter, never used to hide anything from the human.';

-- 2. SAYING IT IS NOT IT.
--
-- An introduction the switchboard offered as a maybe, closed because the human
-- looked and said it is not the thing. It closes EXACTLY as an ordinary decline
-- closes — reasonless to the other side, no reason ever crossing, the slot
-- freed for whoever is next, no mute of the other account — and it writes one
-- row here.
--
-- WHY THE ROW EXISTS. The lines in src/domain/matchTiers.ts were fitted on a
-- hundred and forty-four pairs one agent wrote in one session, and the header of
-- that file says outright they must be re-tuned on real runs before anyone
-- trusts them further. This is the real run: a human looked at a pair the tiers
-- called a maybe and said no. Nothing reads it yet; it is evidence for the
-- re-tune.
--
-- WHAT IT HOLDS AND WHAT IT DOES NOT. The two postings and the signals the
-- tiers were decided on. No account id, no words of either posting beyond what
-- the signals already are, no figure of any kind, no place. The postings
-- themselves carry the words, and they expire on their own.
CREATE TABLE IF NOT EXISTS not_the_thing (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at  timestamptz NOT NULL DEFAULT now(),
  match_id    uuid NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  card_want   uuid NOT NULL,
  card_have   uuid NOT NULL,
  -- Which tier the introduction was made in: 'sure' or 'possible'.
  tier        text NOT NULL,
  -- The word-agreement signals for the pair, recomputed from the two postings
  -- at the moment the human said no: the weighted overlap, the coverage, and
  -- whether the brands, the models and the head nouns agreed.
  signals     jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (match_id)
);

CREATE INDEX IF NOT EXISTS not_the_thing_created_idx ON not_the_thing (created_at);

COMMENT ON TABLE not_the_thing IS
  'One row each time a human looked at an introduction and said it is not the thing. The two postings, the tier and the pair''s signals, so the tier lines can be re-checked against real human judgements. No account id, no figures, no place.';
