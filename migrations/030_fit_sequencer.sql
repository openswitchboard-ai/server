-- The fit sequencer: a line, slots, and the two ways to sell (phase 1.H)
--
-- What this replaces. When a second person came forward on the same thing,
-- the holder's want or have entered a short collection window: everybody was
-- introduced at once, the holder could talk to all of them and commit to none
-- of them until the clock ran out, and the third and fourth arrivals landed on
-- top of that. It solved the wrong problem. Nobody wants to run an auction
-- they did not ask for; what a person wants is to meet one person who fits,
-- settle it, and meet the next one only if that came to nothing.
--
-- So every open want and every open have now holds a LINE of candidate
-- introductions and a number of SLOTS. Only the introductions in a slot are
-- live: they surface on the holder's sweep, and interest, the names step, the
-- conversation and any figure all run on them. The rest are in line — rows
-- that exist, are not surfaced to the holder at all, and tell the other side
-- one sentence and nothing else. No count, no position: the ban on scarcity
-- theatre is exactly as it was.
--
-- Nothing blocks the holder any more. The collect_until / collect_closed_at /
-- collect_window_minutes columns below are NOT dropped — old rows still carry
-- them, and the 'collection-close' value stays in the approval_links check
-- constraint so a link minted before this deploy can still be read — but
-- nothing mints or reads them from here on.
--
--   matches.live            in a slot right now. The sequencer writes it.
--   matches.live_at         when it went live, for the record.
--   matches.last_movement_at any interest, names step, message or figure from
--                           either side resets this. A live introduction that
--                           shows no movement inside its slot's length lapses:
--                           archived_via 'lapsed', both sides told in a
--                           sentence, and the next in line goes live.
--   matches.limits_overlap  whether the two sealed limits meet, as a yes or a
--                           no. Computed inside the matcher, where the bands
--                           are already decrypted, and stored as a BOOLEAN so
--                           the sequencer can rank on it without any figure
--                           leaving the engine.
--   matches.clears_ask_25   whether the want's sealed ceiling clears the
--                           have's ask by a quarter or more. The same shape
--                           and the same reason: it feeds the underpricing
--                           note, which says "you may be asking too little"
--                           and never a number.
--
--   cards.slots             1-10, the human's own word for how many people
--                           this can take at once. Default 1.
--   cards.sale              'straight' or 'best-offer' on a have.
--   cards.gather_until      best offer only: when the gathering window closes.
--   cards.gather_closed_at  stamped once the close has been processed, so the
--                           numbers are revealed and the non-bidders filed
--                           away exactly once.
--   cards.price_note_at     when the underpricing note last went to the
--                           holder, so it goes once per have and no oftener.
--
-- Existing open introductions are live: they were already surfaced, and a
-- deploy is not a reason to take somebody's introduction away.

ALTER TABLE matches
  ADD COLUMN IF NOT EXISTS live             boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS live_at          timestamptz,
  ADD COLUMN IF NOT EXISTS last_movement_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS limits_overlap   boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS clears_ask_25    boolean NOT NULL DEFAULT false;

UPDATE matches
   SET live = true, live_at = COALESCE(live_at, created_at)
 WHERE state = 'open' AND NOT live;

CREATE INDEX IF NOT EXISTS matches_live_idx ON matches (live, state, last_movement_at);

ALTER TABLE cards
  ADD COLUMN IF NOT EXISTS slots          smallint NOT NULL DEFAULT 1
    CHECK (slots BETWEEN 1 AND 10),
  ADD COLUMN IF NOT EXISTS sale           text NOT NULL DEFAULT 'straight'
    CHECK (sale IN ('straight','best-offer')),
  ADD COLUMN IF NOT EXISTS gather_until     timestamptz,
  ADD COLUMN IF NOT EXISTS gather_closed_at timestamptz,
  ADD COLUMN IF NOT EXISTS price_note_at    timestamptz;

CREATE INDEX IF NOT EXISTS cards_gather_until_idx ON cards (gather_until)
  WHERE gather_until IS NOT NULL AND gather_closed_at IS NULL;

COMMENT ON COLUMN cards.collect_until IS
  'Unused from migration 030. The collection window is gone; old rows keep their stamp.';
COMMENT ON COLUMN cards.collect_closed_at IS
  'Unused from migration 030. The collection window is gone; old rows keep their stamp.';
COMMENT ON COLUMN cards.collect_window_minutes IS
  'Unused from migration 030. The collection window is gone; old rows keep their override.';
