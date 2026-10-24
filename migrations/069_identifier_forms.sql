-- THE CODE AT THE END OF A NAME (founder, October 2026;
-- src/domain/identifiers.ts trailingCode).
--
-- In a rehearsal one assistant gave an identifier as a name with the printed
-- code after it ("Obsidian Flames 125/197") and the other gave the code alone
-- ("125/197"). Their compared forms never met, so the exact-match path missed
-- and the pair met by meaning twelve minutes later. A value of several words
-- whose last word holds a digit is now compared by that last word alone as
-- well, padded and unpadded: up to four forms an identifier where there were
-- two, so twelve a posting where there were six.
--
-- A shared identifier is still never a sure match on its own: it brings a
-- candidate in, and the tiers still need a near shelf and agreeing names.
--
-- Rows written before this keep the forms they were written with until they
-- are next amended; the engine compares fresh forms from `identifiers` on
-- both sides once a candidate is in, so only the index lookup is narrower for
-- those rows.
ALTER TABLE cards DROP CONSTRAINT IF EXISTS cards_identifiers_three_at_most;
ALTER TABLE cards ADD CONSTRAINT cards_identifiers_three_at_most CHECK (
  (identifiers IS NULL OR (jsonb_typeof(identifiers) = 'array' AND jsonb_array_length(identifiers) <= 3))
  AND (identifier_norms IS NULL OR cardinality(identifier_norms) <= 12)
);

COMMENT ON COLUMN cards.identifier_norms IS
  'The compared forms of each identifier (norm; the unpadded form where it differs; and for a name ending in a code, the code alone in both forms), for the GIN index the exact-match candidate path reads. Twelve at most. Written with identifiers, from the same values.';
