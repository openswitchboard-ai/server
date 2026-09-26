-- SWAPS: TWO WANTS ON THE SOCIAL SHELVES MAY MEET (Lachlan, 26 September 2026).
--
-- The first production test put up a language exchange that could never meet:
-- one person wanted a Spanish conversation partner and speaks English, the
-- other wanted an English practice partner and speaks Spanish. Both posted
-- wants, and the matcher only ever paired a want with a have. On social.* two
-- wants may now be introduced to each other, and that pairing is a SWAP
-- (src/domain/swaps.ts has the whole of the rule and the reasons).
--
-- WHAT THIS ADDS.
--
--   matches.swap   true where both postings on the row are wants. The row's
--                  card_want and card_have columns are then only two slots:
--                  the posting in card_have is a want too, so nothing that
--                  decides wording or money may read a side from the column.
--                  Every row that already exists is a want and a have, which
--                  is what the default says.
--
--   the order rule A swap is written with the smaller posting id in
--                  card_want. The matcher decides that order in one place
--                  (swapPairOrder), so A finding B and B finding A arrive at
--                  the same key and the unique (card_want, card_have) key
--                  dedupes them, races included. The CHECK makes that
--                  structural: a swap written the other way round is refused
--                  rather than becoming a second introduction of the same two
--                  people. uuid ordering in Postgres is byte order, which is
--                  the same order as the canonical lower-case text the matcher
--                  compares.
--
-- Idempotent: the column is IF NOT EXISTS and the constraint is added only
-- where it is not already there.

ALTER TABLE matches ADD COLUMN IF NOT EXISTS swap boolean NOT NULL DEFAULT false;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'matches_swap_canonical_order'
       AND conrelid = 'matches'::regclass
  ) THEN
    ALTER TABLE matches
      ADD CONSTRAINT matches_swap_canonical_order CHECK (NOT swap OR card_want < card_have);
  END IF;
END
$$;

COMMENT ON COLUMN matches.swap IS
  'true where both postings are wants on social.* (src/domain/swaps.ts): a swap. card_want/card_have are then two slots in canonical order (smaller id first), no side is read from them, and no figure or payment applies.';
