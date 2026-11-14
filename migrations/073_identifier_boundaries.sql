-- A MARK BETWEEN TWO DIGITS IS KEPT (14 November 2026; src/domain/identifiers.ts
-- normaliseIdentifier, identifiersAgree; src/domain/identifierBackfill.ts).
--
-- Until today an identifier was compared with every mark taken out, so "2/198"
-- and "21/98" were one identifier, and so were "012/198" and "121/98". Two
-- postings with different numbers were told they carried the same one, a
-- shared identifier could lift a pair to sure, and a list sent again could
-- hand one item's posting, with its introductions, to a different item.
--
-- Now a run of marks between two digits is kept as one boundary ("2-198"),
-- and taken out everywhere else ("WH-1000XM4" is still "wh1000xm4"). A short
-- code is compared with its leading zeros dropped as well ("012/198" meets
-- "12/198"), and a code of eight digits or more with its marks taken out as
-- well ("978-0-14-143951-8" meets "9780141439518"). A name in front of a code
-- no longer meets a different name in front of the same code.
--
-- 1. MORE FORMS. An identifier is now looked up by up to six forms (three for
--    the whole value, three for a code at its end), so a posting by up to
--    eighteen.
ALTER TABLE cards DROP CONSTRAINT IF EXISTS cards_identifiers_three_at_most;
ALTER TABLE cards ADD CONSTRAINT cards_identifiers_three_at_most CHECK (
  (identifiers IS NULL OR (jsonb_typeof(identifiers) = 'array' AND jsonb_array_length(identifiers) <= 3))
  AND (identifier_norms IS NULL OR cardinality(identifier_norms) <= 18)
);

-- 2. THE FORMS ALREADY STORED ARE WORKED OUT AGAIN, IN TYPESCRIPT. The rule
--    reads Unicode letters and digits after NFKD folding, which SQL in this
--    database cannot be relied on to reproduce character for character, and
--    two copies of the rule would drift. So this migration only clears the
--    lookup forms of every row that has identifiers, and each task, as it
--    starts, writes them again from the stored values with the same code the
--    doors use (identifierBackfill.ts fillIdentifierForms): the `norm` in each
--    element of `identifiers` and of `screened_content.identifiers`, and
--    `identifier_norms`. A row with identifiers and no lookup forms is exactly
--    a row still to do, and the partial index below finds them at once.
--
--    Until a row is done the exact-match lookup does not find it; nothing
--    else changes, because every comparison works the forms out again from
--    the stored values (identifiersOf). A row an older task writes during the
--    rollout keeps its old forms; the ops command `identifier-forms --all`
--    writes every row again and is safe to run at any time.
UPDATE cards SET identifier_norms = NULL WHERE identifiers IS NOT NULL;

CREATE INDEX IF NOT EXISTS cards_identifier_forms_due_idx
  ON cards (id)
  WHERE identifiers IS NOT NULL AND identifier_norms IS NULL;

COMMENT ON COLUMN cards.identifier_norms IS
  'The forms each identifier is looked up by (domain/identifiers.ts identifierNorms): its normalised form, its unpadded form, its form without marks for a long code, and the same for a code at the end of a name. Eighteen at most. Written with identifiers, from the same values; NULL beside identifiers means still to be written (identifierBackfill.ts).';
