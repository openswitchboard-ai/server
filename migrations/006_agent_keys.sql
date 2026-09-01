-- Agent keys (1.C): human-issued static bearer tokens for MCP clients that
-- cannot run an OAuth flow (some CLI runtimes drop OAuth config but pass a
-- static Authorization header straight through).
--
-- They live in oauth_tokens beside access and refresh tokens on purpose: the
-- kill switch's suspend-all, the revoke path and the expiry check are the
-- SAME statements, so an agent key can never quietly outlive them.

ALTER TABLE oauth_tokens DROP CONSTRAINT IF EXISTS oauth_tokens_kind_check;
ALTER TABLE oauth_tokens ADD CONSTRAINT oauth_tokens_kind_check
  CHECK (kind IN ('access','refresh','api-key'));

-- An agent key is issued by the human on their approval page, so it belongs
-- to no registered OAuth client.
ALTER TABLE oauth_tokens ALTER COLUMN client_id DROP NOT NULL;

-- The human's own label for the key, and a public handle the approval page
-- can name it by (the token hash never reaches the browser).
ALTER TABLE oauth_tokens ADD COLUMN IF NOT EXISTS name   text;
ALTER TABLE oauth_tokens ADD COLUMN IF NOT EXISTS key_id uuid;
CREATE UNIQUE INDEX IF NOT EXISTS oauth_tokens_key_id_idx
  ON oauth_tokens (key_id) WHERE key_id IS NOT NULL;
