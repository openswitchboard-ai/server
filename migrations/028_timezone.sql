-- The human's time zone (phase 1.G)
--
-- Every timestamp the switchboard keeps is UTC, and every timestamp it hands
-- an agent was UTC with nothing beside it. In the 12 September rehearsal an
-- assistant read a have posted at 15:58 local with a one-day life as "expired
-- today" at ten in the morning, because it did the sum by date.
--
-- The zone is an IANA name ('Australia/Sydney'), recorded silently from the
-- browser on the onboarding page and editable on the settings page. It is a
-- preference, so no consent event: it names no person and shares nothing.
-- With it known, the sweep tells the agent the local time now and the zone,
-- a want or have marked "today" ends at the end of the human's day rather
-- than 24 hours later, and the close of a collection window can be said in
-- the human's own clock. NULL means never captured, and everything falls back
-- to the UTC behaviour it had before.
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS timezone text;
