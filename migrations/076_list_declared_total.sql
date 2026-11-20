-- A LIST'S DECLARED TOTAL (20 November 2026; src/domain/lists.ts, manual v97).
--
-- In rehearsal, assistants posting a long hand-over in several calls lost
-- items between calls and told their human the whole of it was up. Now
-- publish_list takes `total_items`, how many items the human handed over,
-- counted before anything is sent, on the call that creates a list and on
-- part 1 of a replace. The list keeps it, and counts every line sent to it
-- since (lines turned away included: each of those is already answered on its
-- own line), so every answer, and the list's line in read_lists, can say how
-- many are still to send. A checksum the switchboard reports and never
-- enforces: nothing is refused for being short or over.
--
--   expected_items  the declared total; NULL where none was given. Part 1 of a
--                   replace sets it again (to NULL where that call gives none).
--   items_received  the lines sent to the list since it went up, or since
--                   part 1 of the latest replace.
ALTER TABLE lists ADD COLUMN IF NOT EXISTS expected_items integer
  CHECK (expected_items IS NULL OR expected_items BETWEEN 1 AND 10000);
ALTER TABLE lists ADD COLUMN IF NOT EXISTS items_received integer NOT NULL DEFAULT 0
  CHECK (items_received >= 0);

COMMENT ON COLUMN lists.expected_items IS
  'How many items the human handed over, as the assistant declared it (publish_list total_items). Advisory: reported, never enforced (src/domain/lists.ts).';
COMMENT ON COLUMN lists.items_received IS
  'Lines sent to the list since it went up or since part 1 of the latest replace, refused lines included (src/domain/lists.ts).';
