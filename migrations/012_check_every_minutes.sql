-- The standing arrangement's cadence becomes a number (phase 1.E)
--
-- check_cadence was free text in the human's words ("twice a day"), which
-- reads well and cannot be enforced. It becomes check_every_minutes: an
-- integer, floor 30, ceiling 10080. The words do not go away — the human and
-- their agent still agree "twice a day" — but the agent writes 720, and the
-- page says it back as "twice a day" again.
--
-- Nothing is migrated across. "Twice a day" is not a number and guessing one
-- would put words in a human's mouth, so the old key is dropped and the next
-- conversation between an agent and its human settles the new one. This is
-- pre-launch; no real arrangement is lost.
UPDATE accounts
   SET arrangement = arrangement - 'check_cadence'
 WHERE arrangement ? 'check_cadence';
