-- TRADES BETWEEN TWO LISTS, THINGS FOR THINGS (14 November 2026; the trades
-- design, phase P2; src/domain/trades.ts).
--
-- Two people whose lists meet both ways (migration 074, a pairing) could only
-- agree a trade in conversation, and nothing came off either list for it. Now
-- one of them puts a trade to the other: some of their own things, some of the
-- other person's, each with how many. Their assistant drafts it, and their
-- human sends it with their own press. The other human accepts it with theirs.
-- Only then does anything bind: the things come off both lists, and both of
-- them are sent the same record.
--
-- NO MONEY IN THIS VERSION (founder, 14 November 2026). The columns a top-up
-- of money would need are here and always empty, and a check keeps them
-- empty, so adding one later is a change to that check and to the code.
--
-- 1. THE PROPOSALS.
--
--   proposer_account   who put it, and recipient_account who it is put to:
--                      the two people of the pairing.
--   state              awaiting-send  drafted by the proposer's assistant,
--                                     waiting for the proposer's own press
--                      open           sent by that press; the other side may
--                                     accept it
--                      accepted       accepted by the other human's press
--                      declined       turned down by the other side
--                      withdrawn      taken back by the proposer
--                      superseded     a newer one was sent on the same pairing
--                      expired        its time ran out while it was open
--                      closed         something in it can no longer be met
--                                     (gone in another deal, taken down, or
--                                     the pairing ended); closed_because says
--                                     which
--   cash_amount,       a top-up of money, for later. Always null for now
--   cash_ccy,          (trade_proposals_no_cash_yet).
--   cash_from
--   note               the proposer's own words, stored as an offer note is:
--                      { text, provenance: 'counterparty-untrusted' }. Null
--                      once erased.
--   expiry             when it stops being open to accept (seven days at
--                      most).
--   sent_*             the proposer's own press on their own page.
--   accepted_*         the other human's press on theirs. A row can only say
--                      accepted with that press recorded through the counter,
--                      as migrations 061 and 066 hold for a figure and a line.
--   terms_sha256       the fingerprint of what the proposer pressed Send on:
--                      the things each way and the note, in the record's
--                      canonical form. It rides the sent consent event and
--                      the accepted one, so the two presses are tied to the
--                      same terms.
--   receipt_sha256     the fingerprint of the record both were sent.
--   supersedes         the open one this replaced when it was sent.
CREATE TABLE IF NOT EXISTS trade_proposals (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  pairing_id        uuid        NOT NULL REFERENCES pairings(id),
  proposer_account  uuid        NOT NULL REFERENCES accounts(id),
  recipient_account uuid        NOT NULL REFERENCES accounts(id),
  state             text        NOT NULL DEFAULT 'awaiting-send'
    CHECK (state IN ('awaiting-send', 'open', 'accepted', 'declined', 'withdrawn', 'superseded', 'expired', 'closed')),
  cash_amount       numeric,
  cash_ccy          text,
  cash_from         uuid        REFERENCES accounts(id),
  note              jsonb,
  expiry            timestamptz NOT NULL,
  sent_at           timestamptz,
  sent_via          text,
  accepted_at       timestamptz,
  accepted_by       uuid        REFERENCES accounts(id),
  accepted_via      text,
  terms_sha256      text,
  receipt_sha256    text,
  supersedes        uuid        REFERENCES trade_proposals(id),
  closed_because    text
    CHECK (closed_because IS NULL OR closed_because IN ('none_left', 'taken_down', 'pairing_ended')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT trade_proposals_two_people CHECK (proposer_account <> recipient_account),
  -- Money in a trade comes later (P3). Until then none at all.
  CONSTRAINT trade_proposals_no_cash_yet CHECK (cash_amount IS NULL AND cash_ccy IS NULL AND cash_from IS NULL),
  -- And when it comes, all three together or none.
  CONSTRAINT trade_proposals_cash_together CHECK (
    (cash_amount IS NULL) = (cash_ccy IS NULL) AND (cash_amount IS NULL) = (cash_from IS NULL)
  ),
  -- Sent only by the proposer's own press on their own page.
  CONSTRAINT trade_proposals_sent_is_a_press CHECK (
    state = 'awaiting-send' OR sent_at IS NULL OR sent_via = 'counter'
  ),
  -- Accepted only by the other human's press on their own page.
  CONSTRAINT trade_proposals_accepted_is_a_press CHECK (
    state <> 'accepted'
    OR (accepted_at IS NOT NULL AND accepted_by IS NOT NULL AND accepted_via = 'counter' AND sent_at IS NOT NULL)
  ),
  CONSTRAINT trade_proposals_receipt_sha256_hex CHECK (receipt_sha256 IS NULL OR receipt_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT trade_proposals_terms_sha256_hex CHECK (terms_sha256 IS NULL OR terms_sha256 ~ '^[0-9a-f]{64}$')
);

-- One open trade per pairing at a time: sending a new one supersedes the
-- open one in the same locked transaction (src/domain/trades.ts).
CREATE UNIQUE INDEX IF NOT EXISTS trade_proposals_one_open_idx
  ON trade_proposals (pairing_id) WHERE state = 'open';
CREATE INDEX IF NOT EXISTS trade_proposals_pairing_idx ON trade_proposals (pairing_id, created_at DESC);
CREATE INDEX IF NOT EXISTS trade_proposals_proposer_idx ON trade_proposals (proposer_account, created_at DESC);

COMMENT ON TABLE trade_proposals IS
  'Things for things between the two people of one pairing. Drafted by an assistant, sent by the proposer''s press, accepted by the other human''s press (src/domain/trades.ts). No money yet.';

-- 2. WHAT GOES EACH WAY. One row per thing: whose it is (the giver) and how
--    many. The proposer's own things go to the other person; the other
--    person's go to the proposer. Never edited: a change is a new proposal.
CREATE TABLE IF NOT EXISTS trade_proposal_items (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id   uuid        NOT NULL REFERENCES trade_proposals(id),
  card_id       uuid        NOT NULL REFERENCES cards(id),
  giver_account uuid        NOT NULL REFERENCES accounts(id),
  quantity      integer     NOT NULL CHECK (quantity >= 1),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT trade_proposal_items_once UNIQUE (proposal_id, card_id)
);
CREATE INDEX IF NOT EXISTS trade_proposal_items_card_idx ON trade_proposal_items (card_id);

-- 3. AN ITEM THAT GOES IN A TRADE comes down the way one sold does when none
--    are left, with its own reason.
ALTER TABLE cards DROP CONSTRAINT IF EXISTS cards_withdrawn_because_check;
ALTER TABLE cards ADD CONSTRAINT cards_withdrawn_because_check
  CHECK (withdrawn_because IS NULL OR withdrawn_because IN ('none_left', 'traded'));

-- 4. WRITTEN LINES ON A TRADE'S TWO PAGES. A line asked on a pairing is
--    confirmed by the other person, either way round (src/domain/confirmLines.ts),
--    and the pages that send and accept a trade confirm what they list.
ALTER TABLE confirm_lines DROP CONSTRAINT IF EXISTS confirm_lines_answered_on_check;
ALTER TABLE confirm_lines ADD CONSTRAINT confirm_lines_answered_on_check
  CHECK (answered_on IS NULL OR answered_on IN ('offer-accept', 'offer-send', 'lines-confirm', 'trade-send', 'trade-accept'));

-- 5. THE TWO PAGES are link actions like every other page a human presses, so
--    the check on approval_links.action learns their names. Rewritten in
--    full, as 066 did; test/unit/linkActionsMigrated.test.ts holds this list
--    to the one in src/counter/links.ts.
ALTER TABLE approval_links DROP CONSTRAINT IF EXISTS approval_links_action_check;
ALTER TABLE approval_links ADD CONSTRAINT approval_links_action_check
  CHECK (action IN (
    'offer-accept',
    'stage3-disclosure',
    'settlement-approve',
    'offer-send',
    'collection-close',
    'negotiation-auto',
    'conversation-photo',
    'report',
    'conversation-renew',
    'shelf-pick',
    'contact-send',
    'lines-confirm',
    'trade-send',
    'trade-accept'
  ));
