-- A photo that matched a known abuse image, and how that row differs from
-- every other quarantined one
-- (src/safety/photodna.ts; src/intake/checks/photoHashMatch.ts;
--  docs/trust-and-safety.md, "A known-image match")
--
-- OpenSwitchboard uses PhotoDNA technology licensed by Microsoft at no cost.
--
-- WHY THE DISTINCTION MATTERS ENOUGH FOR COLUMNS. photo_quarantine already
-- holds photos refused for a sexual moderation label, and the reason it holds
-- rather than deletes is that a machine saying "Explicit" cannot say "a
-- child": a person has to look at what there is to look at and decide whether
-- there is anything to refer. A hash match is not that. It says this exact
-- picture is one that has already been found, identified and hashed by the
-- people who do that work, and the decision in front of the operator is not
-- "is this something" but "report it now". A queue that cannot tell those two
-- rows apart makes the second one wait behind the first.
--
-- WHAT IS IN THE COLUMNS AND WHAT IS NOT. Whether it matched, and the names of
-- the lists that said so. NOT the hash: a hash is a handle on one specific
-- picture, this table is read by operators on ordinary screens, and there is
-- nothing an operator does with a hash. The service's tracking id is the thing
-- a referral quotes, and it goes on the review row below.
ALTER TABLE photo_quarantine
  ADD COLUMN IF NOT EXISTS hash_match boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS hash_sources text[] NOT NULL DEFAULT '{}';

-- The one read this adds: what matched, oldest first, ahead of everything
-- else in the queue.
CREATE INDEX IF NOT EXISTS photo_quarantine_hash_match_idx
  ON photo_quarantine (hash_match, status, created_at);

COMMENT ON COLUMN photo_quarantine.hash_match IS
  'True where the photo matched a known abuse-image hash. A machine did not guess at this row: the picture is one that was already identified. Referral is the next act, not triage.';
COMMENT ON COLUMN photo_quarantine.hash_sources IS
  'The names of the lists that held the matching hash. Never the hash itself.';

-- The matching service's own id for the call that answered. It is what a
-- referral to the ACCCE or the NCMEC quotes, and it is the only thing about
-- the match that is useful to anybody outside this system. NULL for every
-- review that did not come from a hash match, which is all of them so far.
ALTER TABLE safety_reviews
  ADD COLUMN IF NOT EXISTS tracking_id text;

COMMENT ON COLUMN safety_reviews.tracking_id IS
  'The hash-matching service''s tracking id for the call that answered, quoted in a referral. NULL on every review raised by the message classifier.';
