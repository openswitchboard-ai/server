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
