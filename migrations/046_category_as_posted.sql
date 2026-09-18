-- The path the assistant actually wrote, kept beside the one the switchboard
-- files the posting under
-- (src/domain/categoryBackfill.ts snapCategory; src/domain/cards.ts publish).
--
-- WHY THIS COLUMN EXISTS. Run 9 on dev had two postings for the same object
-- that never met. A have went up under 'goods.gaming.sim-racing', which is a
-- branch the catalogue has never heard of, and a want for the same thing went
-- up under 'goods.electronics'. The matcher reads the category as a hard gate
-- — equal, ancestor, descendant, or siblings under a shared parent — so an
-- invented branch gives every candidate pool a size of zero. Each posting sat
-- there alone while the other one sat there alone.
--
-- So the door now snaps an unknown path onto the nearest node the catalogue
-- does know before the row is written. That makes the stored category a
-- switchboard decision rather than the assistant's word, and the assistant's
-- word is worth keeping: it is the evidence of what a person actually asked
-- for, it is what the growth list in category_misses is counted from, and an
-- operator looking at a remap has to be able to see what was moved and from
-- where. It is never used for matching and it is never shown to anybody on
-- the other side.
--
-- Every existing row is backfilled from its own category, so the column means
-- the same thing on an old posting as on a new one: this is what was sent.
ALTER TABLE cards
  ADD COLUMN IF NOT EXISTS category_as_posted text;

UPDATE cards SET category_as_posted = category WHERE category_as_posted IS NULL;

COMMENT ON COLUMN cards.category_as_posted IS
  'The category path the posting assistant sent, before any snap onto a known taxonomy node. Kept for the record and for operators; never a matching key, never disclosed.';
