/**
 * The matching engine (0.F). Consumes 'card-published' messages, retrieves
 * candidates by pgvector cosine similarity over opposite-type cards, applies
 * the hard rules (matchRules.ts documents the full rule set and weights),
 * and creates matches / near-misses.
 *
 * Price bands are decrypted HERE and only here, per pair, with a WORM audit
 * line per decrypt operation - and nothing derived from a band ever leaves
 * this module except the boolean outcome folded into score/decision.
 */
import { getPool } from '../db.js';
import { decryptFields } from '../crypto.js';
import { embedCard } from './embeddings.js';
import {
  DEFAULT_GEO_RADIUS_KM,
  categoryCompatible,
  collectWindowMinutes,
  decide,
  evaluatePair,
  isGeohash,
  reachOf,
  type GeoBucket,
  type PriceBand,
} from './matchRules.js';
import type { CardRow } from './cards.js';
import { geoOf } from '../geo/normalise.js';
import type { Config } from '../config.js';

const CANDIDATE_LIMIT = 50;
/** How many prefiltered cards the pool count looks at before it says "at
 *  least this many" — enough to see starvation coming, cheap to run. */
const CANDIDATE_POOL_CAP = 500;
/** Slack on the geo box, in km: geo_radius_km is a `real`, and the box is
 *  meant to be generous. */
export const GEO_PREFILTER_SLACK_KM = 25;
const KM_PER_DEG_LAT = 111.32;
/**
 * Similarity first and alone - no account attribute can move a card up this
 * list. created_at breaks the tie, newest first: identical embeddings (a
 * category of near-clones) would otherwise come back in whatever order the
 * index felt like, and a fresh counterpart could sit behind a month of them.
 */
export const CANDIDATE_ORDER = 'c.embedding <=> $14::vector, c.created_at DESC';

interface CandidateRow extends CardRow {
  account_is_business: boolean;
  data_key_enc: Buffer;
  similarity: number;
  threshold_bump: number;
  agent_seen_recently: boolean;
}

async function loadSourceCard(cardId: string): Promise<(CardRow & {
  data_key_enc: Buffer;
  account_is_business: boolean;
  agent_seen_recently: boolean;
  threshold_bump: number;
  embedding_text: string | null;
}) | undefined> {
  const r = await getPool().query(
    `SELECT c.*, c.embedding::text AS embedding_text, a.data_key_enc, a.is_business AS account_is_business,
            COALESCE(rep.threshold_bump, 0) AS threshold_bump,
            EXISTS (SELECT 1 FROM oauth_tokens t
                    WHERE t.account_id = c.account_id AND t.kind IN ('access','api-key')
                      AND NOT t.revoked AND NOT t.suspended AND t.expires_at > now()
                      AND t.last_used_at > now() - interval '1 hour') AS agent_seen_recently
     FROM cards c
     JOIN accounts a ON a.id = c.account_id
     LEFT JOIN reputation rep ON rep.account_id = c.account_id
     WHERE c.id = $1`,
    [cardId],
  );
  return r.rows[0];
}

// ---------------------------------------------------------------------------
// The candidate prefilter.
//
// Retrieval used to be "the 50 nearest opposite-type cards by cosine
// distance", and nothing else. That starves the moment one category fills up:
// a board holding hundreds of near-identical cards answers every query with
// the same hundred, all at the same distance, and the card that is genuinely
// the other half of the pair never makes the 50. Dev found it first, on a
// pile of fixture leftovers, but there is nothing peculiar to dev about it —
// any dense category gets there.
//
// So the 50 are drawn from cards that could pass the hard rules rather than
// from the whole board. Both filters below are STRICTLY CONSERVATIVE: a pair
// the rules would accept is never filtered out. The rules themselves still
// run afterwards, in evaluatePair, unchanged.
//
// CATEGORY. evaluatePair's first hard rule is categoryCompatible - equal,
// ancestor or descendant, and nothing else - so this clause is that rule
// rather than an approximation of it. No threshold arithmetic is needed to
// justify it: an incompatible pair never gets a score to compare against
// 0.75, it is refused outright. (Worth writing down, since the weights say
// otherwise on their own: category carries 0.20, so a pair perfect on
// everything else would reach 0.55 + 0.15 + 0.10 = 0.80 with category at 0,
// clear of the 0.75 threshold. It is the hard rule, not the weight, that
// makes a same-tree restriction safe - and it is also why "same top-level
// segment" would be far too loose a filter to be worth writing.)
//
// GEO. evaluateGeo has three shapes, and the clause keeps a candidate under
// any of them:
//   - either side reaching 'country' or 'anywhere': kept. The mutual-reach
//     test is subtler than a WHERE should be, and cards saying it are rare.
//   - both radius-bound, both placed: kept when the candidate's centre falls
//     inside a lat/lon BOX around the source's centre, sized to the sum of
//     the two radii plus slack. A box is a superset of the circle the rule
//     actually uses, so it cannot exclude a pair that would meet.
//   - either side unplaced: the pre-0.3.0 string comparison is all the rule
//     has, so the clause is that comparison - same bucket, or one bucket a
//     prefix of the other (and a geohash-shaped bucket stays in for a
//     geohash-shaped source, where the rule decodes both and measures).
// ---------------------------------------------------------------------------

/** The candidate side of the prefilter, as the SQL sees it. */
export interface PrefilterCandidate {
  category: string;
  geo?: { bucket?: string; radius_km?: number; reach?: string | null } | null;
  geo_lat?: number | null;
  geo_lon?: number | null;
  geo_radius_km?: number | null;
}

export interface PrefilterSource {
  category: string;
  geo: GeoBucket;
}

/** Degrees of longitude per km at the far edge of the source's own reach:
 *  cos shrinks toward the poles, so the box is sized on the WORST latitude a
 *  candidate inside it could sit at, never on the source's own. */
function degPerKm(lat: number, radiusKm: number): { perLat: number; perLon: number } {
  const MAX_RADIUS_KM = 500; // the protocol's ceiling on a card's own radius
  const spanDeg = (radiusKm + MAX_RADIUS_KM + GEO_PREFILTER_SLACK_KM) / KM_PER_DEG_LAT;
  const guardLat = Math.min(89, Math.abs(lat) + spanDeg);
  const cos = Math.max(Math.cos((guardLat * Math.PI) / 180), 0.02);
  return { perLat: 1 / KM_PER_DEG_LAT, perLon: 1 / (KM_PER_DEG_LAT * cos) };
}

/**
 * The prefilter as a predicate — the same rule the SQL clause below encodes,
 * in the one place a test can read it and the engine can check itself
 * against. The engine filters in Postgres (the whole point is to filter
 * BEFORE the limit); this runs over what came back, and a disagreement is
 * logged as drift rather than silently changing what matches.
 */
export function prefilterKeeps(source: PrefilterSource, cand: PrefilterCandidate): boolean {
  if (!categoryCompatible(source.category, cand.category)) return false;
  const candGeo: GeoBucket = {
    bucket: cand.geo?.bucket ?? '',
    radius_km: cand.geo_radius_km ?? cand.geo?.radius_km ?? undefined,
    lat: cand.geo_lat ?? null,
    lon: cand.geo_lon ?? null,
    reach: (cand.geo?.reach as GeoBucket['reach']) ?? null,
  };
  if (reachOf(source.geo) !== 'radius' || reachOf(candGeo) !== 'radius') return true;

  const sLat = source.geo.lat;
  const sLon = source.geo.lon;
  const cLat = candGeo.lat;
  const cLon = candGeo.lon;
  const placed =
    typeof sLat === 'number' &&
    typeof sLon === 'number' &&
    typeof cLat === 'number' &&
    typeof cLon === 'number';
  if (placed) {
    const span =
      (source.geo.radius_km ?? DEFAULT_GEO_RADIUS_KM) +
      (candGeo.radius_km ?? DEFAULT_GEO_RADIUS_KM) +
      GEO_PREFILTER_SLACK_KM;
    const { perLat, perLon } = degPerKm(sLat, source.geo.radius_km ?? DEFAULT_GEO_RADIUS_KM);
    const dLon = Math.abs(cLon - sLon);
    return (
      Math.abs(cLat - sLat) <= span * perLat && Math.min(dLon, 360 - dLon) <= span * perLon
    );
  }
  // Unplaced on at least one side: the string comparison is the whole rule.
  const sb = source.geo.bucket ?? '';
  const cb = candGeo.bucket ?? '';
  if (sb === cb) return true;
  if (sb && cb && (cb.startsWith(sb) || sb.startsWith(cb))) return true;
  return !!sb && !!cb && isGeohash(sb) && isGeohash(cb);
}

/**
 * The WHERE clause every candidate must satisfy, and its parameters. Shared
 * by the retrieval query and the pool count so the two can never drift.
 * Parameters are $1..$13; the retrieval query appends the embedding as $14.
 */
function candidateWhere(source: {
  account_id: string;
  type: string;
  category: string;
  geo: GeoBucket;
}): { sql: string; params: any[] } {
  const opposite = source.type === 'WANT' ? 'HAVE' : 'WANT';
  const lat = typeof source.geo.lat === 'number' ? source.geo.lat : null;
  const lon = typeof source.geo.lon === 'number' ? source.geo.lon : null;
  const radius = source.geo.radius_km ?? DEFAULT_GEO_RADIUS_KM;
  const { perLat, perLon } = degPerKm(lat ?? 0, radius);
  const bucket = source.geo.bucket ?? '';
  const params = [
    opposite, // $1
    source.account_id, // $2
    source.category, // $3
    reachOf(source.geo) !== 'radius', // $4
    lat, // $5
    lon, // $6
    radius, // $7
    perLat, // $8
    perLon, // $9
    GEO_PREFILTER_SLACK_KM, // $10
    DEFAULT_GEO_RADIUS_KM, // $11
    bucket, // $12
    !!bucket && isGeohash(bucket), // $13
  ];
  const span = `($7::float8
                 + COALESCE(c.geo_radius_km::float8, (c.geo->>'radius_km')::float8, $11::float8)
                 + $10::float8)`;
  const sql = `c.type = $1::text
       AND c.lifecycle_state = 'PUBLISHED'
       AND c.expires_at > now()
       AND NOT c.paused_by_kill_switch
       AND c.embedding IS NOT NULL
       AND c.account_id <> $2::uuid
       AND a.status = 'active'
       AND NOT EXISTS (SELECT 1 FROM match_mutes mm
                       WHERE (mm.account_id = c.account_id AND mm.muted_account = $2::uuid)
                          OR (mm.account_id = $2::uuid AND mm.muted_account = c.account_id))
       -- category: equal, ancestor or descendant (the hard rule, in SQL)
       AND (c.category = $3::text
            OR left(c.category, length($3::text) + 1) = $3::text || '.'
            OR left($3::text, length(c.category) + 1) = c.category || '.')
       -- geo: keep everything the reach rule could possibly let through
       AND (
         $4::boolean
         OR COALESCE(c.geo->>'reach', 'radius') <> 'radius'
         OR (
           $5::float8 IS NOT NULL AND c.geo_lat IS NOT NULL AND c.geo_lon IS NOT NULL
           AND abs(c.geo_lat::float8 - $5::float8) <= ${span} * $8::float8
           AND LEAST(abs(c.geo_lon::float8 - $6::float8),
                     360 - abs(c.geo_lon::float8 - $6::float8)) <= ${span} * $9::float8
         )
         OR (
           ($5::float8 IS NULL OR c.geo_lat IS NULL OR c.geo_lon IS NULL)
           AND (
             COALESCE(c.geo->>'bucket', '') = $12::text
             OR ($12::text <> '' AND left(COALESCE(c.geo->>'bucket', ''), length($12::text)) = $12::text)
             OR (COALESCE(c.geo->>'bucket', '') <> ''
                 AND left($12::text, length(c.geo->>'bucket')) = c.geo->>'bucket')
             OR ($13::boolean AND lower(COALESCE(c.geo->>'bucket', '')) ~ '^[0-9bcdefghjkmnpqrstuvwxyz]{2,12}$')
           )
         )
       )`;
  return { sql, params };
}

/**
 * Candidate retrieval: the nearest opposite-type PUBLISHED cards by cosine
 * distance, drawn from the cards the hard rules could accept (see the
 * prefilter note above). Latent cards ARE candidates ("back pocket" intent
 * surfaces when a real match appears); cards paused by a kill switch are NOT.
 * Muted account pairs are excluded in SQL so a muted counterparty never even
 * reaches scoring. Similarity is still the ONLY ranking input - no account
 * attribute can move a card up this list (no paid ranking) - with the card's
 * age as the tie-break, newest first, so a pile of identical embeddings
 * cannot shadow a fresher counterpart by whatever order the heap hands back.
 *
 * ONE THING TO WATCH. A filtered query ordered by vector distance can be
 * answered two ways: an exact sort over the filtered rows (what the planner
 * chooses today, in milliseconds, because the prefilter leaves so few), or an
 * approximate walk of the HNSW index with the filter applied to what it finds
 * — and the second can hand back fewer rows than the limit, or none at all,
 * with no error. If the board grows enough for the planner to switch, the
 * lever is pgvector 0.8's `hnsw.iterative_scan` (with `hnsw.ef_search` at
 * least the limit), set for the transaction this query runs in. The pool
 * count below is how anyone would notice: a healthy pool beside an evaluated
 * count of zero is that failure, and nothing else looks like it.
 */
async function retrieveCandidates(source: {
  id: string;
  account_id: string;
  type: string;
  category: string;
  geo: GeoBucket;
  embedding_text: string;
}): Promise<CandidateRow[]> {
  const w = candidateWhere(source);
  const r = await getPool().query(
    `SELECT c.*, a.data_key_enc, a.is_business AS account_is_business,
            COALESCE(rep.threshold_bump, 0) AS threshold_bump,
            1 - (c.embedding <=> $14::vector) AS similarity,
            EXISTS (SELECT 1 FROM oauth_tokens t
                    WHERE t.account_id = c.account_id AND t.kind IN ('access','api-key')
                      AND NOT t.revoked AND NOT t.suspended AND t.expires_at > now()
                      AND t.last_used_at > now() - interval '1 hour') AS agent_seen_recently
     FROM cards c
     JOIN accounts a ON a.id = c.account_id
     LEFT JOIN reputation rep ON rep.account_id = c.account_id
     WHERE ${w.sql}
     ORDER BY ${CANDIDATE_ORDER}
     LIMIT ${CANDIDATE_LIMIT}`,
    [...w.params, source.embedding_text],
  );
  return r.rows;
}

/**
 * How many cards passed the prefilter, counted up to a cap. The number the
 * matcher logs: a pool of 3 explains a run that found nothing, and a pool
 * pinned at the cap says a category is filling up faster than 50 slots.
 */
async function countCandidatePool(source: {
  account_id: string;
  type: string;
  category: string;
  geo: GeoBucket;
}): Promise<{ pool: number; capped: boolean }> {
  const w = candidateWhere(source);
  const r = await getPool().query(
    `SELECT count(*)::int AS n FROM (
       SELECT 1 FROM cards c
       JOIN accounts a ON a.id = c.account_id
       WHERE ${w.sql}
       LIMIT ${CANDIDATE_POOL_CAP}
     ) t`,
    w.params,
  );
  const pool = Number(r.rows[0]?.n ?? 0);
  return { pool, capped: pool >= CANDIDATE_POOL_CAP };
}

/** Exported for the unit tests: the query the engine actually issues. */
export function candidateQueryShape(source: {
  account_id: string;
  type: string;
  category: string;
  geo: GeoBucket;
}): { where: string; params: any[]; order: string; limit: number; poolCap: number } {
  const w = candidateWhere(source);
  return {
    where: w.sql,
    params: w.params,
    order: CANDIDATE_ORDER,
    limit: CANDIDATE_LIMIT,
    poolCap: CANDIDATE_POOL_CAP,
  };
}

async function decryptBand(
  card: { id: string; account_id: string; price_enc: Buffer | null },
  dataKeyEnc: Buffer,
  counterCardId: string,
): Promise<PriceBand | undefined> {
  if (!card.price_enc) return undefined;
  const f = await decryptFields(
    card.account_id,
    dataKeyEnc,
    { price: card.price_enc },
    {
      purpose: 'matching-price-band',
      actor: 'system',
      refs: { card_id: card.id, evaluated_against: counterCardId },
    },
  );
  return JSON.parse(f.price) as PriceBand;
}

/** urgency='today' only matches counterparties fast enough to matter. */
function urgencyRouted(
  a: { urgency: string },
  counterpart: { account_is_business: boolean; agent_seen_recently: boolean },
): boolean {
  if (a.urgency !== 'today') return true;
  return counterpart.account_is_business || counterpart.agent_seen_recently;
}

export interface MatchingOutcome {
  matchesCreated: string[];
  nearMisses: number;
  evaluated: number;
  /** How many cards passed the prefilter, counted to CANDIDATE_POOL_CAP. */
  candidatePool: number;
  /** True when the count stopped at the cap: the pool is at least that big. */
  candidatePoolCapped: boolean;
}

export async function runMatchingForCard(
  cfg: Config,
  cardId: string,
  log: (msg: string, extra?: any) => void,
): Promise<MatchingOutcome | undefined> {
  const source = await loadSourceCard(cardId);
  if (!source) {
    log('matcher: card vanished', { card_id: cardId });
    return undefined;
  }
  if (
    source.lifecycle_state !== 'PUBLISHED' ||
    new Date(source.expires_at) < new Date() ||
    (source as any).paused_by_kill_switch
  ) {
    log('matcher: card not matchable', { card_id: cardId, state: source.lifecycle_state });
    return undefined;
  }
  // A published card without an embedding (backfill race) is embedded here -
  // same code path, same projection. If Bedrock fails the message redelivers.
  if (!source.embedding_text) {
    await embedCard(cfg, source);
    const reloaded = await loadSourceCard(cardId);
    if (!reloaded?.embedding_text) throw new Error(`embedding write failed for ${cardId}`);
    source.embedding_text = reloaded.embedding_text;
  }

  const sourceGeo = geoOf(source);
  const prefilterSource = { ...(source as any), geo: sourceGeo } as any;
  const [candidates, pool] = await Promise.all([
    retrieveCandidates(prefilterSource),
    countCandidatePool(prefilterSource),
  ]);
  const sourceIsWant = source.type === 'WANT';

  // Source band decrypted at most once per run.
  let sourceBand: PriceBand | undefined | 'unloaded' = 'unloaded';

  const outcome: MatchingOutcome = {
    matchesCreated: [],
    nearMisses: 0,
    evaluated: 0,
    candidatePool: pool.pool,
    candidatePoolCapped: pool.capped,
  };
  const touchedCards = new Set<string>();

  for (const cand of candidates) {
    outcome.evaluated++;
    // The SQL prefilter and prefilterKeeps are one rule written twice, once
    // for Postgres and once for us. If they ever disagree, say so: a silent
    // divergence here is exactly the bug the prefilter exists to fix.
    if (!prefilterKeeps({ category: source.category, geo: sourceGeo }, cand)) {
      log('matcher: prefilter drift', { card_id: cardId, candidate_id: cand.id });
    }
    // Cheap hard rules first; price bands are only decrypted for survivors.
    if (!urgencyRouted(source, cand) || !urgencyRouted(cand, source)) continue;

    const want = sourceIsWant ? source : cand;
    const have = sourceIsWant ? cand : source;

    const pre = evaluatePair({
      semantic: Number(cand.similarity),
      categoryA: source.category,
      categoryB: cand.category,
      geoA: geoOf(source),
      geoB: geoOf(cand),
      // bands withheld: category/geo hard rules run without any decrypt
    });
    if (!pre.hardRulesPass) continue;

    if (sourceBand === 'unloaded') {
      sourceBand = await decryptBand(source, source.data_key_enc, cand.id);
    }
    const candBand = await decryptBand(cand, cand.data_key_enc, source.id);
    const wantBand = sourceIsWant ? (sourceBand as PriceBand | undefined) : candBand;
    const haveBand = sourceIsWant ? candBand : (sourceBand as PriceBand | undefined);

    const evaled = evaluatePair({
      semantic: Number(cand.similarity),
      categoryA: source.category,
      categoryB: cand.category,
      geoA: geoOf(source),
      geoB: geoOf(cand),
      wantBand,
      haveBand,
    });
    if (!evaled.hardRulesPass) continue;

    const bumpWant = Number(sourceIsWant ? source.threshold_bump : cand.threshold_bump);
    const bumpHave = Number(sourceIsWant ? cand.threshold_bump : source.threshold_bump);
    const decision = decide(evaled.score, bumpWant, bumpHave);

    if (decision === 'match') {
      const ins = await getPool().query(
        `INSERT INTO matches (card_want, card_have, account_want, account_have, score, category)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (card_want, card_have) DO NOTHING
         RETURNING id`,
        [want.id, have.id, want.account_id, have.account_id, evaled.score, want.category],
      );
      if (ins.rows[0]) {
        outcome.matchesCreated.push(ins.rows[0].id as string);
        touchedCards.add(want.id);
        touchedCards.add(have.id);
        log('matcher: match created', {
          match_id: ins.rows[0].id,
          score: Number(evaled.score.toFixed(4)),
          category: want.category,
        });
      }
    } else if (decision === 'near-miss') {
      await getPool().query(
        `INSERT INTO near_misses (card_want, card_have, score, category)
         VALUES ($1,$2,$3,$4) ON CONFLICT (card_want, card_have) DO NOTHING`,
        [want.id, have.id, evaled.score, want.category],
      );
      outcome.nearMisses++;
    }
  }

  if (touchedCards.size) await stampContestedWindows([...touchedCards]);
  return outcome;
}

/**
 * Contested matches -> collection window. A card that now has >= 2
 * concurrently-open matches becomes the CONTESTED (holder) side: its
 * collection window opens once (collect_until stamped) and never reopens
 * after it closes. Window length: 15 min for urgency='today', else 6h,
 * further shortened by the card's own collect_window_minutes override.
 * The stamp is a single conditional UPDATE, so concurrent workers cannot
 * double-open or re-open a window.
 */
export async function stampContestedWindows(cardIds: string[]): Promise<void> {
  await getPool().query(
    `UPDATE cards c SET
        collect_until = now() + make_interval(mins => LEAST(
          COALESCE(c.collect_window_minutes, 100000),
          CASE WHEN c.urgency = 'today' THEN 15 ELSE 360 END)),
        updated_at = now()
     WHERE c.id = ANY($1::uuid[])
       AND c.collect_until IS NULL
       AND c.collect_closed_at IS NULL
       AND (SELECT count(*) FROM matches m
            WHERE (m.card_want = c.id OR m.card_have = c.id) AND m.state = 'open') >= 2`,
    [cardIds],
  );
}

// Re-export so the window constants live in one place for callers.
export { collectWindowMinutes };
