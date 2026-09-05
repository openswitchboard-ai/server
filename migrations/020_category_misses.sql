-- What the taxonomy was asked for and did not have (demand-driven taxonomy)
--
-- The category gate is absolute: a card naming a node the taxonomy does not
-- open is refused with CATEGORY_PROHIBITED, and the switchboard names up to
-- three of the closest open nodes as a courtesy. That refusal is correct, and
-- nothing here changes it. What was missing is the other half — the demand
-- signal. Every refusal is a person, through their agent, saying "this is the
-- errand I actually have", and until now the only trace it left was an error
-- an agent read once and discarded. The taxonomy could only grow by someone
-- guessing what was absent from it.
--
-- So each refusal parks a row: the string that was asked for, the nodes we
-- offered instead, and who asked. Read back grouped by `requested`, it is a
-- ranked list of the categories people keep reaching for and not finding —
-- which is exactly the input to deciding what the next taxonomy release
-- should contain.
--
-- WHAT THIS ROW IS NOT. It is not a card and it is not content: no geo, no
-- attributes, no price, no free text of any kind beyond the category path the
-- agent typed. Category paths are a closed-ish vocabulary by construction (the
-- schema constrains their shape), so this is the thinnest thing that can
-- answer "what is missing".
--
-- account_id is here so a single agent looping on one bad string cannot look
-- like a hundred people wanting a new node — the digest can count distinct
-- accounts when that question matters. It carries no ON DELETE behaviour
-- beyond the plain reference the neighbouring tables use.
--
-- WRITING HERE IS BEST-EFFORT. The insert sits inside a try/catch in
-- domain/categoryMisses.ts: a logging failure must never change the error the
-- agent gets back, because the refusal is a taxonomy decision and a full disk
-- is not allowed a vote in it.
CREATE TABLE IF NOT EXISTS category_misses (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The category path the agent asked for, exactly as it arrived.
  requested   text NOT NULL,
  -- The open nodes the refusal offered instead, nearest first. Empty when the
  -- suggester had nothing to say (it is a courtesy and may return none).
  suggestions text[],
  account_id  uuid NOT NULL REFERENCES accounts(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- The only read: misses in the last N days, grouped by what was asked for.
CREATE INDEX IF NOT EXISTS category_misses_requested_idx
  ON category_misses (requested, created_at);
