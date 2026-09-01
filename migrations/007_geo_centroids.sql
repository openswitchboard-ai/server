-- OpenSwitchboard location handling (0.3.0 protocol).
--
-- A card used to carry only a bucket string, invented by whichever agent
-- wrote it: "canberra", "AU-ACT", "AU", a geohash. Two people in one city
-- missed each other because the two strings were unequal.
--
-- Cards now carry the point their location resolves to, and matching compares
-- the distance between two points against the sum of the two radii. The
-- resolution itself happens in the server (src/geo), against a gazetteer
-- baked into the image, so these columns are filled on publish and on amend.
--
-- geo_lat / geo_lon stay NULL for a bucket the gazetteer cannot place. Those
-- cards fall back to the pre-0.3.0 comparison (same bucket, or one bucket a
-- prefix of the other). Existing rows are placed by the 'backfill-geo' op,
-- which re-runs the same normalisation the publish path uses.
ALTER TABLE cards
  ADD COLUMN IF NOT EXISTS geo_lat       double precision,
  ADD COLUMN IF NOT EXISTS geo_lon       double precision,
  ADD COLUMN IF NOT EXISTS geo_radius_km real;

-- Candidate retrieval already orders by embedding distance; this index serves
-- the backfill sweep and any operator query over unplaced cards.
CREATE INDEX IF NOT EXISTS cards_geo_unplaced_idx
  ON cards (created_at) WHERE geo_lat IS NULL;
