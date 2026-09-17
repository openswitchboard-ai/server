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
