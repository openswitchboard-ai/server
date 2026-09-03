-- The number an agent brought back from a refusal (phase 1.E follow-on)
--
-- On a card set to "Pass on" — the default — respond(propose_offer) is refused
-- outright with CONSENT_REQUIRED and the human's own link, and until now the
-- figure the agent was carrying died with the refusal. The human then arrived
-- at an empty box and had to be told the number a second time, by their agent,
-- in the chat they had just left.
--
-- So the refused figure is parked here for a day, tied to the match and the
-- account it belongs to, and the human's own offer box opens prefilled with
-- it under one line: "Your agent brought this number from you — check it and
-- send." Nothing is sent, nothing is agreed, and the ordinary offer machinery
-- still runs on submit. The draft is cleared the moment they send one.
--
-- WHY THIS IS PLAINTEXT WHILE A MANDATE IS NOT. A mandate is a reservation
-- price: the one figure whose whole value is that the other side never learns
-- it (see migrations/010_negotiation.sql). A draft is the opposite — it is a
-- number that is about to be published to a counterparty as an offer, one tap
-- from now, by the person it belongs to. Encrypting it would buy nothing and
-- would put a decrypt-audit line on every page view.
--
-- It carries no lifetime of its own beyond the day: a stale draft is a stale
-- price, and a person coming back next week should meet an empty box rather
-- than last week's figure.
CREATE TABLE IF NOT EXISTS offer_drafts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES accounts(id),
  match_id    uuid NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  amount      numeric(14,2) NOT NULL CHECK (amount > 0),
  ccy         text NOT NULL CHECK (ccy ~ '^[A-Z]{3}$'),
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL
);

-- The only read: the newest live draft for one account on one match.
CREATE INDEX IF NOT EXISTS offer_drafts_newest_idx
  ON offer_drafts (account_id, match_id, created_at DESC);

-- The sweep that clears expired rows scans on this.
CREATE INDEX IF NOT EXISTS offer_drafts_expiry_idx ON offer_drafts (expires_at);
