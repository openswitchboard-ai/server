-- Settlements move money as separate charges and transfers.
--
-- The buyer's payment is captured into the platform's own Stripe balance
-- (stripe_payment_intent, already here since 005). Releasing is a Transfer of
-- amount - fee to the seller's connected account, and that transfer is the
-- object the 'released' state is recorded from, so it needs a home.
--
-- The 11-state machine is unchanged. Stripe object ids stay operational
-- references, not identity data: they are meaningless outside our own Stripe
-- account and never go on the wire.
ALTER TABLE settlements
  ADD COLUMN IF NOT EXISTS stripe_transfer_id text;

-- The transfer.created webhook finds its settlement by transfer_group (the
-- settlement id), so this index is for reconciliation and for the refund path
-- checking whether a release already went out.
CREATE INDEX IF NOT EXISTS settlements_transfer_idx
  ON settlements (stripe_transfer_id) WHERE stripe_transfer_id IS NOT NULL;
