-- The buyer's window to confirm or dispute after the seller hands over.
--
-- Until now a held payment waited in 'evidence-locked' for the buyer to
-- confirm receipt, and a buyer who went quiet left the seller's money parked
-- with nobody able to move it. The seller's existing step — freezing the
-- handover evidence — is now read for what it always was, a declaration that
-- the thing changed hands, and it starts a clock:
--
--   handed_over_at   when the seller declared the handover;
--   auto_release_at  handed_over_at + SETTLEMENT_AUTO_RELEASE_DAYS, the moment
--                    the held payment goes to the seller on its own.
--
-- auto_release_at is the live clock and nothing else: it is NULL on every
-- settlement whose window has ended, whichever way it ended. Confirming
-- clears it, disputing clears it, and the sweep clears it as it releases.
-- handed_over_at is the record and stays put.
--
-- The 11-state machine is unchanged. 'evidence-locked' is still the state
-- name; the clock hangs off it.
ALTER TABLE settlements
  ADD COLUMN IF NOT EXISTS handed_over_at  timestamptz,
  ADD COLUMN IF NOT EXISTS auto_release_at timestamptz,
  -- Which road this settlement took to 'confirmed': 'buyer-confirm' when the
  -- buyer pressed it, 'auto-release' when the window ran out. Both are
  -- written by the one state writer in domain/settlements.ts.
  ADD COLUMN IF NOT EXISTS confirmed_via   text,
  ADD COLUMN IF NOT EXISTS auto_released   boolean NOT NULL DEFAULT false;

-- The sweep's whole working set: settlements whose clock has run out. Partial,
-- because a live clock is a rare state and the index should stay tiny.
CREATE INDEX IF NOT EXISTS settlements_auto_release_due_idx
  ON settlements (auto_release_at)
  WHERE auto_release_at IS NOT NULL;
