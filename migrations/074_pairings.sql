-- ONE ENTRY PER PERSON FOR LISTS, A DEAL FOR SALE OR TRADE, AND QUANTITIES THAT
-- COME DOWN (14 November 2026; src/domain/pairings.ts, src/domain/lists.ts,
-- src/domain/quantities.ts).
--
-- A person with a list of five hundred things met somebody else's list of two
-- hundred and was handed one introduction per item: forty entries on a sweep
-- that holds fifty, each with its own names step, its own conversation and its
-- own clock, all of them with the same person. The matcher still pairs one
-- want with one have, exactly as before. What is new is the row that gathers
-- every one of those item introductions between the same two people, which is
-- what both assistants now see: someone has four of your wants and is after
-- two of your haves.
--
-- ONLY LISTS, ONLY GOODS. A grouping is made only where both postings are
-- items on lists and both are on a goods shelf. An ordinary posting is
-- introduced, sequenced and swept exactly as it was, and nothing in this
-- migration touches a row that is not a list item's.
--
-- 1. THE DEAL. A list may now be for sale or trade: its items can be bought,
--    or put into a trade. A sale needs both lists to allow a sale, and a trade
--    needs both to allow a trade (pairings.ts dealsAllow). Until now a trade
--    list's introductions ran as sales; an introduction whose two lists allow
--    no deal at all is not shown to anybody.
ALTER TABLE lists DROP CONSTRAINT IF EXISTS lists_deal_check;
ALTER TABLE lists ADD CONSTRAINT lists_deal_check
  CHECK (deal IN ('sale', 'trade', 'free', 'sale_or_trade'));

-- 2. THE GROUPING. One open row per two people, whichever of them came first:
--    the lower account id is always account_lo (the swap trick, migration
--    053), and the partial unique index below is what makes two matching runs
--    racing from both sides land on the one row. A grouping that has ended
--    stays as the record; a new item introduction between the same two people
--    after that starts a new one, the way a new posting starts a new
--    introduction today.
--
--   state             open, declined, archived, or closed_by_switchboard (a
--                     report or a suspension).
--   ended_via         how an archive came about: 'lapsed', 'withdrawn' or the
--                     page or tool it was pressed on.
--   live, live_at,    the slot, as on an introduction (migration 030): each
--   last_movement_at  person has a few live groupings at once and the rest
--                     wait their turn. The clock runs on the grouping.
--   anchor_match_id   the first item introduction. The names step, the
--                     conversation, a report and a sever ride on it for now,
--                     reusing every guard that is keyed on an introduction.
--   *_gets_sure,      how many distinct items each person gets from the
--   *_gets_maybe      other, sure and maybe, counting only item introductions
--                     whose two lists allow a deal.
--   sale_to_*,        per direction: whether an item going to that person can
--   trade_to_*,       be sold, traded or given. A trade needs trade_to_lo and
--   free_to_*         trade_to_hi both.
CREATE TABLE IF NOT EXISTS pairings (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_lo       uuid        NOT NULL REFERENCES accounts(id),
  account_hi       uuid        NOT NULL REFERENCES accounts(id),
  state            text        NOT NULL DEFAULT 'open'
                               CHECK (state IN ('open', 'declined', 'archived', 'closed_by_switchboard')),
  ended_via        text,
  ended_by         uuid,
  ended_at         timestamptz,
  live             boolean     NOT NULL DEFAULT false,
  live_at          timestamptz,
  last_movement_at timestamptz,
  anchor_match_id  uuid,
  lo_gets_sure     integer     NOT NULL DEFAULT 0 CHECK (lo_gets_sure >= 0),
  lo_gets_maybe    integer     NOT NULL DEFAULT 0 CHECK (lo_gets_maybe >= 0),
  hi_gets_sure     integer     NOT NULL DEFAULT 0 CHECK (hi_gets_sure >= 0),
  hi_gets_maybe    integer     NOT NULL DEFAULT 0 CHECK (hi_gets_maybe >= 0),
  sale_to_lo       boolean     NOT NULL DEFAULT false,
  sale_to_hi       boolean     NOT NULL DEFAULT false,
  trade_to_lo      boolean     NOT NULL DEFAULT false,
  trade_to_hi      boolean     NOT NULL DEFAULT false,
  free_to_lo       boolean     NOT NULL DEFAULT false,
  free_to_hi       boolean     NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pairings_lo_before_hi CHECK (account_lo < account_hi)
);
CREATE UNIQUE INDEX IF NOT EXISTS pairings_one_open_idx
  ON pairings (account_lo, account_hi) WHERE state = 'open';
CREATE INDEX IF NOT EXISTS pairings_lo_open_idx ON pairings (account_lo) WHERE state = 'open';
CREATE INDEX IF NOT EXISTS pairings_hi_open_idx ON pairings (account_hi) WHERE state = 'open';
CREATE INDEX IF NOT EXISTS pairings_live_clock_idx ON pairings (last_movement_at)
  WHERE state = 'open' AND live;

COMMENT ON TABLE pairings IS
  'Every item introduction between the same two people''s lists, gathered, so each of them sees one entry for the other person. Only list items on goods (src/domain/pairings.ts).';

-- 3. THE MEMBERS. Each item introduction in a grouping points at it. A member
--    never goes live on its own: it is live while its grouping is.
--    item_set_aside_at marks the ANCHOR's own item set aside (the human said
--    it is not the thing) while the anchor carries on as the grouping's
--    handle; no other member ever has it.
ALTER TABLE matches ADD COLUMN IF NOT EXISTS pairing_id uuid REFERENCES pairings(id);
ALTER TABLE matches ADD COLUMN IF NOT EXISTS item_set_aside_at timestamptz;
CREATE INDEX IF NOT EXISTS matches_pairing_idx ON matches (pairing_id) WHERE pairing_id IS NOT NULL;
ALTER TABLE pairings DROP CONSTRAINT IF EXISTS pairings_anchor_fk;
ALTER TABLE pairings ADD CONSTRAINT pairings_anchor_fk
  FOREIGN KEY (anchor_match_id) REFERENCES matches(id);

COMMENT ON COLUMN matches.pairing_id IS
  'The grouping this item introduction belongs to, or null for an ordinary introduction, which is sequenced and swept as it always was.';

-- 4. QUANTITIES THAT COME DOWN. A list item's quantity is a detail its owner
--    gave (migration 068). An accepted sale of a list item takes one of them,
--    counted here, outside the attributes, so the owner's own words are never
--    rewritten; when none are left the item comes down, with the reason.
--    Sending the item again with a different quantity starts the count again:
--    what the human sends is what they have now.
ALTER TABLE cards ADD COLUMN IF NOT EXISTS quantity_gone integer NOT NULL DEFAULT 0;
ALTER TABLE cards DROP CONSTRAINT IF EXISTS cards_quantity_gone_check;
ALTER TABLE cards ADD CONSTRAINT cards_quantity_gone_check CHECK (quantity_gone >= 0);
ALTER TABLE cards ADD COLUMN IF NOT EXISTS withdrawn_because text;
ALTER TABLE cards DROP CONSTRAINT IF EXISTS cards_withdrawn_because_check;
ALTER TABLE cards ADD CONSTRAINT cards_withdrawn_because_check
  CHECK (withdrawn_because IS NULL OR withdrawn_because IN ('none_left'));

COMMENT ON COLUMN cards.quantity_gone IS
  'How many of a list item have gone in accepted deals. What is left is the quantity detail (1 where none) less this.';
COMMENT ON COLUMN cards.withdrawn_because IS
  'Why the switchboard took an item down itself: none_left once every one of it has gone. Null where its owner took it down.';

-- 5. THE INTRODUCTIONS ALREADY MADE BETWEEN TWO LISTS ON GOODS, gathered the
--    same way, so they stop running one item at a time. The anchor is the one
--    furthest along (a conversation first, then the names step), then the
--    oldest, so a conversation already going on carries on as the grouping's.
--    A grouping with any member live is live, and so are all its members.
WITH cand AS (
  SELECT m.id, m.live, m.stage, m.channel_id, m.created_at,
         LEAST(m.account_want, m.account_have)    AS lo,
         GREATEST(m.account_want, m.account_have) AS hi
    FROM matches m
    JOIN cards w ON w.id = m.card_want
    JOIN cards h ON h.id = m.card_have
   WHERE m.state = 'open' AND m.pairing_id IS NULL AND NOT COALESCE(m.swap, false)
     AND m.account_want <> m.account_have
     AND w.list_id IS NOT NULL AND h.list_id IS NOT NULL
     AND split_part(w.category, '.', 1) = 'goods' AND split_part(h.category, '.', 1) = 'goods'
), firsts AS (
  SELECT DISTINCT ON (lo, hi) lo, hi, id AS anchor
    FROM cand
   ORDER BY lo, hi, (channel_id IS NOT NULL) DESC, stage DESC, created_at, id
), groups AS (
  SELECT f.lo, f.hi, f.anchor, bool_or(c.live) AS any_live, min(c.created_at) AS first_at
    FROM firsts f JOIN cand c ON c.lo = f.lo AND c.hi = f.hi
   GROUP BY f.lo, f.hi, f.anchor
), made AS (
  INSERT INTO pairings (account_lo, account_hi, anchor_match_id, live, live_at, last_movement_at, created_at)
  SELECT lo, hi, anchor, any_live,
         CASE WHEN any_live THEN now() END, CASE WHEN any_live THEN now() END, first_at
    FROM groups
  RETURNING id, account_lo, account_hi, live
)
UPDATE matches m
   SET pairing_id = made.id,
       live = made.live,
       live_at = CASE WHEN made.live THEN COALESCE(m.live_at, now()) ELSE m.live_at END,
       last_movement_at = CASE WHEN made.live THEN COALESCE(m.last_movement_at, now()) ELSE m.last_movement_at END,
       updated_at = now()
  FROM made, cand
 WHERE cand.id = m.id AND cand.lo = made.account_lo AND cand.hi = made.account_hi;

-- And their counts, by the same rule pairings.ts recountPairings uses.
WITH u AS (
  SELECT m.pairing_id, m.account_want, m.card_have,
         (m.certainty IS DISTINCT FROM 'possible') AS sure,
         (lh.deal IN ('sale', 'sale_or_trade') AND lw.deal IN ('sale', 'sale_or_trade')) AS sale_ok,
         (lh.deal IN ('trade', 'sale_or_trade') AND lw.deal IN ('trade', 'sale_or_trade')) AS trade_ok,
         (lh.deal = 'free') AS free_ok
    FROM matches m
    JOIN cards w ON w.id = m.card_want
    JOIN cards h ON h.id = m.card_have
    JOIN lists lw ON lw.id = w.list_id
    JOIN lists lh ON lh.id = h.list_id
   WHERE m.pairing_id IS NOT NULL AND m.state = 'open' AND m.item_set_aside_at IS NULL
     AND w.lifecycle_state = 'PUBLISHED' AND h.lifecycle_state = 'PUBLISHED'
), usable AS (
  SELECT * FROM u WHERE sale_ok OR trade_ok OR free_ok
), agg AS (
  SELECT p.id,
         count(DISTINCT x.card_have) FILTER (WHERE x.account_want = p.account_lo AND x.sure) AS lo_sure,
         count(DISTINCT x.card_have) FILTER (WHERE x.account_want = p.account_lo)          AS lo_all,
         count(DISTINCT x.card_have) FILTER (WHERE x.account_want = p.account_hi AND x.sure) AS hi_sure,
         count(DISTINCT x.card_have) FILTER (WHERE x.account_want = p.account_hi)          AS hi_all,
         COALESCE(bool_or(x.sale_ok)  FILTER (WHERE x.account_want = p.account_lo), false) AS sale_lo,
         COALESCE(bool_or(x.sale_ok)  FILTER (WHERE x.account_want = p.account_hi), false) AS sale_hi,
         COALESCE(bool_or(x.trade_ok) FILTER (WHERE x.account_want = p.account_lo), false) AS trade_lo,
         COALESCE(bool_or(x.trade_ok) FILTER (WHERE x.account_want = p.account_hi), false) AS trade_hi,
         COALESCE(bool_or(x.free_ok)  FILTER (WHERE x.account_want = p.account_lo), false) AS free_lo,
         COALESCE(bool_or(x.free_ok)  FILTER (WHERE x.account_want = p.account_hi), false) AS free_hi
    FROM pairings p
    LEFT JOIN usable x ON x.pairing_id = p.id
   WHERE p.state = 'open'
   GROUP BY p.id
)
UPDATE pairings p
   SET lo_gets_sure = agg.lo_sure, lo_gets_maybe = agg.lo_all - agg.lo_sure,
       hi_gets_sure = agg.hi_sure, hi_gets_maybe = agg.hi_all - agg.hi_sure,
       sale_to_lo = agg.sale_lo, sale_to_hi = agg.sale_hi,
       trade_to_lo = agg.trade_lo, trade_to_hi = agg.trade_hi,
       free_to_lo = agg.free_lo, free_to_hi = agg.free_hi,
       updated_at = now()
  FROM agg
 WHERE agg.id = p.id;
