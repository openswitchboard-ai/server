-- A dispute freezes the payment; three roads lead out of it.
--
-- Until now 'disputed' meant "give the buyer everything back": the whole buyer
-- total went home, our fee and the processing line included, and the item
-- stayed exactly where it was. That is the right answer for a parcel that
-- never arrived and the wrong answer for everything else, and it is not what
-- the public terms say. A dispute now FREEZES the held amount and leaves the
-- two people room to sort it out.
--
-- THE THREE ROADS OUT, all of them moving the agreed amount and never a fee:
--   by agreement  either human proposes a split (refund_minor + release_minor,
--                 which always add up to the agreed amount); the settlement
--                 sits in 'resolution-proposed' until the other approves the
--                 same pair, then 'resolved' while the money moves, then
--                 'settled-split'.
--   by return     the buyer marks it sent back with return_tracking; the
--                 seller confirms receipt, or goes quiet for
--                 SETTLEMENT_RETURN_SILENCE_DAYS, and the agreed amount is
--                 refunded.
--   by the rule   at deadlock_at (disputed_at + SETTLEMENT_DISPUTE_DEADLOCK_DAYS)
--                 the default rule follows whichever side can show where the
--                 parcel went: delivery tracking and no return sent releases
--                 to the seller; a tracked return refunds the buyer; neither
--                 refunds the buyer.
--
-- deadlock_at is the live clock, the way auto_release_at is: it is set when the
-- dispute lands and NULLed the moment the dispute ends, whichever way it ended.
-- It is measured from disputed_at and never restarted — the terms say "after
-- fourteen days in dispute", so adding delivery tracking on day six leaves
-- eight days on the clock rather than winding it back to fourteen.
--
-- The other two clocks are derived rather than stored, because neither is a
-- live thing that has to be cleared: the seller's grace to add tracking is
-- disputed_at + SETTLEMENT_TRACKING_GRACE_DAYS, and the return silence is
-- returned_at + SETTLEMENT_RETURN_SILENCE_DAYS. Both fall out of a stamp that
-- is already a permanent record.

-- Three new states. 'settled-split' is terminal and is where EVERY resolution
-- by agreement ends, including one that sends the whole amount one way: the
-- terminal state then says how the settlement ended (the two of them agreed)
-- rather than merely which direction the money went, and 'released' keeps its
-- single meaning of "the buyer confirmed, or the clock did it for them".
ALTER TABLE settlements DROP CONSTRAINT IF EXISTS settlements_state_check;
ALTER TABLE settlements ADD CONSTRAINT settlements_state_check CHECK (state IN (
  'proposed','approved-by-buyer','approved-by-seller','approved','funded',
  'evidence-locked','confirmed','disputed','resolution-proposed','resolved',
  'released','refunded','settled-split','declined'));

ALTER TABLE settlements
  -- Why the payment was frozen, chosen by the human who froze it. An in-person
  -- handover has nowhere for a parcel to go astray, so it disputes as
  -- 'not_as_described'. A 'not_arrived' ground becomes 'not_as_described' the
  -- moment the seller adds delivery tracking.
  ADD COLUMN IF NOT EXISTS dispute_ground   text,
  ADD COLUMN IF NOT EXISTS disputed_by      uuid REFERENCES accounts(id),
  -- The live clock on a dispute; NULL on every settlement that is not in one.
  ADD COLUMN IF NOT EXISTS deadlock_at      timestamptz,
  -- What each side can show about where the parcel went. Free text typed by a
  -- human; it is a record, never a lookup, and the switchboard never calls a
  -- courier about it.
  ADD COLUMN IF NOT EXISTS delivery_tracking  text,
  ADD COLUMN IF NOT EXISTS return_tracking    text,
  ADD COLUMN IF NOT EXISTS returned_at        timestamptz,
  ADD COLUMN IF NOT EXISTS return_received_at timestamptz,
  -- The two figures. While a split is on the table these are the proposal;
  -- once anything moves they are the record of what moved. They always add up
  -- to the agreed amount, and neither has ever included a fee.
  ADD COLUMN IF NOT EXISTS refund_minor     integer,
  ADD COLUMN IF NOT EXISTS release_minor    integer,
  ADD COLUMN IF NOT EXISTS split_proposed_by        uuid REFERENCES accounts(id),
  ADD COLUMN IF NOT EXISTS split_buyer_approved_at  timestamptz,
  ADD COLUMN IF NOT EXISTS split_seller_approved_at timestamptz,
  -- The refund object, the way stripe_transfer_id already records the transfer.
  ADD COLUMN IF NOT EXISTS stripe_refund_id text,
  -- Each leg of a split, stamped when the provider's verified event reports it.
  -- 'settled-split' lands when every leg that had money in it is stamped.
  ADD COLUMN IF NOT EXISTS refund_leg_at    timestamptz,
  ADD COLUMN IF NOT EXISTS release_leg_at   timestamptz,
  ADD COLUMN IF NOT EXISTS resolution_proposed_at timestamptz,
  ADD COLUMN IF NOT EXISTS resolved_at            timestamptz,
  ADD COLUMN IF NOT EXISTS settled_split_at       timestamptz;

ALTER TABLE settlements DROP CONSTRAINT IF EXISTS settlements_dispute_ground_check;
ALTER TABLE settlements ADD CONSTRAINT settlements_dispute_ground_check
  CHECK (dispute_ground IS NULL OR dispute_ground IN ('not_arrived','not_as_described'));

-- Neither figure is ever negative, and neither is ever a fee.
ALTER TABLE settlements DROP CONSTRAINT IF EXISTS settlements_split_nonneg_check;
ALTER TABLE settlements ADD CONSTRAINT settlements_split_nonneg_check
  CHECK ((refund_minor IS NULL OR refund_minor >= 0)
     AND (release_minor IS NULL OR release_minor >= 0));

-- The deadlock sweep's whole working set. Partial, because a dispute is rare
-- and the index should stay tiny — the same shape as the auto-release index.
CREATE INDEX IF NOT EXISTS settlements_deadlock_due_idx
  ON settlements (deadlock_at)
  WHERE deadlock_at IS NOT NULL;

-- The return-silence sweep: a return marked and no receipt confirmed.
CREATE INDEX IF NOT EXISTS settlements_return_pending_idx
  ON settlements (returned_at)
  WHERE returned_at IS NOT NULL AND return_received_at IS NULL;
