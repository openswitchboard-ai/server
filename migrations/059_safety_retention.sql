-- HOW LONG SAFETY RECORDS ARE KEPT (founder decisions, 28 September 2026)
-- (src/safety/photoQuarantine.ts; src/safety/retention.ts)
--
-- 1. A HELD PHOTO GOES AT NINETY DAYS. Until now a quarantined photo nobody
--    had decided about was kept past its ninety days and only logged as
--    overdue. From here the daily sweep deletes it at its expiry, unless it is
--    a known-image match, or its introduction or its sender has a report or a
--    safety flag against it, or a lawful preservation hold is on it or on the
--    conversation behind it. Those stay held for a person. A referred photo is
--    kept, as before. Nobody views an image, as before.
--
-- 2. REPORTS AND SAFETY FLAGS GO AT TWELVE MONTHS. Neither table had any
--    deletion. From here the same tick deletes a row older than twelve months,
--    unless it was referred to police, is under a preservation hold, or belongs
--    to an active suspension. Nothing references either table by key, so a row
--    is deleted outright rather than anonymised.
--
-- WHAT THIS MIGRATION ADDS is the two marks those exceptions read and that did
-- not exist yet. `preserved_until` is the same idea the ledger already has: a
-- lawful request freezes the row without anybody reading it. `referred_at` is
-- an operator writing down that they referred the item. The referral is their
-- act; nothing in this repository contacts the police.
ALTER TABLE photo_quarantine ADD COLUMN IF NOT EXISTS preserved_until timestamptz;

ALTER TABLE reports ADD COLUMN IF NOT EXISTS referred_at timestamptz;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS preserved_until timestamptz;

ALTER TABLE safety_reviews ADD COLUMN IF NOT EXISTS referred_at timestamptz;
ALTER TABLE safety_reviews ADD COLUMN IF NOT EXISTS preserved_until timestamptz;

-- The sweep reads by age.
CREATE INDEX IF NOT EXISTS reports_created_idx ON reports (created_at);
CREATE INDEX IF NOT EXISTS safety_reviews_created_idx ON safety_reviews (created_at);
-- And the photo sweep asks whether an introduction has a report behind it.
CREATE INDEX IF NOT EXISTS reports_match_idx ON reports (match_id);

COMMENT ON COLUMN photo_quarantine.status IS
  'held (nobody has decided; deleted at expiry unless a known-image match, linked to a report or safety flag, or under a preservation hold), referred (an operator referred it; never swept, never deleted), cleared (an operator said no; object deleted at that moment, row swept at expiry).';
COMMENT ON COLUMN photo_quarantine.preserved_until IS
  'Set by a preservation request under lawful process. Keeps a held item past its ninety days without anybody viewing it.';
COMMENT ON COLUMN reports.referred_at IS
  'When an operator wrote down that they referred this to police. A referred report is never deleted by the twelve-month sweep.';
COMMENT ON COLUMN reports.preserved_until IS
  'Set by a preservation request under lawful process. Keeps the report past its twelve months.';
COMMENT ON COLUMN safety_reviews.referred_at IS
  'When an operator wrote down that they referred this to police. A referred review is never deleted by the twelve-month sweep.';
COMMENT ON COLUMN safety_reviews.preserved_until IS
  'Set by a preservation request under lawful process. Keeps the review past its twelve months.';
