-- Two small marks, both about an assistant that never read the rules
--
-- THE FIRST ANSWER CARRIES THE START PAGE.
--
-- The connect page has said "call read_manual with section start before you
-- use any of this" since manual version 54. A live session on 19 September
-- called check_in, check_in, publish, publish, publish and never once called
-- read_manual. A client that truncates the connect string, or one that hands
-- server instructions to a model that has already decided what it is doing,
-- leaves the instruction unread — and there is no second place it appears.
--
-- So the first tool answer of a session that has not read the manual carries
-- the start page with it, once. The bearer token IS the session here (the MCP
-- transport is stateless; see migrations/014_manual_version.sql for the whole
-- of that reasoning), so the mark lives beside manual_version on the same row
-- and is read out of the SELECT authenticate() already runs. Keying it on the
-- token hash also covers the sessions that never send an initialize at all,
-- which is every agent-key client whose harness does not run the handshake.
--
-- NULL means the start page has not been handed to this session yet. Calling
-- read_manual sets it too: an agent that read the manual is not told to.
ALTER TABLE oauth_tokens ADD COLUMN IF NOT EXISTS manual_start_sent_at timestamptz;

COMMENT ON COLUMN oauth_tokens.manual_start_sent_at IS
  'When this session was handed the manual''s start section on a tool answer, or read it itself. NULL means it has had neither.';

-- WHAT WAS ASKED ABOUT, SO NOBODY IS TRAPPED BY THE ASKING.
--
-- A posting that does not say enough to describe the thing to a stranger comes
-- back unposted, with the questions to put to the human
-- (src/domain/postingDetail.ts). Somebody really may not know the answers — a
-- spring off a pedal set they no longer own, a box of cables out of a cupboard
-- — so `detail_unknown` on a second attempt takes the posting as it stands.
--
-- That second attempt has to be checkable, and it cannot be checked in memory:
-- the service runs several tasks and an agent reaching a different one on its
-- retry would be trapped by a rule meant to trap nobody. One row per account
-- per thing, rewritten on each ask, is the whole of it.
--
-- No posting content beyond the poster's own handful of words for the thing,
-- which is the same text `kind` already carries on every posting they make. The
-- table is disposable: truncating it costs one extra round of questions.
CREATE TABLE IF NOT EXISTS posting_detail_asks (
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind_key   text NOT NULL,
  asked_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, kind_key)
);

COMMENT ON TABLE posting_detail_asks IS
  'The last time an account was asked for more detail about a thing, keyed on its own words for it. Read only by the detail_unknown escape hatch; safe to truncate.';
