-- A SHORT LINK FOR A COLLECTED PHOTO (27 September 2026).
--
-- A collected photo used to be handed to the recipient's assistant as a raw
-- presigned S3 GET: about 1,500 characters on an amazonaws.com host, with the
-- signature and a session token in the query string. A small local model in a
-- production run could not copy it out whole. The assistant is now handed a
-- short address on the switchboard's own host instead, <counter>/p/<token>,
-- and opening it signs a fresh S3 GET on the server and redirects to it.
--
-- WHAT THIS ADDS. view_token_hash is the SHA-256 (hex) of that token, written
-- in the same statement that claims the row at collection, so a row is never
-- collected without its link or given one twice. The token itself is kept
-- nowhere: it is 16 random bytes handed to the collecting agent once.
--
-- NOTHING ELSE CHANGES. The link works for the same fifteen minutes after
-- collection that the presigned URL did, the row is still collected once, and
-- the sweep still deletes the object and the row together once that window has
-- passed. Rows collected before this column existed simply have no short link.
ALTER TABLE conversation_photos ADD COLUMN IF NOT EXISTS view_token_hash text;

CREATE UNIQUE INDEX IF NOT EXISTS conversation_photos_view_token_idx
  ON conversation_photos (view_token_hash)
  WHERE view_token_hash IS NOT NULL;

COMMENT ON COLUMN conversation_photos.view_token_hash IS
  'SHA-256 hex of the short link token handed to the recipient''s agent at collection. The link opens for fifteen minutes after collected_at.';
