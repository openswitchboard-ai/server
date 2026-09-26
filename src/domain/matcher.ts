/**
 * The matching engine (0.F). Consumes 'card-published' messages, retrieves
 * candidates by pgvector cosine similarity over opposite-type cards — the
 * nearest on compatible shelves, and the nearest anywhere on the board, and on
 * the social shelves other wants as well (domain/swaps.ts) —
 * applies the hard rules (matchRules.ts documents the full rule set and
 * weights), puts each pair in a tier (matchTiers.ts), and creates sure and
 * possible introductions and near-misses.
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
  clearsAskWithRoom,
  evaluatePair,
  isGeohash,
  limitsOverlap,
  reachOf,
  type Ask,
  type GeoBucket,
  type PriceBand,
} from './matchRules.js';
import { resequenceCard } from './sequencer.js';
import {
  SWAP_TOP_LEVEL,
  isSwapPair,
  languageComplement,
  onLanguageExchange,
  swapCategory,
  swapKind,
  swapPairOrder,
  swapsOnShelf,
} from './swaps.js';
import { categoryDenied, categoryGate } from '../denylist.js';
import {
  CROSS_SHELF_TOP_N,
  POSSIBLE_PER_POSTING_PER_DAY,
  tierFor,
  type Tier,
} from './matchTiers.js';
import { jevEnabled } from '../shadow/jev.js';
import {
  JEV_PAIR_MIN_SCORE,
  shadowPairTrials,
  type JevPairCandidate,
} from '../shadow/jevTrials.js';
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
// CATEGORY. The shelf-gated retrieval's clause is categoryCompatible - equal,
// ancestor, descendant, or siblings under a shared parent that itself sits
// below the top level - written in SQL. Since 20 September 2026 it is no
// longer the only way in: retrieveSearched below brings the nearest postings
// from ANY shelf as well, and the shelf is weighed in the blend rather than
// deciding whether a pair is looked at (matchRules.ts, SHELF IS A
// CONTRIBUTOR; the tiers are in matchTiers.ts).
//
// WHAT ADMITTING SIBLINGS COSTS, honestly. Category carries 0.20 of the
// blend for a pair where both sides asserted a few attributes (0.35 where one
// side is thin — matchRules.ts, ASSERTION-SCALED WEIGHTS), and compatible
// pairs floor at 0.4 closeness, so the category component can no longer be
// read as a guarantee that the rest of the score has to carry the pair on its
// own. Take the rich blend, where semantic decides the most. A sibling pair
// is 0.7 closeness, or 0.14 of the blend; perfect on semantics, geo and price
// it reaches 0.55 + 0.14 + 0.15 + 0.10 = 0.94, and at semantic 0.9 it is
// about 0.89, comfortably over the 0.75 threshold. That is the intended
// behaviour: goods.bicycle.mountain and goods.bicycle.road describing the
// same bike SHOULD meet, and semantic similarity at 0.55 of the weight is
// what decides it. A sibling pair whose descriptions have little to do with
// each other lands under the threshold on that weight alone — semantic 0.35
// puts it at about 0.58, which is a near-miss. Under the thin blend the
// sibling discount is larger, 0.105 of blend rather than 0.06, so a thin card
// filed one node across has further to climb, which is the right way round:
// it said less, so the filing has to do more of the work. The door stays
// narrow because of the shape of the rule: only immediate siblings under a
// sub-level parent. 'Same top-level segment' would let a sofa meet a laptop
// and lean entirely on the 0.75 threshold to sort it out, and it remains far
// looser than anything this admits.
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
function candidateWhere(
  source: {
    account_id: string;
    type: string;
    category: string;
    geo: GeoBucket;
  },
  opts: { shelf?: boolean } = {},
): { sql: string; params: any[] } {
  const onShelf = opts.shelf !== false;
  const opposite = source.type === 'WANT' ? 'HAVE' : 'WANT';
  // SWAPS (domain/swaps.ts, 26 September 2026). A want on a social shelf also
  // takes other wants on social shelves as candidates: two people who are both
  // looking for a tennis partner, or each after the other's language, are each
  // other's other half. Only wants, only social, and only on social: a have is
  // untouched, and a want on goods or services still sees haves alone. Every
  // other clause below applies to a swap candidate exactly as to any other.
  // The top level is a constant of ours, never anything a caller sent, so it
  // is written into the SQL rather than bound.
  const swaps = source.type === 'WANT' && swapsOnShelf(source.category);
  const typeClause = swaps
    ? `(c.type = $1::text
            OR (c.type = 'WANT'
                AND (c.category = '${SWAP_TOP_LEVEL}'
                     OR left(c.category, ${SWAP_TOP_LEVEL.length + 1}) = '${SWAP_TOP_LEVEL}.')))`
    : `c.type = $1::text`;
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
  const sql = `${typeClause}
       AND c.lifecycle_state = 'PUBLISHED'
       AND c.expires_at > now()
       AND NOT c.paused_by_kill_switch
       AND c.embedding IS NOT NULL
       AND c.account_id <> $2::uuid
       AND a.status = 'active'
       AND NOT EXISTS (SELECT 1 FROM match_mutes mm
                       WHERE (mm.account_id = c.account_id AND mm.muted_account = $2::uuid)
                          OR (mm.account_id = $2::uuid AND mm.muted_account = c.account_id))
       ${
         onShelf
           ? `-- category: equal, ancestor, descendant, or siblings under a shared
       -- parent below the top level (the shelf rule, in SQL)
       AND (c.category = $3::text
            OR left(c.category, length($3::text) + 1) = $3::text || '.'
            OR left($3::text, length(c.category) + 1) = c.category || '.'
            OR (strpos(c.category, '.') > 0
                AND strpos($3::text, '.') > 0
                AND regexp_replace(c.category, '\\.[^.]+$', '')
                    = regexp_replace($3::text, '\\.[^.]+$', '')
                AND strpos(regexp_replace($3::text, '\\.[^.]+$', ''), '.') > 0))`
           : // SEARCHING THE WHOLE BOARD: the shelf is weighed in the blend
             // (domain/matchTiers.ts) instead of filtered on here. $3 is still
             // bound, so it is still referenced, harmlessly.
             `AND $3::text IS NOT NULL`
       }
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
 * SEARCH: the nearest opposite-type postings ANYWHERE on the board, the top
 * CROSS_SHELF_TOP_N of them, that the shelf-gated retrieval above did not
 * already bring back. Every other clause of the prefilter holds exactly as it
 * does there — own account, active account, published, unexpired, not paused,
 * mutes both ways, the geo box — because it is the same WHERE with the shelf
 * clause taken out. One query per processed posting, and a small limit, so the
 * cost of searching is bounded by construction.
 *
 * Reserved families and anything the deny list names are dropped here as well,
 * on the candidate's own path: a posting cannot be up under one of those, but
 * a search reaching across shelves is exactly where a rule like that has to be
 * said again rather than assumed.
 */
async function retrieveSearched(
  source: {
    id: string;
    account_id: string;
    type: string;
    category: string;
    geo: GeoBucket;
    embedding_text: string;
  },
  alreadyHave: string[],
): Promise<CandidateRow[]> {
  const w = candidateWhere(source, { shelf: false });
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
       AND NOT (c.id = ANY($15::uuid[]))
     ORDER BY ${CANDIDATE_ORDER}
     LIMIT ${CROSS_SHELF_TOP_N}`,
    [...w.params, source.embedding_text, alreadyHave],
  );
  return (r.rows as CandidateRow[]).filter(
    (c) => categoryGate(c.category).ok && !categoryDenied(c.category),
  );
}

/** Exported for the unit tests: the search query's WHERE, for the same shape checks. */
export function searchQueryShape(source: {
  account_id: string;
  type: string;
  category: string;
  geo: GeoBucket;
}): { where: string; params: any[]; limit: number } {
  const w = candidateWhere(source, { shelf: false });
  return { where: w.sql, params: w.params, limit: CROSS_SHELF_TOP_N };
}

/**
 * How many POSSIBLE introductions each of two postings was given in the last
 * day. The cap is per posting, so both sides are counted.
 */
async function possiblesToday(a: string, b: string): Promise<{ a: number; b: number }> {
  const r = await getPool().query(
    `SELECT count(*) FILTER (WHERE card_want = $1 OR card_have = $1)::int AS a,
            count(*) FILTER (WHERE card_want = $2 OR card_have = $2)::int AS b
       FROM matches
      WHERE certainty = 'possible' AND created_at > now() - interval '1 day'
        AND (card_want IN ($1, $2) OR card_have IN ($1, $2))`,
    [a, b],
  );
  return { a: Number(r.rows[0]?.a ?? 0), b: Number(r.rows[0]?.b ?? 0) };
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
  /** How many candidates came from searching the whole board (CROSS_SHELF_TOP_N at most). */
  searched: number;
  /** The introductions made as POSSIBLE on this run: a subset of matchesCreated. */
  possibles: string[];
  /**
   * The introductions that went LIVE on this run — a subset of matchesCreated
   * plus, sometimes, one that was already in line and has just reached the
   * front. These are the ones a human is summoned about. An introduction still
   * in line summons nobody: to its holder it does not exist yet.
   */
  promoted: string[];
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
  const [gated, pool] = await Promise.all([
    retrieveCandidates(prefilterSource),
    countCandidatePool(prefilterSource),
  ]);
  // SEARCH AND SHELF (domain/matchTiers.ts): the shelf-gated candidates, and
  // then the nearest postings anywhere on the board that they did not already
  // include. A search that fails costs this run its searched candidates and
  // nothing else: the shelf-gated pass is what matching was before today, and
  // it must never be lost to the part that is new.
  let searched: CandidateRow[] = [];
  try {
    searched = await retrieveSearched(
      prefilterSource,
      gated.map((c) => c.id),
    );
  } catch (e: any) {
    log('matcher: search across shelves failed, shelf candidates only', {
      card_id: cardId,
      error: e?.message,
    });
  }
  const candidates: { cand: CandidateRow; viaSearch: boolean }[] = [
    ...gated.map((cand) => ({ cand, viaSearch: false })),
    ...searched.map((cand) => ({ cand, viaSearch: true })),
  ];
  const sourceIsWant = source.type === 'WANT';

  // Source band decrypted at most once per run.
  let sourceBand: PriceBand | undefined | 'unloaded' = 'unloaded';

  const outcome: MatchingOutcome = {
    matchesCreated: [],
    nearMisses: 0,
    evaluated: 0,
    candidatePool: pool.pool,
    candidatePoolCapped: pool.capped,
    searched: searched.length,
    possibles: [],
    promoted: [],
  };
  const touchedCards = new Set<string>();
  // Trial B's collecting bucket (src/shadow/jevTrials.ts). Filled as the run
  // goes and handed over once at the end, so the shadow sees the pairs in the
  // order the engine ranked them rather than the order they happened to
  // arrive. Empty and untouched on any deployment where the shadow is off.
  const shadowPairs: JevPairCandidate[] = [];

  for (const { cand, viaSearch } of candidates) {
    outcome.evaluated++;
    // The SQL prefilter and prefilterKeeps are one rule written twice, once
    // for Postgres and once for us. If they ever disagree, say so: a silent
    // divergence here is exactly the bug the prefilter exists to fix. Only for
    // the shelf-gated candidates, which are the ones that rule selected.
    if (!viaSearch && !prefilterKeeps({ category: source.category, geo: sourceGeo }, cand)) {
      log('matcher: prefilter drift', { card_id: cardId, candidate_id: cand.id });
    }
    // Cheap hard rules first; price bands are only decrypted for survivors.
    if (!urgencyRouted(source, cand) || !urgencyRouted(cand, source)) continue;

    // A SWAP: two wants on the social shelves (domain/swaps.ts). The pair is
    // written in one canonical order whichever of the two is being processed,
    // so the second posting's run lands on the first one's row and the unique
    // key keeps it to one introduction. On a swap "want" and "have" below are
    // only the two slots of the row; both postings are wants.
    const swap = isSwapPair(source, cand);
    // THE COMPLEMENT RULE, on a language exchange only: two people after the
    // same language who both bring the same other one are not a swap, and the
    // postings say so. Where they do not say, the pair goes on to be judged
    // like any other. Not a near miss either — it is not something close to
    // the thing, it is the wrong way round.
    if (swap && onLanguageExchange(source.category, cand.category)) {
      const verdict = languageComplement(source, cand);
      if (!verdict.ok) {
        log('matcher: swap is not a complement', { card_id: cardId, candidate_id: cand.id });
        continue;
      }
    }
    const [want, have] = swap
      ? swapPairOrder<typeof source | CandidateRow>(source, cand)
      : sourceIsWant
        ? [source, cand]
        : [cand, source];

    const pre = evaluatePair({
      semantic: Number(cand.similarity),
      categoryA: source.category,
      categoryB: cand.category,
      geoA: geoOf(source),
      geoB: geoOf(cand),
      // Counted, never compared: attributes pick the blend (matchRules.ts,
      // ASSERTION-SCALED WEIGHTS). Attribute VALUES are read only by the
      // embedding, which happened before this loop, and by the word agreement
      // in tierFor below.
      attributesA: source.attributes,
      attributesB: cand.attributes,
      // The shelf is a contributor from today, never a gate: the geo rule is
      // the only hard rule this pre-check can fail on before a band is opened.
      shelfGate: false,
      // bands withheld: the geo hard rule runs without any decrypt
    });
    if (!pre.hardRulesPass) continue;

    // No money on a swap: neither side is buying, so no band is opened for it
    // at all (and no decrypt audit line is written for a figure nobody uses).
    let wantBand: PriceBand | undefined;
    let haveBand: PriceBand | undefined;
    if (!swap) {
      if (sourceBand === 'unloaded') {
        sourceBand = await decryptBand(source, source.data_key_enc, cand.id);
      }
      const candBand = await decryptBand(cand, cand.data_key_enc, source.id);
      wantBand = sourceIsWant ? (sourceBand as PriceBand | undefined) : candBand;
      haveBand = sourceIsWant ? candBand : (sourceBand as PriceBand | undefined);
    }

    const judged = tierFor({
      semantic: Number(cand.similarity),
      categoryA: source.category,
      categoryB: cand.category,
      geoA: geoOf(source),
      geoB: geoOf(cand),
      // The human's other words for the thing, and the words they said it is
      // NOT, ride with the posting (migration 050): the first widens what can
      // agree, the second is a negative signal that bars a sure one.
      a: {
        kind: (source as any).kind ?? null,
        also_called: (source as any).also_called,
        not_these: (source as any).not_these,
        attributes: source.attributes,
      },
      b: {
        kind: (cand as any).kind ?? null,
        also_called: (cand as any).also_called,
        not_these: (cand as any).not_these,
        attributes: cand.attributes,
      },
      wantBand,
      haveBand,
      bumpWant: Number(want.threshold_bump),
      bumpHave: Number(have.threshold_bump),
    });
    if (!judged.parts.hardRulesPass) continue;
    let tier: Tier = judged.tier;

    // Noted, never acted on. The pair is recorded exactly as the engine judged
    // it, and the judging above is already complete: nothing below this line
    // reads shadowPairs, and the run's outcome is byte-for-byte what it would
    // have been with the shadow off. What travels is the two postings' plain
    // words, categories and attributes — never the bands that were just
    // decrypted, never the geography, never an account id.
    if (jevEnabled() && judged.score >= JEV_PAIR_MIN_SCORE) {
      shadowPairs.push({
        want: {
          id: want.id,
          kind: (want as any).kind ?? null,
          category: want.category,
          attributes: want.attributes,
        },
        have: {
          id: have.id,
          kind: (have as any).kind ?? null,
          category: have.category,
          attributes: have.attributes,
        },
        score: judged.score,
        decision: tier === 'sure' || tier === 'possible' ? 'match' : tier === 'near-miss' ? 'near-miss' : 'discard',
        weights: judged.parts.weights!,
      });
    }

    // THE POSSIBLE CAP. A posting may be handed a few maybes a day and no
    // more: a thin or vague posting would otherwise collect every loosely
    // similar thing on the board, one introduction at a time.
    if (tier === 'possible') {
      const today = await possiblesToday(want.id, have.id);
      if (today.a >= POSSIBLE_PER_POSTING_PER_DAY || today.b >= POSSIBLE_PER_POSTING_PER_DAY) {
        log('matcher: possible cap reached, not introduced', {
          card_id: cardId,
          candidate_id: cand.id,
        });
        tier = judged.parts.shelvesCompatible ? 'near-miss' : 'nothing';
      }
    }

    if (tier === 'sure' || tier === 'possible') {
      // The two facts the fit sequencer ranks a line on that only the engine
      // can know, reduced to booleans HERE, where the bands are already
      // decrypted and about to be thrown away. Neither the ceiling nor the
      // floor nor any difference between them is stored or passed on: "these
      // two limits meet" and "the buyer has a quarter's room over the ask" is
      // the whole of what leaves this loop.
      // On a swap there is no ask and no band, so both are simply false.
      const ask = swap ? null : ((have.ask ?? null) as Ask | null);
      const overlap = swap ? false : limitsOverlap(wantBand, haveBand, ask);
      const roomOverAsk = swap ? false : clearsAskWithRoom(wantBand, ask);
      const ins = await getPool().query(
        // stage 2 with both interest columns true: the posting IS the
        // statement of interest, so an introduction is born with both sides
        // keen and the details open to both (see createMatch in matches.ts).
        `INSERT INTO matches (card_want, card_have, account_want, account_have, score, category,
                              kind, limits_overlap, clears_ask_25,
                              stage, interest_want, interest_have, certainty, swap)
         VALUES ($1,$2,$3,$4,$5,$6,$9,$7,$8,2,true,true,$10,$11)
         ON CONFLICT (card_want, card_have) DO NOTHING
         RETURNING id`,
        [
          want.id,
          have.id,
          want.account_id,
          have.account_id,
          judged.score,
          // On a swap both people read this row, so the shelf and the word
          // are ones that are true of both (domain/swaps.ts).
          swap ? swapCategory(want.category, have.category) : want.category,
          overlap,
          roomOverAsk,
          // The word for the thing travels with the category it was filed
          // under: the want's, so the two stay taken from one side.
          swap ? swapKind((want as any).kind, (have as any).kind) : ((want as any).kind ?? null),
          tier,
          swap,
        ],
      );
      if (ins.rows[0]) {
        const id = ins.rows[0].id as string;
        outcome.matchesCreated.push(id);
        if (tier === 'possible') outcome.possibles.push(id);
        touchedCards.add(want.id);
        touchedCards.add(have.id);
        log('matcher: match created', {
          match_id: id,
          score: Number(judged.score.toFixed(4)),
          category: want.category,
          // Which blend scored it: a count, never an attribute value.
          thinness: judged.parts.thinness,
          certainty: tier,
          // Which rule decided the tier, and whether search found it. The
          // words themselves stay out of the log.
          why: judged.parts.why,
          via_search: viaSearch,
          swap,
          shelves_compatible: judged.parts.shelvesCompatible,
          semantic: Number(judged.parts.semantic.toFixed(4)),
          word_coverage: judged.parts.words.coverage,
        });
      }
    } else if (tier === 'near-miss') {
      await getPool().query(
        // A swap's near miss is written in the same canonical order as its
        // introduction would have been, so it is kept once too.
        `INSERT INTO near_misses (card_want, card_have, score, category)
         VALUES ($1,$2,$3,$4) ON CONFLICT (card_want, card_have) DO NOTHING`,
        [want.id, have.id, judged.score, swap ? swapCategory(want.category, have.category) : want.category],
      );
      outcome.nearMisses++;
    }
  }

  // A fresh introduction is a CANDIDATE, not yet an introduction anyone hears
  // about. The sequencer decides which of them fill the slots the two sides
  // have free, best fit first, and the ones it promotes are the ones a human
  // is summoned about. The rest wait in line and summon nobody: to the holder
  // they do not exist yet.
  //
  // This is where the collection window used to be stamped. Nothing blocks a
  // holder now — see domain/sequencer.ts.
  for (const cardId of touchedCards) {
    for (const id of await resequenceCard(cardId)) {
      if (!outcome.promoted.includes(id)) outcome.promoted.push(id);
    }
  }
  // Last, after every decision this run makes has been made and written.
  // Started and not awaited, and wrapped as well, because a matching run must
  // not be able to fail on the way out through a third party's API.
  try {
    void shadowPairTrials(shadowPairs, log);
  } catch (e: any) {
    log('matcher: jev shadow could not be started', { card_id: cardId, error: e?.message });
  }
  return outcome;
}
