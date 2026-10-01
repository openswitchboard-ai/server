-- THE ONE QUESTION EVERY NEW ACCOUNT IS ASKED (founder, 1 October 2026;
-- src/domain/cards.ts supplyAskFor).
--
-- After an account's first posting, the answer hands the assistant one
-- question to put to its human, once per account ever: "Anything you'd lend,
-- give away or sell while we're here?"
--
--   supply_ask_at  when the question was handed over. Null until then. The
--                  publish path sets it in the same statement that decides to
--                  hand it over (UPDATE ... WHERE supply_ask_at IS NULL
--                  RETURNING), so it is handed over exactly once.
--
-- Accounts that have already posted more than once are past the moment, so
-- they are marked now and never asked. (An account with exactly one posting is
-- past it too: the publish path asks only on an account's earliest posting.)
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS supply_ask_at timestamptz;

UPDATE accounts a
   SET supply_ask_at = now()
 WHERE a.supply_ask_at IS NULL
   AND (SELECT count(*) FROM cards c WHERE c.account_id = a.id) > 1;
