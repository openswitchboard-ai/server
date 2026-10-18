-- A LIST: MANY POSTINGS AT ONCE (founder, October 2026; src/domain/lists.ts).
--
-- A collector with four hundred things to trade, a shop with a stock sheet, a
-- person with a long want list: until now each thing was one publish_intent
-- call, ten a day and twenty open at most, so a whole collection could never
-- go up at all. The person's own assistant now converts whatever they hold (an
-- export file from an app, a spreadsheet, a typed list, a photo of a shelf)
-- into a list and posts it in one call. The switchboard builds no importers,
-- holds no third-party keys and keeps no catalogue: the conversion is the
-- assistant's, and what arrives is items in the ordinary vocabulary.
--
-- Nothing here is about one kind of goods, one app or one community. A list
-- is a general thing: many postings that share a side, a shelf, a place, how
-- far they reach, one kind of deal and an expiry.
--
-- 1. THE LIST ROW. One per list, holding what every item shares and nothing
--    about any one item.
--
--   account_id         the owner. Every item carries it too, as every
--                      posting does.
--   type               WANT or HAVE, for the whole list.
--   category           the shelf every item is filed under: the node the
--                      switchboard filed it on, which is the matching key.
--   category_as_posted the path the assistant sent, kept for the record and
--                      never a matching key, as on a posting (migration 046).
--   deal               'sale', 'trade' or 'free', one for the whole list. A
--                      sale's items carry an asking price or are open to
--                      offers (a want's items may carry a private limit); a
--                      trade's or a giveaway's items carry no money.
--   shared             the shared fields as they were sent, and the place as
--                      the switchboard resolved it, so a later call to the
--                      same list can be held to them and its new items placed
--                      the same way without asking the gazetteer again.
--                      Erased when the account is deleted.
--   state              'open' or 'withdrawn'. Expiry is read off expires_at.
--   expires_at         when every item on it ends. Sending the whole list
--                      again (a replace) moves it on.
--   replace_*          a replace sent in several parts: the pass it is on, how
--                      many parts it said there would be, and the next part it
--                      expects. Items it has seen carry the same pass
--                      (cards.list_pass); after the last part, the live items
--                      it never saw are withdrawn. Null between replaces.
--
-- 2. THE ITEMS ARE ORDINARY POSTINGS. Each item is a row in cards with
--    list_id pointing here. That is the whole design, and the reason for it is
--    the same one migration 067 gave for putting identifiers on the row: every
--    guard that keeps a posting safe is built on the cards row. The content
--    version that moves when words change, the screen that reads the row it
--    was handed, the screened snapshot the other side is shown (055), the
--    matcher's prefilter and its own-account exclusion, withdrawal that keeps
--    open conversations, expiry, suspension and the erasure that clears a
--    deleted account's words: each of them already works on an item, unwritten
--    a second time. A child table would have needed every one of them again.
--
--    list_id is also the stable link a later build needs to group a person's
--    introductions by list (the sweep of a big list is a separate build), and
--    account_id is already on every row beside it.
--
--    QUANTITY IS A DETAIL. "Three of these" is a fact about the item, stored
--    as the attribute `quantity` and shown like any other detail. It is not
--    stock and it does not use `slots`, which means how many people may be
--    introduced to one posting at once.
--
--   list_pass          the replace pass that last saw this item (above).
--
-- 3. THE CEILING. Each person may hold up to QUOTA_MAX_LIST_ITEMS list items
--    that are pending or up (500 by default), separate from and in addition to
--    the twenty ordinary open postings. It is counted inside the transaction
--    that inserts them, under a per-account advisory lock, so two calls racing
--    cannot overshoot it (src/domain/lists.ts). The twenty-posting ceiling now
--    counts only postings with no list (src/domain/quotas.ts).
CREATE TABLE IF NOT EXISTS lists (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id         uuid        NOT NULL REFERENCES accounts(id),
  type               text        NOT NULL CHECK (type IN ('WANT', 'HAVE')),
  category           text        NOT NULL,
  category_as_posted text,
  deal               text        NOT NULL CHECK (deal IN ('sale', 'trade', 'free')),
  shared             jsonb       NOT NULL DEFAULT '{}'::jsonb,
  state              text        NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'withdrawn')),
  expires_at         timestamptz NOT NULL,
  replace_pass       uuid,
  replace_parts      integer     CHECK (replace_parts IS NULL OR replace_parts BETWEEN 1 AND 10),
  replace_next       integer     CHECK (replace_next IS NULL OR replace_next BETWEEN 1 AND 11),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  withdrawn_at       timestamptz
);
CREATE INDEX IF NOT EXISTS lists_account_idx ON lists (account_id, created_at DESC);

COMMENT ON TABLE lists IS
  'Many postings that share a side, a shelf, a place and reach, one kind of deal and an expiry. The items are ordinary rows in cards with list_id set (src/domain/lists.ts).';
COMMENT ON COLUMN lists.shared IS
  'The shared fields as sent and the place as resolved, so later calls to the same list are held to them. Erased on account deletion.';

ALTER TABLE cards ADD COLUMN IF NOT EXISTS list_id uuid REFERENCES lists(id);
ALTER TABLE cards ADD COLUMN IF NOT EXISTS list_pass uuid;

-- A list's items in the order they went up, for reading a list a page at a
-- time and for matching a replace against what is already there.
CREATE INDEX IF NOT EXISTS cards_list_idx ON cards (list_id, created_at, id) WHERE list_id IS NOT NULL;

-- The ceiling's count: a person's list items that are pending or up.
CREATE INDEX IF NOT EXISTS cards_list_items_held_idx ON cards (account_id)
  WHERE list_id IS NOT NULL AND lifecycle_state IN ('PENDING_SCREENING', 'PUBLISHED');

COMMENT ON COLUMN cards.list_id IS
  'The list this posting is an item of, or null for an ordinary posting. Items count against the list ceiling and never against the twenty open postings.';
COMMENT ON COLUMN cards.list_pass IS
  'The replace pass that last saw this item. Live items a finished replace never saw are withdrawn.';
