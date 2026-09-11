-- One-question pages, and the links that reach them (phase 1.F)
--
-- The assistant does the talking and the carrying. Where a formality is
-- needed, the assistant asks the switchboard for its human's link and hands it
-- over in the chat; the link opens one page that asks one question and offers
-- two buttons. Three more actions join the two that already existed:
--
--   'offer-send'       — "Send $440 AUD to Sam for your mountain bike?"
--   'collection-close' — "Close the window on your mountain bike now?"
--   'negotiation-auto' — "Let your assistant negotiate between these numbers?"
--
-- Each link is still single-use, still 15 minutes, still HMAC-bound to the row
-- it was minted from. What is new is `payload`: the canonical JSON of the
-- figures the question is about (the amount and currency being sent, the
-- opening figure / limit / step being switched on). It is TEXT rather than
-- jsonb on purpose — the string that was signed is the string that is stored,
-- so verification never depends on how a JSON document round-trips.
--
-- A link for an action with no counterparty (closing your own window, setting
-- your own numbers) carries the account's own id in counterparty_account: the
-- column stays NOT NULL, and the binding stays exactly as tight.
ALTER TABLE approval_links DROP CONSTRAINT IF EXISTS approval_links_action_check;
ALTER TABLE approval_links ADD CONSTRAINT approval_links_action_check
  CHECK (action IN (
    'offer-accept',
    'stage3-disclosure',
    'settlement-approve',
    'offer-send',
    'collection-close',
    'negotiation-auto'
  ));

ALTER TABLE approval_links ADD COLUMN IF NOT EXISTS payload text;

-- ---------------------------------------------------------------------------
-- The onboarding question.
--
-- Right after the PIN, a first-time person is asked one page's worth of
-- things: how they will hear about the switchboard (which sets hears_via), and
-- the first name and rough area they would share. Both may be left blank.
--
-- `onboarded_at` is the stamp that says they have been past it once. Every
-- account that already exists is stamped here, so nobody who is already
-- running is sent back through a step they never had.
-- ---------------------------------------------------------------------------
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS onboarded_at timestamptz;
UPDATE accounts SET onboarded_at = COALESCE(created_at, now()) WHERE onboarded_at IS NULL;
