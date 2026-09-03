-- Archiving a finished connection. Two people who matched, opted in and took
-- the connection off-platform (swapped numbers, joined the book club) can have
-- it filed away: a fourth, SUCCESS terminal state, distinct from 'declined'
-- and 'closed'. The match ROW and its disclosed-profile linkage stay put, so
-- the connection record is retrievable afterwards — the counterparty's
-- disclosed first name and area, the category, and the dates. What is torn
-- down is the live channel (the state leaving 'open' is enough to stop
-- channel_send/receive), and any uncollected channel messages are expired so
-- the ordinary sweep clears them. The conversation itself and the phone number
-- were never retained here and are not part of the record.
--
-- archived_by / archived_at / archived_via record who filed it and when, the
-- same recorded_via shape the verdict and opt-in paths use.
ALTER TABLE matches DROP CONSTRAINT IF EXISTS matches_state_check;
ALTER TABLE matches
  ADD CONSTRAINT matches_state_check
  CHECK (state IN ('open', 'declined', 'closed', 'archived'));

ALTER TABLE matches ADD COLUMN IF NOT EXISTS archived_at  timestamptz;
ALTER TABLE matches ADD COLUMN IF NOT EXISTS archived_by  uuid REFERENCES accounts(id);
ALTER TABLE matches ADD COLUMN IF NOT EXISTS archived_via text;

-- Retrieval lists archived connections newest-first for an account; the
-- partial index keeps that list cheap without touching the open-match path.
CREATE INDEX IF NOT EXISTS matches_archived_idx
  ON matches (account_want, account_have, archived_at)
  WHERE state = 'archived';
