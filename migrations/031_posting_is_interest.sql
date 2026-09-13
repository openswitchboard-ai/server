-- The posting is the statement of interest (phase 1.I)
--
-- Until today an introduction was made at stage 1 and each side's agent had to
-- call respond(express_interest) before the details opened. At that moment the
-- human knew two things — the category, and which side the other person was on
-- — so the only sane answer was always yes. A gate everybody always passes is
-- a step, not a gate: it cost a round trip to a human on each side and told
-- nobody anything. Posting the thing in the first place was the statement of
-- interest all along.
--
-- So there are two gates now, not three. The details (the other side's
-- attributes, and a seller's asking price) are open to BOTH sides the moment
-- two things are matched. Sharing a first name and a rough area is still the
-- human's own press, every time. Talking is still behind that. decline is
-- still how somebody says no, and still the only way an agent closes an
-- introduction.
--
-- The two interest columns are KEPT, and they keep meaning exactly what they
-- always meant — this side is keen — so nothing downstream that reads them has
-- to change and the audit trail still says what happened. What changed is when
-- they become true: at the introduction, not at a second asking. New rows are
-- written that way by the matcher and by createMatch; the defaults below are
-- the same fact stated structurally, so no insert path anywhere can make an
-- introduction that starts below the details step.
--
-- THE BACKFILL. Every OPEN introduction sitting below the details step moves
-- up to it, with both interest columns true. These are live people mid-flow:
-- leaving them behind would mean each of their agents still had to call a step
-- that no longer does anything, and their humans would sit under a sentence
-- asking them to say yes to something the rest of the switchboard now takes as
-- already said. Declined, closed and archived introductions are NOT touched:
-- they are finished, and moving a finished row up a step would rewrite what
-- happened to it. The same goes for the interest columns on those rows — a
-- human who never said yes keeps not having said it.
--
-- What this knowingly gives up: the details used to flow only once a live
-- human had engaged, so a stale posting from somebody who has already bought
-- the bike kept its details shut. Expiry, withdrawal and the summons email
-- cover that, and the trade was accepted (Lachlan, 13 September 2026).

ALTER TABLE matches
  ALTER COLUMN stage         SET DEFAULT 2,
  ALTER COLUMN interest_want SET DEFAULT true,
  ALTER COLUMN interest_have SET DEFAULT true;

UPDATE matches
   SET stage = 2, interest_want = true, interest_have = true, updated_at = now()
 WHERE state = 'open' AND stage < 2;

COMMENT ON COLUMN matches.interest_want IS
  'The want side is keen. True from the introduction itself since migration 031: posting the thing is the statement of interest.';
COMMENT ON COLUMN matches.interest_have IS
  'The have side is keen. True from the introduction itself since migration 031: posting the thing is the statement of interest.';
