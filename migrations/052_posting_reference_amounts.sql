-- THE COLUMN 051 WOULD HAVE CARRIED, HAD IT NOT ALREADY RUN.
--
-- 051 shipped keying the whole of "have I asked this?" on the reference and
-- nothing else, which spent a safety property nobody had asked for: an agent
-- asked about a $10 spring could send back a $400 bicycle under that same
-- reference and the figure read-back would be skipped. The correction puts the
-- AMOUNTS back beside the reference — the thing's NAME had to leave that key,
-- because other questions in the same flow ask the agent to change it, but the
-- amount never did.
--
-- The correction was written into 051 in place, on the belief that it had not
-- been applied anywhere. It had: it went to dev minutes earlier. Migrations are
-- recorded by FILE NAME (see migrate() in src/db.ts), so an amended 051 is a
-- file dev has already ticked off and will never read again, and the column
-- would have existed only in the repository. Hence this one.
--
-- Written so it does not care which of the two 051s a database got: IF NOT
-- EXISTS on a fresh database that already has the column, and the column
-- created on dev, which does not.

ALTER TABLE posting_references ADD COLUMN IF NOT EXISTS asked_amounts text;

COMMENT ON COLUMN posting_references.asked_amounts IS
  'The figures last read back on this attempt, as they were said to the human. The reference says which posting; this says what was confirmed on it, and the figure gate needs both: a changed number under the same reference is asked about again.';
