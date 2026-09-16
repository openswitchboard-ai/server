-- `kind`: the AI's own words for the thing
-- (docs/taxonomy-question.md, and step 3 of docs/trust-and-safety.md)
--
-- The catalogue is a deny list now. A leaf it has never heard of goes up, so
-- long as the top level is open and nothing on the path is reserved, and what
-- used to come back as CATEGORY_PROHIBITED for an unknown node is an ordinary
-- posting instead.
--
-- That trade costs the switchboard its vocabulary. The taxonomy is where
-- "mountain bike" came from every time a sentence had to name the thing, and
-- for a leaf nobody has written down there is no word to lend. So the agent
-- supplies one: a short noun phrase in its own plain words, "vintage synth
-- repair", "bouldering partner". It is REQUIRED on a posting whose leaf the
-- taxonomy does not know and kept on any posting that offers it, because a
-- human's own word for the thing is better than a catalogue heading even when
-- the catalogue has one.
--
-- NULL means the posting never gave one, which is every row written before
-- today and every later row filed under a leaf the taxonomy does know. The
-- sentences fall back to the taxonomy exactly as they did.
ALTER TABLE cards ADD COLUMN IF NOT EXISTS kind text;

-- The same words on an introduction, beside the category it already copies.
-- Every sentence the sweep and the emails write names the thing, and they read
-- it off the introduction rather than the two postings behind it; the category
-- has been denormalised here since 001 for exactly that reason, and the word
-- for the thing travels with it or the sentences go back to reading slugs.
-- Taken from the WANT side, which is where `category` is taken from.
ALTER TABLE matches ADD COLUMN IF NOT EXISTS kind text;

-- And on the growth list. A row in category_misses used to be a refusal; it is
-- now a posting that went up under a name nobody has written down yet, and the
-- words its agent used for the thing are the part a taxonomy editor actually
-- reads. "services.repairs.vintage-synthesiser", posted eleven times, called
-- "vintage synth repair" by nine of them, is a leaf with its label already
-- written. NULL on every row from before today.
ALTER TABLE category_misses ADD COLUMN IF NOT EXISTS kind text;
