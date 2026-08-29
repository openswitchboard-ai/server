-- OpenSwitchboard core schema (phase 0.C)
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- Accounts. Identity fields (email, first name, locality) are envelope-
-- encrypted with a per-account data key wrapped by the env's KMS identity key.
-- email_hash (sha256) is the lookup key so plaintext email never sits in an
-- index. login_code_hash is the 0.C dev-bootstrap credential (scrypt, hashed
-- client-side by the bootstrap CLI); 0.D replaces this with the counter's
-- registration/PIN/passkey.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS accounts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email_hash     text NOT NULL UNIQUE,
  email_enc      bytea NOT NULL,
  first_name_enc bytea NOT NULL,
  locality_enc   bytea NOT NULL,
  login_code_hash text,
  data_key_enc   bytea NOT NULL,          -- KMS-wrapped per-account data key
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Reputation stub (0.C): filled in by later phases.
CREATE TABLE IF NOT EXISTS reputation (
  account_id   uuid PRIMARY KEY REFERENCES accounts(id),
  score        real NOT NULL DEFAULT 0.5,
  signal_count integer NOT NULL DEFAULT 0,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- OAuth 2.1 (authorization-code + PKCE, dynamic client registration,
-- refresh tokens). Tokens are opaque; only sha256 hashes are stored.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_name   text NOT NULL,
  redirect_uris jsonb NOT NULL,
  token_endpoint_auth_method text NOT NULL DEFAULT 'none',
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS oauth_codes (
  code_hash      text PRIMARY KEY,
  client_id      uuid NOT NULL REFERENCES oauth_clients(client_id),
  account_id     uuid NOT NULL REFERENCES accounts(id),
  redirect_uri   text NOT NULL,
  code_challenge text NOT NULL,           -- PKCE S256, mandatory
  scope          text NOT NULL DEFAULT 'switchboard',
  resource       text,
  expires_at     timestamptz NOT NULL,
  used           boolean NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  token_hash   text PRIMARY KEY,
  kind         text NOT NULL CHECK (kind IN ('access','refresh')),
  account_id   uuid NOT NULL REFERENCES accounts(id),
  client_id    uuid NOT NULL REFERENCES oauth_clients(client_id),
  scope        text NOT NULL DEFAULT 'switchboard',
  expires_at   timestamptz NOT NULL,
  revoked      boolean NOT NULL DEFAULT false,
  rotated_from text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS oauth_tokens_account_idx ON oauth_tokens (account_id);

-- ---------------------------------------------------------------------------
-- Intent cards. The disclosable projection lives in plaintext columns; the
-- PRIVATE price band (budget ceiling / reserve floor) is envelope-encrypted
-- and never leaves the matching engine. lifecycle_state is the server state
-- machine; protocol_status is the card's protocol-level active|latent flag.
-- screening jsonb holds the internal screening verdict (reason logged, never
-- disclosed to a counterparty beyond the SCREENING_REJECTED error code).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cards (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES accounts(id),
  schema_version  text NOT NULL,
  type            text NOT NULL CHECK (type IN ('WANT','HAVE')),
  category        text NOT NULL,
  geo             jsonb NOT NULL,
  attributes      jsonb NOT NULL DEFAULT '{}'::jsonb,
  ask             jsonb,
  urgency         text NOT NULL DEFAULT 'none',
  visibility      text NOT NULL DEFAULT 'anonymous-until-match',
  protocol_status text NOT NULL DEFAULT 'active' CHECK (protocol_status IN ('active','latent')),
  lifecycle_state text NOT NULL DEFAULT 'PENDING_SCREENING'
    CHECK (lifecycle_state IN ('PENDING_SCREENING','SCREENING_REJECTED','PUBLISHED','WITHDRAWN','EXPIRED')),
  price_enc       bytea,                  -- encrypted matching input; NEVER disclosed
  embedding       vector(1024),           -- populated by the 0.F matching engine
  ttl_days        integer NOT NULL DEFAULT 60,
  expires_at      timestamptz NOT NULL,
  screening       jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cards_account_idx ON cards (account_id);
CREATE INDEX IF NOT EXISTS cards_category_idx ON cards (category) WHERE lifecycle_state = 'PUBLISHED';

-- ---------------------------------------------------------------------------
-- Matches + the disclosure-stage state machine.
-- stage: 1 signal -> 2 attributes -> 3 mutual -> 4 channel open.
-- Per-side booleans record stage-1 interest; stage-3 requires BOTH sides'
-- opt-in tokens in consent_tokens (the gate is a query, not a flag).
-- state: open | declined | closed. Declines carry NO reason (anti-probing).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS matches (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  card_want     uuid NOT NULL REFERENCES cards(id),
  card_have     uuid NOT NULL REFERENCES cards(id),
  account_want  uuid NOT NULL REFERENCES accounts(id),
  account_have  uuid NOT NULL REFERENCES accounts(id),
  score         real NOT NULL,
  category      text NOT NULL,
  stage         integer NOT NULL DEFAULT 1 CHECK (stage BETWEEN 1 AND 4),
  interest_want boolean NOT NULL DEFAULT false,
  interest_have boolean NOT NULL DEFAULT false,
  state         text NOT NULL DEFAULT 'open' CHECK (state IN ('open','declined','closed')),
  channel_id    text,
  opened_at     timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (card_want, card_have)
);
CREATE INDEX IF NOT EXISTS matches_account_want_idx ON matches (account_want);
CREATE INDEX IF NOT EXISTS matches_account_have_idx ON matches (account_have);

-- Consent / opt-in tokens. One row per human per consent kind per match.
-- recorded_via records the interface that captured the consent.
CREATE TABLE IF NOT EXISTS consent_tokens (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id     uuid NOT NULL REFERENCES matches(id),
  account_id   uuid NOT NULL REFERENCES accounts(id),
  kind         text NOT NULL CHECK (kind IN ('stage3-optin','offer-accept')),
  recorded_via text NOT NULL,
  recorded_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (match_id, account_id, kind)
);

-- ---------------------------------------------------------------------------
-- Offers. Protocol state machine (schemas/offer.json):
--   proposed -> awaiting-human -> accepted-by-human | declined
--   proposed -> withdrawn
-- 'accepted-by-human' is set ONLY by the internal (no public route) human-
-- acceptance interface; no agent-reachable API can produce it.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS offers (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id         uuid NOT NULL REFERENCES matches(id),
  proposer_account uuid NOT NULL REFERENCES accounts(id),
  amount           numeric NOT NULL CHECK (amount > 0),
  ccy              text NOT NULL,
  expiry           timestamptz NOT NULL,
  state            text NOT NULL DEFAULT 'proposed'
    CHECK (state IN ('proposed','awaiting-human','accepted-by-human','declined','withdrawn')),
  message          jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS offers_match_idx ON offers (match_id);
CREATE INDEX IF NOT EXISTS offers_proposer_created_idx ON offers (proposer_account, created_at);

-- Publish-quota bookkeeping (publishes per rolling day counted from events).
CREATE TABLE IF NOT EXISTS publish_events (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id),
  card_id    uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS publish_events_idx ON publish_events (account_id, created_at);
