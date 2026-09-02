-- OpenSwitchboard per-card negotiation mode (phase 1.E)
--
-- The change this makes: an agent no longer invents a figure. Every number a
-- card carries into a negotiation comes from the human who owns it, and this
-- pair of columns is where the human says how.
--
--   negotiation_mode = 'relay'   ("Pass on", the default, including for every
--                                 card that already exists)
--     The agent may not propose an amount at all. respond(propose_offer) is
--     refused with CONSENT_REQUIRED and the human's own approval link; the
--     human types the figure on their approval page and the switchboard sends
--     it as their side's offer through the ordinary offer machinery.
--
--   negotiation_mode = 'mandate' ("Auto-negotiate", opt-in, per card)
--     The human writes a box on their own page — where to open, where to walk
--     away, and how big a move to make — and the agent may move inside it
--     without asking each time. Outside the box the server refuses, and the
--     refusal names the boundary to that human's OWN agent and to nobody else.
--
-- Both columns are set ONLY from /counter, the human-only page class. No agent
-- surface reads or writes them, and neither value nor anything derived from it
-- appears in a payload bound for a counterparty.
--
-- ---------------------------------------------------------------------------
-- WHY THE MANDATE IS ENCRYPTED AND THE MODE IS NOT.
--
-- A mandate is a reservation price wearing a different hat: "I will not go
-- below 400" is the same secret as the private band already held in
-- cards.price_enc, and it is held the same way — sealed under the account's
-- envelope key, so every read of it writes a line to the write-once decrypt
-- audit. Offers are rate-limited to a handful an hour, so the audit stays
-- meaningful rather than becoming noise.
--
-- The mode itself is not a secret about money; it is a fact about how this
-- human wants their agent to behave, read on every offer attempt and shown
-- plainly on their own pages. It sits in the clear, like the standing
-- arrangement (see migrations/009_arrangement.sql), and a NOT NULL DEFAULT
-- 'relay' is what makes hands-off negotiation something a person opts into
-- rather than something they discover they were in.
-- ---------------------------------------------------------------------------
ALTER TABLE cards
  ADD COLUMN IF NOT EXISTS negotiation_mode text NOT NULL DEFAULT 'relay',
  ADD COLUMN IF NOT EXISTS mandate_enc bytea,
  ADD COLUMN IF NOT EXISTS mandate_updated_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'cards_negotiation_mode_check'
  ) THEN
    ALTER TABLE cards
      ADD CONSTRAINT cards_negotiation_mode_check
      CHECK (negotiation_mode IN ('relay', 'mandate'));
  END IF;
END $$;

-- Offers carry who authored the number: 'human' for one typed on an approval
-- page, 'agent' for one an agent sent from inside a mandate. Own-side only —
-- the offer schema has no slot for it, so it never reaches a counterparty. The
-- default is 'agent' because that is what every offer written before this
-- migration was.
ALTER TABLE offers
  ADD COLUMN IF NOT EXISTS authored_by text NOT NULL DEFAULT 'agent';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'offers_authored_by_check'
  ) THEN
    ALTER TABLE offers
      ADD CONSTRAINT offers_authored_by_check
      CHECK (authored_by IN ('human', 'agent'));
  END IF;
END $$;
