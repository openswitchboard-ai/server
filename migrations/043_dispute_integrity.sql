-- The last batch of the 2026-09 security audit, in one migration.
--
-- Everything below is a column or an index that closes a hole the audit found.
-- They are grouped by the finding they belong to so a reader can follow which
-- code change each one is holding up.

-- --------------------------------------------------------------------------
-- 1. Settlement dispute integrity.
--
-- Adding delivery tracking used to rewrite dispute_ground: a 'not_arrived'
-- dispute quietly became 'not_as_described' the moment the seller typed a
-- reference in. That let one party edit the other party's account of what went
-- wrong, and it erased the buyer's own words from the row the vault record was
-- supposed to be the frozen copy of. The ground is now immutable once set, and
-- the fact the seller wants recorded — that tracking arrived, and when — gets
-- its own column instead.
--
-- Tracking still takes the settlement out of the never-arrived automatic
-- refund, but by being present rather than by rewriting anything: both records
-- then stand, neither wins on its own, and the two of them have the agreement
-- road or the fourteen-day rule.
ALTER TABLE settlements
  ADD COLUMN IF NOT EXISTS tracking_added_at timestamptz;

-- The seller's answer to a return: "that is not what I got back", or "nothing
-- came back at all". A return the seller disputes stops the return-silence
-- clock — silence is no longer the seller saying nothing, because they said
-- something — and stops the return record outranking delivery tracking under
-- the default rule. It decides nothing by itself; it makes the two records
-- contested, which is what the agreement road and the fourteen-day rule are
-- for.
ALTER TABLE settlements
  ADD COLUMN IF NOT EXISTS return_disputed_at timestamptz;

-- --------------------------------------------------------------------------
-- 2. The locks the reads were standing in for.
--
-- Every one of these is the same defect: a SELECT that asked whether something
-- was allowed, and an INSERT or UPDATE some distance later that did it. Two
-- callers arriving together both read the board as it was before either of
-- them, both passed, and both wrote. The reads stay — they are what gives a
-- person a sentence they can act on — and the rail moves into the database.

-- One live settlement per introduction. A second proposal while one is in
-- flight would put a second charge in front of the same buyer.
CREATE UNIQUE INDEX IF NOT EXISTS settlements_one_live
  ON settlements (match_id)
  WHERE state NOT IN ('released','refunded','settled-split','declined');

-- One settlement per payment. The funding webhook writes the payment
-- reference; two funding events for the same settlement, or a reference
-- written twice, would leave two rows claiming the same money.
CREATE UNIQUE INDEX IF NOT EXISTS settlements_one_payment
  ON settlements (stripe_payment_intent)
  WHERE stripe_payment_intent IS NOT NULL;

-- Best offer: one number each, and now it is the database saying so.
--
-- A sealed round is marked on the offer itself rather than inferred from the
-- have's sale mode, because the mode can change and a window closes: what this
-- index is about is the numbers that were put in UNDER a sealed window, and
-- that is a fact about the row.
ALTER TABLE offers
  ADD COLUMN IF NOT EXISTS best_offer boolean NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS offers_one_best_offer
  ON offers (match_id, proposer_account)
  WHERE best_offer;

-- --------------------------------------------------------------------------
-- 3. Email abuse.
--
-- Every suppression the switchboard had lived on an accounts row, so a hard
-- bounce or a complaint from an address with no account behind it was logged
-- and then forgotten: the registration door would mail that address again on
-- the next attempt, and again. The bounce rate that decides whether the
-- switchboard can send mail at all is counted per sending domain rather than
-- per account, so an address nobody typed twice is still an address that costs
-- everybody.
--
-- The list is keyed on the same hash of the address the rest of the schema
-- uses, so it holds no addresses; the reason is the event type that put it
-- there, and a row is never overwritten — the first thing that went wrong is
-- the one on record. Re-verification is the one send that still goes out to a
-- suppressed address, because it is the only way back off the list.
CREATE TABLE IF NOT EXISTS email_suppressions (
  email_hash text PRIMARY KEY,
  reason     text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- --------------------------------------------------------------------------
-- 4. The address hash gets a pepper.
--
-- email_hash was a bare SHA-256 of the lowercased address, and a bare SHA-256
-- of an email address is not a one-way function in any sense that matters: the
-- plausible space is a few billion real addresses, and the leaked-credential
-- corpora everybody already has are lists of exactly those. Anyone holding a
-- copy of these columns could put a name to every row in an afternoon. Three
-- tables key on it — who has an account, whose account was stopped, whose
-- address bounced or complained — which is a membership list, a moderation
-- record and a deliverability record, readable with nothing but the database.
--
-- v2 is HMAC-SHA256 under a pepper derived with HKDF from the counter's
-- existing link HMAC key (info 'email-hash-pepper-v1'), so no new secret is
-- needed and the pepper never touches a row. The old hashes cannot be
-- recomputed from themselves, so the two live side by side: new writes carry
-- v2, every lookup asks v2 first and takes v1 as the fallback.
--
-- ON ACCOUNTS this is temporary. scripts/ops/rehash-emails.mts fills v2 from
-- the encrypted address each account already holds; once it has run over the
-- whole table a later migration drops email_hash there.
--
-- ON SUSPENDED_EMAILS it is permanent. There is no plaintext behind those rows
-- — the account may be long gone — so v1 can never be rehashed away, and the
-- check stays "either spelling".
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS email_hash_v2 text;
CREATE UNIQUE INDEX IF NOT EXISTS accounts_email_hash_v2
  ON accounts (email_hash_v2) WHERE email_hash_v2 IS NOT NULL;

ALTER TABLE suspended_emails
  ADD COLUMN IF NOT EXISTS email_hash_v2 text;
CREATE INDEX IF NOT EXISTS suspended_emails_hash_v2
  ON suspended_emails (email_hash_v2) WHERE email_hash_v2 IS NOT NULL;

-- --------------------------------------------------------------------------
-- 5. The sweep's retries, and a chargeback.
--
-- The settlement sweep retried a failed transfer on every pass, hourly, for
-- ever. A seller whose Stripe account cannot take the money — closed,
-- restricted, in a country the platform cannot pay — is not a transient
-- failure, and hammering it hourly until the heat death of the universe is not
-- a retry policy: it hides the settlements that are genuinely stuck in a log
-- line that looks the same on pass one and pass four hundred.
--
-- Exponential backoff, doubling from an hour and capped at a day, and after
-- ten attempts the sweep stops and says so with a count an operator can see.
-- Nothing is decided by giving up: the money is still held and the settlement
-- is still 'confirmed'. What changes is that somebody is told.
ALTER TABLE settlements
  ADD COLUMN IF NOT EXISTS transfer_attempts        int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_transfer_attempt_at timestamptz;

-- The buyer went to their card issuer instead. Recorded, and nothing else: the
-- switchboard moves no money on a chargeback. Whether a dispute at the issuer
-- succeeds is between the buyer, their bank and us, and it happens on a clock
-- nobody here controls; what this column buys is that a settlement which has
-- had a chargeback raised against it says so on the row, in the operator's
-- view, and in the warn line the webhook writes.
ALTER TABLE settlements
  ADD COLUMN IF NOT EXISTS chargeback_at timestamptz;
