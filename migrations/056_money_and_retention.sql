-- THE 2026-09-28 REVIEW: what the database has to hold for the money,
-- photo and retention fixes.
--
-- 1. EMAIL EVENTS STOP HOLDING ADDRESSES.
--
-- email_events kept every SES event's recipient list as plain addresses
-- (recipients) and the whole SES payload beside it (raw), which carries the
-- same addresses again in mail.destination, the headers and the bounce and
-- complaint lists — for ever. Neither was read by anything: the suppression
-- list and the account marks are written from the event as it arrives, and the
-- only reader of this table counts rows by event_type.
--
-- From here the worker writes recipient_hashes (the same keyed HMAC, "v2",
-- that accounts.email_hash_v2 and email_suppressions use, so an operator can
-- still ask "did an event mention this address?" by hashing it) and detail,
-- which keeps only the bounce and complaint type fields SES sends — no
-- address, no header. Both old columns are emptied here and nothing writes
-- them again.
--
-- WHY THE OLD ROWS ARE NULLED RATHER THAN HASHED. The hash is keyed with the
-- email pepper, which lives in Secrets Manager and is never in the database,
-- so SQL cannot compute it. The old rows keep their event type, message id,
-- account and time, which is everything anything reads.
--
-- The columns stay (nullable) for one release so a task still running the old
-- code during a rolling deploy does not fail its insert; the ttl-expiry
-- retention pass also nulls anything such a task writes. A later migration can
-- drop them.
--
-- And a retention of ninety days, run on the ttl-expiry tick
-- (workers/emailEventsWorker.ts, purgeOldEmailEvents), which needs the index
-- on created_at.
ALTER TABLE email_events ADD COLUMN IF NOT EXISTS recipient_hashes jsonb;
ALTER TABLE email_events ADD COLUMN IF NOT EXISTS detail jsonb;
ALTER TABLE email_events ALTER COLUMN raw DROP NOT NULL;
UPDATE email_events SET recipients = NULL, raw = NULL
 WHERE recipients IS NOT NULL OR raw IS NOT NULL;
CREATE INDEX IF NOT EXISTS email_events_created_idx ON email_events (created_at);

COMMENT ON COLUMN email_events.recipients IS
  'RETIRED 2026-09-28: plain addresses. Emptied by migration 056 and never written again; see recipient_hashes.';
COMMENT ON COLUMN email_events.raw IS
  'RETIRED 2026-09-28: the whole SES payload, addresses included. Emptied by migration 056 and never written again; see detail.';
COMMENT ON COLUMN email_events.recipient_hashes IS
  'The event''s recipients as keyed HMAC-SHA256 v2 hashes (domain/accounts.ts emailHash), never the addresses.';
COMMENT ON COLUMN email_events.detail IS
  'The bounce / complaint type fields SES sent (bounceType, bounceSubType, complaintFeedbackType). No address, no header.';

-- 2. THE SERVER'S OWN STRIP OF A PHOTO.
--
-- The browser's "I took the hidden details out" is a claim anybody can send.
-- The server now re-encodes the object at the send press and records that it
-- did; the metadata gate at the send step passes on this column's being set by
-- that code, and on nothing a request carries (domain/channelPhoto.ts).
ALTER TABLE conversation_photos ADD COLUMN IF NOT EXISTS metadata_stripped_at timestamptz;
COMMENT ON COLUMN conversation_photos.metadata_stripped_at IS
  'When the server itself re-encoded the object with no metadata (EXIF, GPS, XMP, ICC). Null until then; a photo is never sent without it.';

-- 3. EXPIRED HUMAN SESSIONS ARE PURGED.
--
-- A session row past its expires_at is refused on read but was never deleted.
-- The ttl-expiry tick now deletes them a day after they lapse; the index keeps
-- that a range scan.
CREATE INDEX IF NOT EXISTS counter_sessions_expires_idx ON counter_sessions (expires_at);
