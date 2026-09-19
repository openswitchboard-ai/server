-- Three things about shelves, all decided by Lachlan on 20 September 2026
-- (src/domain/shelfGaps.ts, src/domain/shelfPick.ts, src/domain/matcher.ts).
--
-- 1. THE SHELF GAP LOG.
--
-- When a posting arrives under a path the catalogue does not know, the door
-- either files it confidently, or asks the human which of a few shelves it is
-- (SHELF_UNCLEAR), or files it under the top level. The confident case is the
-- catalogue working. Every other case is the catalogue missing a shelf somebody
-- needed, and until now the only trace of it was a log line nobody counts.
--
-- So one row is written every time the door is unsure, and one more when the
-- human's answer comes back. `npm run shelf-gaps` reads them grouped by the
-- poster's own words, so an operator can see "sim racing: 14 times, picked
-- console accessories 6, none of these 5" and decide what shelf to add.
--
-- NO ACCOUNT ID, on purpose. This is research about the catalogue, and a row
-- that could be joined back to a person would turn a list of missing shelves
-- into a list of what each person was after. The two rows of one attempt are
-- joined by `attempt`, a random id that means nothing outside this table; the
-- only thing that ever held it beside an account is shelf_attempts below, which
-- lives for a day.
--
-- NOTHING FROM THE POSTING BUT ITS WORDS AND ITS PATH. `kind` is the poster's
-- own handful of words for the thing (the field already capped at sixty
-- characters and screened at the door), `as_posted` is the path the assistant
-- sent. No attributes, no price, no ask, no place, and no figure of any kind.
--
-- RETENTION: 180 days, swept on the ttl-expiry tick (sweepShelfGaps). A gap
-- older than half a year is a question the catalogue has either answered or
-- stopped being asked.
CREATE TABLE IF NOT EXISTS shelf_gaps (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at  timestamptz NOT NULL DEFAULT now(),
  -- Joins the row that asked to the row that says how it ended. Never an
  -- account id and never derived from one.
  attempt     uuid,
  as_posted   text NOT NULL,
  kind        text,
  -- Up to five nodes the door weighed, nearest first, each with how far it
  -- stood in front of the catalogue: [{"category": "...", "lead": 3.7}].
  shortlist   jsonb NOT NULL DEFAULT '[]'::jsonb,
  outcome     text NOT NULL CHECK (outcome IN (
    'snapped_low_confidence', -- filed on a node nobody was sure of, without asking
    'asked',                  -- SHELF_UNCLEAR went back with the shortlist
    'human_picked',           -- the human chose a shelf from the options in chat
    'none_of_these',          -- the human recognised none of them
    'picked_from_list',       -- the human chose on the searchable page
    'top_level'               -- filed under goods, services or social
  )),
  -- The node the attempt ended on: the human's choice on the two picking
  -- outcomes, the switchboard's on the two filing ones, null otherwise.
  picked      text
);

CREATE INDEX IF NOT EXISTS shelf_gaps_created_idx ON shelf_gaps (created_at);
CREATE INDEX IF NOT EXISTS shelf_gaps_attempt_idx ON shelf_gaps (attempt) WHERE attempt IS NOT NULL;

COMMENT ON TABLE shelf_gaps IS
  'Every time the posting door was unsure which shelf, and how it ended. No account id, no attributes, no figures. Read by npm run shelf-gaps; swept at 180 days.';

-- The short-lived half: which account is in the middle of which shelf
-- question. It is what lets a second posting attempt be recognised as the
-- answer to the first, what the searchable page records its choice against,
-- and the ONLY place `attempt` sits beside an account id. Honoured for an hour,
-- swept after a day, and safe to truncate at any time: losing a row costs one
-- more question.
CREATE TABLE IF NOT EXISTS shelf_attempts (
  account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind_key    text NOT NULL,
  attempt     uuid NOT NULL DEFAULT gen_random_uuid(),
  as_posted   text NOT NULL,
  kind        text,
  asked_at    timestamptz NOT NULL DEFAULT now(),
  -- Set when the human said none of the options fit and was handed the page.
  none_at     timestamptz,
  -- Set by the press on that page: the shelf they chose.
  picked      text,
  picked_at   timestamptz,
  PRIMARY KEY (account_id, kind_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS shelf_attempts_attempt_idx ON shelf_attempts (attempt);

COMMENT ON TABLE shelf_attempts IS
  'Which account is part way through a shelf question, for an hour. The only row that holds an attempt id beside an account id; swept after a day, safe to truncate.';

-- 2. THE SEARCHABLE SHELF PAGE is a link action like every other page a human
-- presses, so the check on approval_links.action learns its name. Rewritten in
-- full, as 044 did; test/unit/linkActionsMigrated.test.ts holds this list to
-- the one in src/counter/links.ts.
ALTER TABLE approval_links DROP CONSTRAINT IF EXISTS approval_links_action_check;
ALTER TABLE approval_links ADD CONSTRAINT approval_links_action_check
  CHECK (action IN (
    'offer-accept',
    'stage3-disclosure',
    'settlement-approve',
    'offer-send',
    'collection-close',
    'negotiation-auto',
    'conversation-photo',
    'report',
    'conversation-renew',
    'shelf-pick'
  ));

-- 3. SEARCH AND SHELF, TIERED.
--
-- The matcher compared only postings on compatible shelves. From today it also
-- searches the whole board by meaning, the shelf counts toward the fit rather
-- than deciding whether a pair is looked at, and every introduction is made in
-- one of two tiers (src/domain/matchTiers.ts):
--
--   'sure'      an introduction exactly as before. Every row that already
--               exists is one of these, which is what the default says.
--   'possible'  it may or may not be the same thing. Everything about it works
--               the same, and every answer and email that names it says so,
--               so the human looks at the details and decides.
--
-- The fit sequencer reads it too: a possible never takes a slot while a sure
-- one is waiting on the same posting (src/domain/sequencer.ts).
ALTER TABLE matches ADD COLUMN IF NOT EXISTS certainty text NOT NULL DEFAULT 'sure'
  CHECK (certainty IN ('sure', 'possible'));

-- How many possibles one posting was given today: the cap reads this.
CREATE INDEX IF NOT EXISTS matches_possible_want_idx ON matches (card_want, created_at)
  WHERE certainty = 'possible';
CREATE INDEX IF NOT EXISTS matches_possible_have_idx ON matches (card_have, created_at)
  WHERE certainty = 'possible';

COMMENT ON COLUMN matches.certainty IS
  'sure: an introduction as ever. possible: may or may not be the same thing, and every answer and email naming it says so. Set by the matcher (src/domain/matchTiers.ts).';
