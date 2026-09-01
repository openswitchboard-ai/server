-- OpenSwitchboard patch-through transport (phase 1.B)
--
-- The relay CARRIES and does not KEEP. A message row exists between the
-- moment a sending agent hands it over and the moment the receiving agent
-- collects it, and collecting it is what deletes it (domain/channel.ts,
-- receiveMessages: SELECT ... FOR UPDATE, build, DELETE, COMMIT). Anything
-- never collected is deleted by the sweep 14 days after it was sent. Nothing
-- here is ever copied into the WORM consent log, into the service's own logs,
-- or into any aggregate: the only trace a relayed message leaves is a count.

-- ---------------------------------------------------------------------------
-- Per-channel data key. A channel gets its own 256-bit key when it opens,
-- wrapped by KMS under the env's identity key with the channel id in the
-- encryption context. Message bodies are encrypted under it, so the only code
-- that can read a body is the delivery path, and the key dies with the match
-- row it hangs on. The account envelope keys are deliberately NOT used here:
-- every decrypt through those writes an identity audit line to the write-once
-- consent log, and a conversation is neither identity nor consent.
-- ---------------------------------------------------------------------------
ALTER TABLE matches
  ADD COLUMN IF NOT EXISTS channel_key_enc bytea;

-- ---------------------------------------------------------------------------
-- Messages in flight. There is no ordering column beyond created_at and no
-- read flag: a row that has been read no longer exists.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS channel_messages (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id        text NOT NULL,
  match_id          uuid NOT NULL REFERENCES matches(id),
  sender_account    uuid NOT NULL REFERENCES accounts(id),
  recipient_account uuid NOT NULL REFERENCES accounts(id),
  body_enc          bytea NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NOT NULL
);

-- Delivery reads by (recipient, channel) oldest first; the sweep reads by
-- expiry. Nothing indexes the sender, because nothing looks a sender up.
CREATE INDEX IF NOT EXISTS channel_messages_delivery_idx
  ON channel_messages (recipient_account, channel_id, created_at);
CREATE INDEX IF NOT EXISTS channel_messages_expiry_idx
  ON channel_messages (expires_at);

-- ---------------------------------------------------------------------------
-- Sending rate, held as a tally and nothing else.
--
-- The obvious way to rate-limit would be to count recent rows in
-- channel_messages, but delivery deletes those, so a fast reader would hand
-- the sender an unlimited allowance. This table keeps one row per side per
-- channel per clock hour carrying a COUNT: no message times, no message ids,
-- no content. It is a fixed window rather than a sliding one, so a burst
-- straddling the hour boundary can reach twice the allowance before settling
-- back; the aim is blunting floods rather than exact accounting. The sweep
-- deletes windows older than two hours.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS channel_send_rate (
  channel_id     text NOT NULL,
  sender_account uuid NOT NULL REFERENCES accounts(id),
  window_start   timestamptz NOT NULL,
  n              integer NOT NULL DEFAULT 0,
  PRIMARY KEY (channel_id, sender_account, window_start)
);
CREATE INDEX IF NOT EXISTS channel_send_rate_window_idx
  ON channel_send_rate (window_start);
