-- AN IDENTIFIER ON A POSTING (founder, 9 October 2026;
-- src/domain/identifiers.ts).
--
-- Matching is by meaning, so two postings for the identical product can miss
-- each other on a crowded shelf, and two editions of a similarly named product
-- can read as one. A posting may now carry up to three identifiers: a model
-- number, an ISBN, a printed card number, whatever the person's own assistant
-- says tells this product or edition from the next. There is no list of kinds
-- and no catalogue; the kind is the poster's own few words.
--
--   identifiers        the identifiers as given and as compared: a jsonb array
--                      of { kind, value, norm }, three at most. `value` is the
--                      identifier as the owner wrote it, read back to them and
--                      to nobody else. `norm` is the value case-folded with
--                      everything but letters and digits removed, which is the
--                      form the engine compares. Null on a posting with none.
--   identifier_norms   the forms each is compared in, as a text array, written
--                      in the same statement from the same values: the `norm`,
--                      and the value with leading zeros dropped from each run
--                      of digits where that differs ("025/165" and "25/165"
--                      are one identifier). Two forms each, so six at most. It
--                      exists for the index below and for nothing else.
--
-- WHY COLUMNS ON THE POSTING AND NOT A TABLE OF THEIR OWN. An identifier is
-- part of a posting's words, and everything that keeps a posting's words safe
-- is built on the row: the content version that moves in the statement that
-- changes them, the screen that reads the row it was handed, the screened
-- snapshot written from that same row (migration 055), and the erasure that
-- clears a deleted account's postings. `also_called` and `not_these` are
-- columns for the same reason (migration 050). A child table would have needed
-- each of those guards written a second time, and a miss in any one of them
-- is the "amended after an introduction, never screened" finding again.
ALTER TABLE cards ADD COLUMN IF NOT EXISTS identifiers jsonb;
ALTER TABLE cards ADD COLUMN IF NOT EXISTS identifier_norms text[];

ALTER TABLE cards DROP CONSTRAINT IF EXISTS cards_identifiers_three_at_most;
ALTER TABLE cards ADD CONSTRAINT cards_identifiers_three_at_most CHECK (
  (identifiers IS NULL OR (jsonb_typeof(identifiers) = 'array' AND jsonb_array_length(identifiers) <= 3))
  AND (identifier_norms IS NULL OR cardinality(identifier_norms) <= 6)
);

-- The exact-match candidate path (domain/matcher.ts retrieveByIdentifier):
-- published postings that hold any of a posting's normalised identifiers.
-- Only what is up is ever a candidate, so only that is indexed.
CREATE INDEX IF NOT EXISTS cards_identifier_norms_idx
  ON cards USING gin (identifier_norms)
  WHERE lifecycle_state = 'PUBLISHED';

COMMENT ON COLUMN cards.identifiers IS
  'Up to three identifiers naming the product or edition: [{ kind, value, norm }]. The value as given is the owner''s alone; norm is what matching compares. Never one object''s own number, never a contact detail (domain/identifiers.ts).';
COMMENT ON COLUMN cards.identifier_norms IS
  'The compared forms of each identifier (norm, and the unpadded form where it differs), for the GIN index the exact-match candidate path reads. Written with identifiers, from the same values.';
