-- A tracking reference is a record, so it is kept where records cannot be
-- altered.
--
-- The terms promise that handover and return records, tracking numbers and
-- photos among them, are kept in a store that cannot be altered for ninety
-- days. Photos and the handover manifest already are: they go into the
-- Object-Lock evidence bucket. The two tracking references did not — they were
-- plain text columns on this table, and a column is a thing that can be
-- changed.
--
-- From here, every tracking reference is written into the evidence bucket as a
-- small JSON record the moment it is recorded, beside the manifest and under
-- the same settlement prefix. These two columns hold the KEY of that frozen
-- record. The reference columns beside them stay exactly as they were and stay
-- the fast read for every page and sweep; the object in the bucket is the
-- record of truth, and it is the one nobody can edit.
--
-- Nullable, and NULL is a normal reading: it means the reference predates this
-- migration, and nothing about the dispute roads depends on the key.
ALTER TABLE settlements
  ADD COLUMN IF NOT EXISTS delivery_tracking_key text,
  ADD COLUMN IF NOT EXISTS return_tracking_key   text;
