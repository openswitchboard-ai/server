-- JEV HELPS CHOOSE THE SHELF AT THE DOOR (founder, 1 October 2026;
-- src/domain/jevShelf.ts).
--
-- Where JEV_SHELF is on and the door is unsure which shelf a posting belongs
-- on, TypeSafe's Jev is offered the door's own shortlist and may pick one, or
-- say none of them fits. Its decision is written to the shelf gap log like
-- every other unsure decision, and these two columns say that it was Jev's and
-- how sure it was. Nothing else is added: still no account id, no attributes,
-- no figures.
--
--   how  'jev' where Jev's answer decided the outcome; null otherwise (every
--        row before today, and every row the rules or a human decided).
--   p    Jev's probability for the answer it gave, 0..1, on 'jev' rows only.
--
-- And one new outcome: 'jev_picked', a posting filed on the shelf Jev chose.
-- Jev saying none of these fits is the existing 'none_of_these' outcome with
-- how = 'jev'.
ALTER TABLE shelf_gaps ADD COLUMN IF NOT EXISTS how text
  CHECK (how IS NULL OR how IN ('jev'));
ALTER TABLE shelf_gaps ADD COLUMN IF NOT EXISTS p real
  CHECK (p IS NULL OR (p >= 0 AND p <= 1));

ALTER TABLE shelf_gaps DROP CONSTRAINT IF EXISTS shelf_gaps_outcome_check;
ALTER TABLE shelf_gaps ADD CONSTRAINT shelf_gaps_outcome_check CHECK (outcome IN (
  'snapped_low_confidence',
  'asked',
  'human_picked',
  'none_of_these',
  'picked_from_list',
  'top_level',
  'jev_picked'
));
