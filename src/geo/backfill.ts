/**
 * Placement of cards written before 0.3.0. Idempotent: a card is touched
 * once, because placing it fills the very column the sweep selects on.
 *
 * Every card whose centre point is still unknown goes back through the same
 * normalisation the publish path runs. A geohash bucket decodes to the centre
 * of its cell; an invented bucket the gazetteer recognises ("canberra",
 * "AU-ACT", "AU") resolves the same way a `place` would, and the card keeps
 * the string as its place while gaining the canonical cell. A bucket nothing
 * answers to keeps its string with no centre point, and meets only cards
 * carrying the same string — a compatibility shim for the cards that predate
 * this change, never a softened path for new ones.
 *
 * The sweep is bounded so one run always finishes well inside the ops queue's
 * visibility window, and it pages forward on a cursor. Paging on a cursor
 * rather than re-selecting the unplaced matters: a card the gazetteer cannot
 * answer for stays unplaced forever, so a sweep that kept re-reading the same
 * unplaced rows would never move.
 */
import { getPool } from '../db.js';
import { normaliseGeo } from './normalise.js';

/** Cards per run. One pass is a few hundred small UPDATEs. */
export const BACKFILL_BATCH = 500;

/** Where the previous pass stopped. */
export interface BackfillCursor {
  created_at: string;
  id: string;
}

export interface BackfillOutcome {
  /** Cards that gained a centre point in this pass. */
  placed: string[];
  /** Cards whose bucket answers to nothing in the gazetteer. */
  unplaced: number;
  /** Cards whose location the current rules would refuse outright. */
  refused: number;
  /** Pass this back to continue; null when the sweep is done. */
  next: BackfillCursor | null;
}

export async function backfillCardGeo(
  log: (msg: string, extra?: any) => void = () => {},
  after?: BackfillCursor,
  batch = BACKFILL_BATCH,
): Promise<BackfillOutcome> {
  const rows = await getPool().query(
    `SELECT id, geo, created_at FROM cards
      WHERE geo_lat IS NULL
        AND ($2::timestamptz IS NULL OR (created_at, id) > ($2::timestamptz, $3::uuid))
      ORDER BY created_at, id LIMIT $1`,
    [batch, after?.created_at ?? null, after?.id ?? null],
  );
  const last = rows.rows[rows.rows.length - 1];
  const outcome: BackfillOutcome = {
    placed: [],
    unplaced: 0,
    refused: 0,
    next:
      rows.rowCount === batch && last
        ? { created_at: new Date(last.created_at).toISOString(), id: last.id }
        : null,
  };
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
    outcome.placed.push(row.id);
    log('backfill-geo: card placed', {
      card_id: row.id,
      place: normalised.geo.place ?? null,
      bucket: normalised.geo.bucket,
      resolved: normalised.resolved?.name ?? null,
    });
  }
  return outcome;
}
