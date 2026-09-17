-- Refresh token families: reuse detection, and an end date on a grant
--
-- A refresh token is rotated on every use: the old one is revoked and a new
-- one issued. That means a refresh token presented twice is one of two things,
-- and the switchboard cannot tell them apart — either the agent retried after
-- a reply it never received, or somebody else has a copy. Both are answered
-- the same way and the only safe answer is to end the whole chain: every token
-- descended from that authorization dies, and the person authorises again.
--
-- rotated_from already recorded one link of the chain. Walking it in both
-- directions on every reuse is a query per hop, so the family carries its own
-- id instead: every token minted from one authorization shares it, and killing
-- the family is one statement.
--
-- family_started_at is the moment the human said yes. Nothing descended from
-- that moment outlives it by more than ninety days, whatever the rotation has
-- been doing in between: a grant that has been quietly refreshing itself for a
-- year is not something the person agreed to.
ALTER TABLE oauth_tokens ADD COLUMN IF NOT EXISTS family_id uuid;
ALTER TABLE oauth_tokens ADD COLUMN IF NOT EXISTS family_started_at timestamptz;

CREATE INDEX IF NOT EXISTS oauth_tokens_family_idx
  ON oauth_tokens (family_id) WHERE family_id IS NOT NULL;

COMMENT ON COLUMN oauth_tokens.family_id IS
  'Every token descended from one authorization shares this. A refresh token presented after it was rotated kills the whole family.';
COMMENT ON COLUMN oauth_tokens.family_started_at IS
  'When the human authorised. The family dies ninety days after it, however often it has been refreshed.';
