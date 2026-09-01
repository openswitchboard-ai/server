/**
 * One-shot, idempotent placement of cards written before 0.3.0.
 *
 * Every card whose centre point is still unknown goes back through the same
 * normalisation the publish path runs. A geohash bucket decodes to the centre
 * of its cell; an invented bucket the gazetteer recognises ("canberra",
 * "AU-ACT", "AU") resolves the same way a `place` would, and the card keeps
 * the string as its place while gaining the canonical cell. A bucket nothing
 * answers to keeps its string with no centre point, and meets only cards
 * carrying the same string — a compatibility shim for the cards that predate
 * this change, never a softened path for new ones.
 */
import { getPool } from '../db.js';
import { normaliseGeo } from './normalise.js';

export interface BackfillOutcome {
  placed: number;
  unplaced: number;
  refused: number;
}

export async function backfillCardGeo(
  log: (msg: string, extra?: any) => void = () => {},
): Promise<BackfillOutcome> {
  const rows = await getPool().query(
    `SELECT id, geo FROM cards WHERE geo_lat IS NULL ORDER BY created_at`,
  );
  const outcome: BackfillOutcome = { placed: 0, unplaced: 0, refused: 0 };
  for (const row of rows.rows as { id: string; geo: any }[]) {
    let normalised;
    try {
      normalised = normaliseGeo(row.geo);
    } catch (e: any) {
      // A stored card whose location the protocol would now refuse outright.
      // It keeps exactly what it has; an operator decides what to do with it.
      outcome.refused++;
      log('backfill-geo: card location refused by the current rules', {
        card_id: row.id,
        code: e?.payload?.code,
      });
      continue;
    }
    if (normalised.lat == null) {
      outcome.unplaced++;
      continue;
    }
    await getPool().query(
      `UPDATE cards SET geo = $2, geo_lat = $3, geo_lon = $4, geo_radius_km = $5,
              updated_at = now()
       WHERE id = $1`,
      [row.id, JSON.stringify(normalised.geo), normalised.lat, normalised.lon, normalised.radius_km],
    );
    outcome.placed++;
    log('backfill-geo: card placed', {
      card_id: row.id,
      place: normalised.geo.place ?? null,
      bucket: normalised.geo.bucket,
      resolved: normalised.resolved?.name ?? null,
    });
  }
  return outcome;
}
