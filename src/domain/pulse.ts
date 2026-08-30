/**
 * Demand-pulse aggregates: the data layer for 0.E digests and 0.G party
 * line/trends. INTERNAL ONLY in 0.F - the read API is this module (consumed
 * in-process by later phases); there is deliberately no HTTP route.
 *
 * K-ANONYMITY FLOOR (k >= 10, hard):
 *  - a (category, geo_bucket) cell is materialised ONLY when it holds at
 *    least K_ANON open cards (WANT + HAVE). Cells under the floor are
 *    ABSENT from the table - never zeroed, never rounded;
 *  - within a materialised row, matches_created and median_seconds_to_match
 *    are NULL unless the cell independently has >= K_ANON matches in the
 *    trailing 30 days (a small match count over a big card population would
 *    otherwise leak).
 * Counts are exact and real - the floor removes rows, it never fudges them.
 *
 * Cell definition: a card sits in the cell of its OWN (category, geo bucket).
 * A match is attributed to the cell of its WANT card (demand-oriented pulse),
 * and time-to-match is match.created_at - WANT card.created_at.
 */
import { getPool } from '../db.js';

export const K_ANON = 10;

/** Full rebuild, atomically, every 15 minutes (ops-queue 'pulse-refresh'). */
export async function refreshPulseAggregates(): Promise<number> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM pulse_aggregates');
    const r = await client.query(
      `WITH open_cards AS (
         SELECT category, geo->>'bucket' AS geo_bucket, type
         FROM cards
         WHERE lifecycle_state = 'PUBLISHED' AND expires_at > now()
           AND NOT paused_by_kill_switch
       ),
       cells AS (
         SELECT category, geo_bucket,
                count(*) FILTER (WHERE type = 'WANT')::int AS open_want_count,
                count(*) FILTER (WHERE type = 'HAVE')::int AS open_have_count
         FROM open_cards
         GROUP BY category, geo_bucket
       ),
       match_cells AS (
         SELECT w.category, w.geo->>'bucket' AS geo_bucket,
                count(*)::int AS matches_created,
                percentile_cont(0.5) WITHIN GROUP
                  (ORDER BY EXTRACT(EPOCH FROM (m.created_at - w.created_at)))
                  AS median_seconds_to_match
         FROM matches m JOIN cards w ON w.id = m.card_want
         WHERE m.created_at > now() - interval '30 days'
         GROUP BY w.category, w.geo->>'bucket'
       )
       INSERT INTO pulse_aggregates
         (category, geo_bucket, open_want_count, open_have_count,
          matches_created, median_seconds_to_match, computed_at)
       SELECT c.category, c.geo_bucket, c.open_want_count, c.open_have_count,
              CASE WHEN mc.matches_created >= ${K_ANON} THEN mc.matches_created END,
              CASE WHEN mc.matches_created >= ${K_ANON} THEN mc.median_seconds_to_match END,
              now()
       FROM cells c
       LEFT JOIN match_cells mc
         ON mc.category = c.category AND mc.geo_bucket = c.geo_bucket
       WHERE c.open_want_count + c.open_have_count >= ${K_ANON}`,
    );
    await client.query('COMMIT');
    return r.rowCount ?? 0;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export interface PulseRow {
  category: string;
  geo_bucket: string;
  open_want_count: number;
  open_have_count: number;
  matches_created: number | null;
  median_seconds_to_match: number | null;
  computed_at: Date;
}

/**
 * Internal read API. Every row returned already satisfies the k-floor by
 * construction (the refresh materialises nothing below it).
 */
export async function readPulse(filter?: {
  categoryPrefix?: string;
  geoBucket?: string;
  limit?: number;
}): Promise<PulseRow[]> {
  const clauses: string[] = [];
  const params: any[] = [];
  if (filter?.categoryPrefix) {
    params.push(`${filter.categoryPrefix}%`);
    clauses.push(`category LIKE $${params.length}`);
  }
  if (filter?.geoBucket) {
    params.push(filter.geoBucket);
    clauses.push(`geo_bucket = $${params.length}`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = Math.min(filter?.limit ?? 200, 1000);
  const r = await getPool().query(
    `SELECT * FROM pulse_aggregates ${where}
     ORDER BY open_want_count + open_have_count DESC LIMIT ${limit}`,
    params,
  );
  return r.rows;
}
