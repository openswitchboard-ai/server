-- OpenSwitchboard email daemon (phase 0.E)

-- ---------------------------------------------------------------------------
-- Per-account email frequency controls. Two non-transactional categories:
--   matches  (the match summons)          default: immediate
--   digests  (activity digest + renewal cadence emails ride the digest engine)
--                                         default: weekly
-- Transactional mail (verification, approval, kill switch, security notices)
-- always sends and has no frequency knob.
-- Suppression state:
--   email_unreachable_at          set on a PERMANENT bounce; every send to the
--                                 account is withheld until the address is
--                                 re-verified at the counter (transactional
--                                 re-verification mail is the one exception).
--   email_complaint_suppressed_at set on a spam complaint; ALL non-
--                                 transactional mail is withheld until the
--                                 human re-enables it from the counter.
-- Digest bookkeeping stamps live here too (one row per account, no join).
-- ---------------------------------------------------------------------------
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS email_freq_matches text NOT NULL DEFAULT 'immediate'
    CHECK (email_freq_matches IN ('immediate','daily','weekly','off')),
  ADD COLUMN IF NOT EXISTS email_freq_digests text NOT NULL DEFAULT 'weekly'
    CHECK (email_freq_digests IN ('immediate','daily','weekly','off')),
  ADD COLUMN IF NOT EXISTS email_unreachable_at          timestamptz,
  ADD COLUMN IF NOT EXISTS email_complaint_suppressed_at timestamptz,
  ADD COLUMN IF NOT EXISTS email_last_digest_at          timestamptz,
  ADD COLUMN IF NOT EXISTS email_last_summons_batch_at   timestamptz;

-- Renewal scheduler: stamped when a card has been included in a "still true?"
-- renewal email for its CURRENT expiry; cleared whenever expires_at moves.
ALTER TABLE cards ADD COLUMN IF NOT EXISTS renewal_notified_at timestamptz;

-- ---------------------------------------------------------------------------
-- Send log: one row per attempted email, keyed by an idempotency dedupe_key.
-- A send happens ONLY when the INSERT wins (ON CONFLICT DO NOTHING), so a
-- redelivered queue job can never double-send.
-- status: sent | sandbox-rejected (dev-only SES sandbox MessageRejected)
--       | suppressed (withheld by bounce/complaint suppression) | failed.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_sends (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dedupe_key     text NOT NULL UNIQUE,
  account_id     uuid REFERENCES accounts(id),
  email_hash     text NOT NULL,
  template       text NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('transactional','bulk')),
  subject        text NOT NULL,
  ses_message_id text,
  status         text NOT NULL CHECK (status IN ('sent','sandbox-rejected','suppressed','failed')),
  detail         text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS email_sends_account_idx ON email_sends (account_id, created_at);
CREATE INDEX IF NOT EXISTS email_sends_ses_msg_idx ON email_sends (ses_message_id);

-- ---------------------------------------------------------------------------
-- SES event log (bounce / complaint / delivery / reject), fed by the
-- configuration-set -> SNS -> SQS pipeline. Raw event retained.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type     text NOT NULL,
  ses_message_id text,
  account_id     uuid REFERENCES accounts(id),
  recipients     jsonb,
  raw            jsonb NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS email_events_msg_idx ON email_events (ses_message_id);
CREATE INDEX IF NOT EXISTS email_events_account_idx ON email_events (account_id, created_at);
