-- Place and reach are two different questions
--
-- A card has always named where the thing is, and `radius_km` was the only
-- answer it could give to "how far will you go". That works for a ladder
-- someone collects and not at all for a laptop someone would post: the seller
-- had to choose between a town the card could honestly sit in and a radius
-- that was a lie. So the card now carries a reach — within N km as before,
-- the whole of its own country, or anywhere — and the reach lives in the geo
-- JSONB alongside place and radius_km, defaulted to the old behaviour when it
-- is absent.
--
-- Reaching a country needs the card to know which country it is in, and until
-- now nothing stored that: the gazetteer knew, at resolve time, and the answer
-- was thrown away. geo_country is the ISO 3166-1 alpha-2 code of whatever the
-- place resolved to, written on publish and on amend.
--
-- NULL means the switchboard could not place the card — an invented bucket
-- nothing answers to, a card written before 0.3.0 and never swept. Those cards
-- keep radius behaviour whatever their reach says, because there is no country
-- to reach across. The 'backfill-geo' op fills the column for existing rows by
-- re-running the same normalisation the publish path uses.
ALTER TABLE cards ADD COLUMN IF NOT EXISTS geo_country text;

-- The backfill sweep selects on it, and an operator query over cards that
-- reach a whole country wants it too.
CREATE INDEX IF NOT EXISTS cards_geo_country_idx
  ON cards (geo_country) WHERE geo_country IS NOT NULL;
