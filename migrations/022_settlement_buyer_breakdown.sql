-- The settlement fee is buyer-paid and itemised.
--
-- The buyer's Checkout page shows three lines: the agreed amount, our flat
-- introductory fee, and card processing at Stripe's standard rate, grossed up
-- so the first two arrive whole. fee_amount_minor already holds our fee; the
-- other two lines get columns of their own, written when the Checkout Session
-- is created, so the webhook can check the payment against the exact figure
-- the buyer was shown rather than recomputing it from config that may have
-- moved since.
--
-- The seller receives the agreed amount in full: the release transfer is
-- settlements.amount exactly, and nothing here changes that.
ALTER TABLE settlements
  ADD COLUMN IF NOT EXISTS processing_fee_minor integer,
  ADD COLUMN IF NOT EXISTS buyer_total_minor integer;
