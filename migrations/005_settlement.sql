-- OpenSwitchboard safe-hands escrow core (phase 1.A)

-- ---------------------------------------------------------------------------
-- Seller payment identity. The Stripe connected-account id is envelope-
-- encrypted with the account's own data key, like every other identity
-- field. There is no plaintext column and no index on it.
-- ---------------------------------------------------------------------------
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS stripe_account_id_enc bytea,
  ADD COLUMN IF NOT EXISTS stripe_account_created_at timestamptz;

-- Approval links learn the settlement action.
ALTER TABLE approval_links DROP CONSTRAINT IF EXISTS approval_links_action_check;
ALTER TABLE approval_links ADD CONSTRAINT approval_links_action_check
  CHECK (action IN ('offer-accept','stage3-disclosure','settlement-approve'));

-- ---------------------------------------------------------------------------
-- Settlements. State machine (schemas/settlement.json):
--   proposed -> approved-by-buyer / approved-by-seller -> approved
--            -> funded -> evidence-locked -> confirmed -> released
--                                         -> disputed  -> refunded
--   either human may decline while unfunded; declined/released/refunded are
--   TERMINAL. Every transition out of 'proposed' happens ONLY from a signed
--   human action on the approval page or from a verified Stripe webhook
--   event (asserted structurally in domain/settlements.ts and its tests).
-- Buyer = the WANT side's human (pays); seller = the HAVE side's human.
-- Stripe object ids are operational references (not identity data): the
-- PaymentIntent/Checkout ids are meaningless outside our own Stripe account.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS settlements (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id                 uuid NOT NULL REFERENCES matches(id),
  proposer_account         uuid NOT NULL REFERENCES accounts(id),
  buyer_account            uuid NOT NULL REFERENCES accounts(id),
  seller_account           uuid NOT NULL REFERENCES accounts(id),
  amount                   numeric NOT NULL CHECK (amount > 0),
  ccy                      text NOT NULL,
  description              jsonb,
  state                    text NOT NULL DEFAULT 'proposed' CHECK (state IN (
    'proposed','approved-by-buyer','approved-by-seller','approved','funded',
    'evidence-locked','confirmed','disputed','released','refunded','declined')),
  fee_amount_minor         integer NOT NULL DEFAULT 0,
  buyer_approved_at        timestamptz,
  seller_approved_at       timestamptz,
  stripe_checkout_session  text,
  stripe_payment_intent    text,
  evidence_manifest_key    text,
  funded_at                timestamptz,
  evidence_locked_at       timestamptz,
  confirmed_at             timestamptz,
  disputed_at              timestamptz,
  released_at              timestamptz,
  refunded_at              timestamptz,
  declined_at              timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS settlements_match_idx ON settlements (match_id, created_at);
CREATE INDEX IF NOT EXISTS settlements_buyer_idx ON settlements (buyer_account, created_at);
CREATE INDEX IF NOT EXISTS settlements_seller_idx ON settlements (seller_account, created_at);
CREATE INDEX IF NOT EXISTS settlements_pi_idx ON settlements (stripe_payment_intent);

-- Evidence objects (photos) uploaded from the approval page; the manifest
-- snapshot at evidence-lock lists these keys + hashes in the WORM bucket.
CREATE TABLE IF NOT EXISTS settlement_evidence (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  settlement_id uuid NOT NULL REFERENCES settlements(id),
  s3_key        text NOT NULL UNIQUE,
  content_type  text NOT NULL,
  size_bytes    bigint,
  sha256        text,
  uploaded_by   uuid NOT NULL REFERENCES accounts(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS settlement_evidence_settlement_idx
  ON settlement_evidence (settlement_id, created_at);

-- Stripe webhook idempotency: one row per processed event id. The INSERT is
-- the lock (ON CONFLICT DO NOTHING), so a redelivered event never re-runs a
-- transition.
CREATE TABLE IF NOT EXISTS stripe_events (
  event_id     text PRIMARY KEY,
  event_type   text NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now()
);
