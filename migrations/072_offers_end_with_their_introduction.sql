-- OFFERS END WITH THEIR INTRODUCTION (14 November 2026; src/domain/introductionEnds.ts).
--
-- Every way an introduction ends now closes the figures still open on it, in
-- the same statement that ends it. Until today only the seller choosing
-- somebody else on a best offer did, so a figure on a declined, archived,
-- lapsed or severed introduction stayed 'proposed' or 'awaiting-human' for the
-- rest of its month. Every accept already refused it (10 November 2026), but it
-- still counted as a number in a seller's best-offer result.
--
-- 1. WHICH STATE. No new one: 'withdrawn', off the table and nobody's verdict
--    on the figure. The protocol's offer states are a fixed list in the schema
--    package and have no "ended"; 'declined' would tell a buyer their number
--    was turned down when nobody looked at it. The CHECK on offers.state is
--    unchanged.
--
-- 2. closed_with_introduction says which withdrawals were the introduction
--    ending rather than the person who made the figure taking it back, so the
--    human's own page says "closed when this one ended" and never "you
--    withdrew it". It never crosses to an agent: the wire offer has no slot
--    for it.
ALTER TABLE offers
  ADD COLUMN IF NOT EXISTS closed_with_introduction boolean NOT NULL DEFAULT false;

-- 3. THE ONES ALREADY LEFT OPEN. Scoped strictly to introductions that have
--    already ended (every state but 'open' on the matches CHECK), and to
--    figures still on the table. An introduction that is open is never
--    touched, and an accepted figure is never touched. The moment it closed
--    is when its introduction ended, as near as the row can say, so a page
--    that tells the story of the match puts the step where it happened rather
--    than on the day this ran.
UPDATE offers o
   SET state = 'withdrawn',
       closed_with_introduction = true,
       updated_at = GREATEST(o.created_at, COALESCE(m.archived_at, m.severed_at, m.updated_at))
  FROM matches m
 WHERE m.id = o.match_id
   AND m.state IN ('declined', 'closed', 'archived')
   AND o.state IN ('proposed', 'awaiting-human');
