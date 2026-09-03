-- Waiting-message nudge state (phase 1.x)
--
-- channel_send writes an encrypted message and lets it go; nothing tells the
-- RECIPIENT's human that something is waiting, so a passive human (or a chatbot
-- that only checks when asked) leaves the message sitting until the sweep
-- deletes it, and both sides end up waiting on each other. This table drives a
-- best-effort email nudge — "you have a message waiting; open your assistant"
-- — with a throttle so a conversation never turns into one email per line.
--
-- One row per (channel, recipient). It holds NO message content and never can:
-- an id, a timestamp, and a boolean is the whole of it. The throttle rule
-- (documented in domain/channelNotify.ts) is:
--
--   * unread_notified = true  while a nudge has gone out that the recipient has
--     not yet cleared by collecting. A further message in that state sends no
--     second nudge (one nudge per "you have unread mail here" state).
--   * channel_receive re-arms the row (unread_notified -> false) once the
--     recipient collects and their unread falls to zero, so the NEXT arrival is
--     eligible for a fresh nudge.
--   * last_notified_at is a floor: even across re-arms, at most one nudge per
--     recipient per channel per NUDGE_FLOOR_MINUTES. This is what keeps a rapid
--     back-and-forth where both humans are actively reading down to the
--     occasional nudge rather than one per message.
--
-- A message is nudged only when BOTH gates are open: not already unread-
-- notified, AND past the floor. The whole path is best-effort — a failure here
-- never fails the send.
CREATE TABLE IF NOT EXISTS channel_notify (
  channel_id        text NOT NULL,
  recipient_account uuid NOT NULL REFERENCES accounts(id),
  -- When the last "message waiting" nudge was enqueued for this recipient on
  -- this channel. Doubles as the per-unread-state key for the email dedupe.
  last_notified_at  timestamptz NOT NULL DEFAULT now(),
  -- True while an enqueued nudge has not yet been cleared by a collect-to-zero.
  unread_notified   boolean NOT NULL DEFAULT true,
  PRIMARY KEY (channel_id, recipient_account)
);
