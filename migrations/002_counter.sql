-- OpenSwitchboard counter + identity spine (phase 0.D)

-- ---------------------------------------------------------------------------
-- Accounts grow the counter identity spine: PIN (argon2id), lockout state,
-- blind mode (0.E consumes), kill switch, 18+ / consent timestamps.
-- 'pending' status covers a registration between email verification and the
-- consent step ("account live").
-- ---------------------------------------------------------------------------
ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_status_check;
ALTER TABLE accounts ADD CONSTRAINT accounts_status_check
  CHECK (status IN ('pending','active','suspended'));
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS pin_hash            text,
  ADD COLUMN IF NOT EXISTS pin_set_at          timestamptz,
  ADD COLUMN IF NOT EXISTS pin_failed_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pin_locked_until    timestamptz,
  ADD COLUMN IF NOT EXISTS blind_mode          boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS kill_switch_at      timestamptz,
  ADD COLUMN IF NOT EXISTS adult_asserted_at   timestamptz,
  ADD COLUMN IF NOT EXISTS consented_at        timestamptz;

-- Kill switch: tokens are SUSPENDED (reversible), distinct from revoked.
ALTER TABLE oauth_tokens ADD COLUMN IF NOT EXISTS suspended boolean NOT NULL DEFAULT false;

-- Kill switch: cards paused by the switch are restored on un-pause; cards the
-- human had already set latent themselves are left alone.
ALTER TABLE cards ADD COLUMN IF NOT EXISTS paused_by_kill_switch boolean NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------------
-- Email verifications: 6-digit code + link token, single-use, 15-min TTL.
-- The email itself is KMS-encrypted (no per-account data key exists yet at
-- registration time); email_hash is the lookup key.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_verifications (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email_hash      text NOT NULL,
  email_kms_enc   bytea NOT NULL,
  purpose         text NOT NULL CHECK (purpose IN ('register','login')),
  code_hash       text NOT NULL,           -- sha256(code || id) — never plaintext
  link_token_hash text NOT NULL UNIQUE,    -- sha256 of the emailed link token
  attempts        integer NOT NULL DEFAULT 0,
  used            boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS email_verifications_hash_idx ON email_verifications (email_hash, created_at);

-- ---------------------------------------------------------------------------
-- Counter sessions: the HUMAN route class's own credential. Cookie value is
-- opaque; only its sha256 is stored. pin_ok_until marks PIN/passkey-elevated
-- windows for sensitive actions. oauth_ctx carries a pending agent-authorize
-- request through login. webauthn_challenge is the per-session ceremony state.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS counter_sessions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sid_hash           text NOT NULL UNIQUE,
  account_id         uuid REFERENCES accounts(id),
  pin_ok_until       timestamptz,
  webauthn_challenge text,
  webauthn_challenge_expires timestamptz,
  oauth_ctx          jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS counter_sessions_account_idx ON counter_sessions (account_id);

-- ---------------------------------------------------------------------------
-- WebAuthn (passkey) credentials.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS webauthn_credentials (
  credential_id text PRIMARY KEY,          -- base64url
  account_id    uuid NOT NULL REFERENCES accounts(id),
  public_key    bytea NOT NULL,
  sign_count    bigint NOT NULL DEFAULT 0,
  transports    jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS webauthn_credentials_account_idx ON webauthn_credentials (account_id);

-- ---------------------------------------------------------------------------
-- Approval links: single-use, 15-min TTL, HMAC-signed, bound to
-- {account, action, amount, counterparty}. Only the token hash is stored;
-- the HMAC key lives in Secrets Manager and the signature covers the bound
-- fields, so a tampered or re-pointed link cannot verify.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS approval_links (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash           text NOT NULL UNIQUE,
  account_id           uuid NOT NULL REFERENCES accounts(id),
  action               text NOT NULL CHECK (action IN ('offer-accept','stage3-disclosure')),
  ref_id               uuid NOT NULL,       -- offer id / match id
  amount               numeric,
  ccy                  text,
  counterparty_account uuid NOT NULL REFERENCES accounts(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  expires_at           timestamptz NOT NULL,
  used_at              timestamptz,
  decision             text CHECK (decision IN ('approved','declined'))
);
CREATE INDEX IF NOT EXISTS approval_links_account_idx ON approval_links (account_id, created_at);
