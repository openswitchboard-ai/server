-- WHICH JUDGE DECIDED AN INTRODUCTION'S TIER (founder, 29 September 2026;
-- src/domain/jevJudge.ts).
--
-- Where JEV_MATCHING is on, TypeSafe's Jev decides the tier of a borderline
-- pair (one the rules placed at possible, near miss, or sure on meaning
-- alone); everywhere else, and wherever Jev does not answer in time, the rules
-- do. This column says which, so the two can be told apart later. Nullable:
-- every introduction made before today was the rules', and says nothing.
ALTER TABLE matches ADD COLUMN IF NOT EXISTS judged_by text
  CHECK (judged_by IS NULL OR judged_by IN ('rules', 'jev'));
