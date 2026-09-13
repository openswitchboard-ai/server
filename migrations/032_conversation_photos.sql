-- A photo crosses inside the conversation, and nowhere else (phase 1.J)
--
-- The hole this fills, in the owner's words (13 September 2026): two people
-- reach an agreed price on a second-hand bike having never seen it. That is
-- the one place this switchboard is worse than the marketplace it replaces,
-- and it is worse for a reason worth keeping — what a person posts is
-- public-ish and thin, and an image carries a face, a number plate, a house.
--
-- So a photo travels in exactly one place: the open conversation between two
-- people who have each already pressed to be there. That argument is spent by
-- then, and the handling is the handling every message already gets — held
-- encrypted, handed over once, and gone.
--
-- THE SHAPE, and why each column is here.
--
-- The bytes are NOT in this table and never pass through the service's memory.
-- They go from the sender's own browser straight into the photo bucket on a
-- presigned PUT, and they come back to the other side's agent on a presigned
-- GET. This row is the record of one photo waiting on one conversation: who it
-- is for, where the bytes are, and the three timestamps that decide whether it
-- is still there.
--
-- sent_at is null between the presign and the human pressing Send. A row in
-- that state is nothing to anybody: it is not collectable, it is not counted,
-- and the sweep clears it with its object when it expires. It exists because
-- the bytes are uploaded by the browser before the person has finished with
-- the page, and a photo that was picked but never sent must not be delivered.
--
-- collected_at is set when the other side's agent collects. THAT IS THE DELETE
-- THE RELAY PROMISES, with one honest difference from a message: a message is
-- handed over as text inside the answer, so its row goes in the same
-- transaction that reads it. A photo is handed over as a link to the bytes,
-- and bytes deleted at that instant would be a dead link. So the row is spent
-- at collection — it can never be collected twice, and nothing can fetch it
-- again — and the sweep deletes the object and the row together once the link
-- handed over has run out. The bytes outlive the collection by the life of the
-- link and no longer.
--
-- caption_enc is words, so it is treated as words: encrypted under the same
-- channel key a message body is, screened for a money figure on the way in the
-- same way, and deleted with the row. A photo with nothing typed beside it
-- leaves this null.
--
-- sha256 and size_bytes are what the presigned URL was signed for. The bytes
-- that land are the bytes the browser hashed, or S3 refuses the write.

CREATE TABLE IF NOT EXISTS conversation_photos (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id        text NOT NULL,
  match_id          uuid NOT NULL REFERENCES matches(id),
  sender_account    uuid NOT NULL REFERENCES accounts(id),
  recipient_account uuid NOT NULL REFERENCES accounts(id),
  s3_key            text NOT NULL UNIQUE,
  content_type      text NOT NULL,
  size_bytes        integer NOT NULL,
  sha256            text NOT NULL,
  caption_enc       bytea,
  created_at        timestamptz NOT NULL DEFAULT now(),
  sent_at           timestamptz,
  collected_at      timestamptz,
  expires_at        timestamptz NOT NULL
);

-- Collection reads by (recipient, channel) oldest first, and only what has
-- been sent. The sweep reads by expiry and by collection. Nothing indexes the
-- sender, because nothing looks a sender up — the same rule the message table
-- follows.
CREATE INDEX IF NOT EXISTS conversation_photos_delivery_idx
  ON conversation_photos (recipient_account, channel_id, created_at)
  WHERE sent_at IS NOT NULL AND collected_at IS NULL;
CREATE INDEX IF NOT EXISTS conversation_photos_expiry_idx
  ON conversation_photos (expires_at);
CREATE INDEX IF NOT EXISTS conversation_photos_collected_idx
  ON conversation_photos (collected_at)
  WHERE collected_at IS NOT NULL;

COMMENT ON TABLE conversation_photos IS
  'One photo waiting on one open conversation. The bytes live in the photo bucket; this row is who it is for and when it stops existing. Nobody at the switchboard looks at the image: there is no automated image screening, and the terms forbid what you would expect.';
COMMENT ON COLUMN conversation_photos.sent_at IS
  'Null between the presign and the human pressing Send. Only a sent photo is collectable.';
COMMENT ON COLUMN conversation_photos.collected_at IS
  'Set when the other side collected it. The row is spent from that moment and the sweep deletes it with its object once the handed-over link has run out.';
