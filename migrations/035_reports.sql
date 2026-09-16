-- Reporting, severing and blocking
-- (docs/trust-and-safety.md, "Reporting" and "Enforcement"; step 5)
--
-- WHAT A REPORT IS. One human saying, in their own plain words, that the
-- person on the other side of an introduction is doing something they should
-- not be. It is the first thing on the switchboard that a person can raise on
-- their own behalf, and it is deliberately cheap to raise: one page, one short
-- line of words, one press.
--
-- A REPORT IS NEVER REFUSED FOR ITS WORDS. The words go through the same
-- intake pipe as everything else, at a door of their own, and the pipe cannot
-- refuse at that door: the worst that happens to a report someone wrote badly
-- is that the words are held for a person to read rather than written here.
-- Refusing to accept a report because of how it was phrased would be the one
-- refusal this system must never make.
--
-- WHAT IT DOES, ALL AT ONCE. The introduction is severed (nothing further is
-- delivered either way), the pairing is muted so the matcher never puts the
-- two of them together again, and every ledger entry behind that introduction
-- is held past the thirty days so there is evidence to look at afterwards.
--
-- WHAT THE OTHER SIDE IS TOLD. That the switchboard has closed the
-- conversation. Never that they were reported, never by whom, never why.
--
-- STATUS is the operator's, and only the operator's: 'open' until somebody has
-- looked, then 'reviewed' or 'dismissed' with a line saying what was done.
CREATE TABLE IF NOT EXISTS reports (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_account uuid NOT NULL REFERENCES accounts(id),
  reported_account uuid NOT NULL REFERENCES accounts(id),
  match_id         uuid,
  -- The reporter's own words, up to 300 characters. NULL where the pipe held
  -- them: the report still stands, and the words are in the ledger for a
  -- person to read under the ordinary ceremony.
  reason_words     text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  status           text NOT NULL DEFAULT 'open',
  resolved_at      timestamptz,
  resolution       text,
  CONSTRAINT reports_status_known CHECK (status IN ('open', 'reviewed', 'dismissed')),
  CONSTRAINT reports_reason_short CHECK (reason_words IS NULL OR char_length(reason_words) <= 300)
);

-- Two reads, and no others. "What has been said about this person?" and "what
-- is still waiting to be looked at?".
CREATE INDEX IF NOT EXISTS reports_reported_idx ON reports (reported_account);
CREATE INDEX IF NOT EXISTS reports_status_idx ON reports (status, created_at);

COMMENT ON TABLE reports IS
  'One human reporting the other side of an introduction. Filing one severs the introduction, mutes the pairing and holds the ledger entries behind it past the thirty days.';
COMMENT ON COLUMN reports.reason_words IS
  'The reporter''s own words, or NULL where the intake pipe held them. A report is never refused for its words.';

-- ---------------------------------------------------------------------------
-- The severed marker.
--
-- An introduction can already end three ways: declined by a human, archived as
-- finished, closed. None of those says "the switchboard stopped this", and the
-- difference matters to the sentence each side reads. The reporter is told
-- their report closed it; the other person is told only that the switchboard
-- closed the conversation, with nothing about who said anything or why.
--
-- `severed_by` is the account that asked for it, and NULL where the switchboard
-- severed it on its own — which is what a suspension does to every open
-- introduction an account is in.
ALTER TABLE matches ADD COLUMN IF NOT EXISTS severed_at timestamptz;
ALTER TABLE matches ADD COLUMN IF NOT EXISTS severed_by uuid;

COMMENT ON COLUMN matches.severed_at IS
  'Set when the switchboard closed this introduction itself: a report, or a suspension. The state column goes to closed in the same breath.';
COMMENT ON COLUMN matches.severed_by IS
  'The account whose report severed it, or NULL where the switchboard severed it on its own.';
