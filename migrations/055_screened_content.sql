-- WHAT CROSSES IS WHAT WAS SCREENED (28 September 2026).
--
-- Two findings from the same review, closed together because each needs the
-- other.
--
-- 1. THE OTHER SIDE READ THE LIVE ROW. The details an introduced person is
--    shown — the attributes, the asking price, the poster's own words for the
--    thing and their other words for it — were read straight off the card on
--    every sweep. An amend or a refine puts new words on that row and sends it
--    back to the screen, and until the screen answered, those new words were
--    already reaching whoever had been introduced. A screen that then refused
--    them could not call them back.
--
--    screened_content is the card's words AS THE SCREEN LAST PASSED THEM: a
--    copy written in the same statement that publishes the card, from the very
--    values that were screened. Everything a counterparty is shown about the
--    card is read from here, never from the live columns. An amend or a refine
--    leaves it alone, so the other side goes on seeing the last words that
--    passed; a refusal leaves it alone too, so refused words never cross. The
--    owner's own reads — their list, their main page — stay on the live row.
--
-- 2. A STALE VERDICT COULD PUBLISH NEWER WORDS. The screening worker reads the
--    card, spends seconds on a model call, and then writes its verdict guarded
--    only by the card still being pending. An amend landing in those seconds
--    put the card back to pending with new words, so the old verdict published
--    them, and the amend's own screening message then found nothing pending.
--
--    content_version counts the card's words. Publishing starts it at 1; every
--    amend and every refine adds one in the same statement that changes the
--    words; the screening message carries it; and a verdict lands only on the
--    version it read. A verdict on an older version is dropped quietly, and the
--    message for the newer version does the work.
--
-- THE BACKFILL. Every card whose stored verdict is a pass, and every card that
-- is up right now, gets a snapshot of the words it holds today: amend and refine
-- both clear the verdict, so a row still carrying a pass has not had its words
-- changed since that pass. A card with no snapshot has never been screened
-- through, and serves nothing to anyone until it is.
ALTER TABLE cards ADD COLUMN IF NOT EXISTS content_version integer NOT NULL DEFAULT 1;
ALTER TABLE cards ADD COLUMN IF NOT EXISTS screened_content jsonb;

UPDATE cards
   SET screened_content = jsonb_build_object(
         'version', content_version,
         'at', COALESCE(screening->>'at', to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')),
         'kind', kind,
         'also_called', also_called,
         'not_these', not_these,
         'attributes', COALESCE(attributes, '{}'::jsonb),
         'ask', ask)
 WHERE screened_content IS NULL
   AND (lifecycle_state = 'PUBLISHED' OR screening->>'pass' = 'true');

COMMENT ON COLUMN cards.content_version IS
  'Counts the card''s words: 1 at publish, plus one on every amend and refine. The screening message carries it and a verdict lands only on the version it screened.';
COMMENT ON COLUMN cards.screened_content IS
  'The card''s words as the screen last passed them (kind, also_called, not_these, attributes, ask, version, at). Everything a counterparty is shown about the card is read from here, never from the live columns. NULL: never screened through, and nothing is served.';
