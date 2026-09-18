-- What an outside model said, beside what we said, and nothing acting on it
-- (src/shadow/jev.ts, src/shadow/jevTrials.ts; docs/jev-shadow.md).
--
-- WHY THIS TABLE EXISTS. Two of this switchboard's judgements are closed
-- questions with a small set of answers: which taxonomy node a posting belongs
-- under, and whether a want and a have are about the same thing. Both are
-- currently answered by a cosine over embeddings and a weighted blend, and
-- nobody knows how often that is wrong, because there has never been a second
-- opinion to compare it against. This table is that second opinion, written
-- down over a few weeks of dev traffic so the question can be settled with
-- numbers instead of impressions.
--
-- NOTHING READS IT. Not the matcher, not the door, not any page or email. The
-- only thing in this repository that selects from it is
-- scripts/ops/jev-shadow-report.mts, which an operator runs by hand. A shadow
-- that something acts on is not a shadow, and letting an outside model touch a
-- live judgement is a decision to be made deliberately with a data agreement
-- in hand — not one that arrives by a small edit to a call site.
--
-- DEV ONLY. The feature is off unless JEV_SECRET_ARN is set, infra sets it on
-- dev tasks and only dev tasks, and the client refuses to start in prod even
-- if the variable somehow reaches it. On prod this table exists and stays
-- empty, which is the cheapest way for the two schemas to stay identical.
--
-- WHAT IS IN A ROW. The card ids, so a disagreement can be looked at; what we
-- answered; what Jev answered; and the cost and latency of asking. NO ACCOUNT
-- IDS, and nothing sent to Jev carries a price, a location, an address, a
-- conversation or any free text beyond the poster's own word for the thing and
-- their structured attributes. SAFE TO TRUNCATE at any time: nothing depends
-- on a row here, and the answer to the question this table exists to ask is a
-- rate, not a record.
CREATE TABLE IF NOT EXISTS jev_shadow (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at     timestamptz NOT NULL DEFAULT now(),
  -- 'category' is the door trial (one posting, which node); 'pair' is the
  -- matching trial (two postings, same thing or not).
  trial          text NOT NULL CHECK (trial IN ('category', 'pair')),
  card_id        uuid,
  other_card_id  uuid,
  -- Our own answer, in whatever shape the trial has. Stored rather than
  -- recomputed because the weights and the taxonomy both move, and a
  -- comparison against today's rules would be a comparison against the wrong
  -- thing.
  ours           jsonb NOT NULL,
  jev            jsonb NOT NULL,
  latency_ms     int,
  input_tokens   int,
  output_tokens  int
);

-- The one way this is ever read: a trial, over a window of days.
CREATE INDEX IF NOT EXISTS jev_shadow_trial_created_idx ON jev_shadow (trial, created_at);

COMMENT ON TABLE jev_shadow IS
  'Dev-only shadow record of an outside model''s answer beside our own. No account ids, nothing acts on it, safe to truncate.';
