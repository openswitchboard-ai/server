/**
 * Matching-engine rules: pure, deterministic functions only (no I/O), so the
 * whole rule set is unit-testable without AWS or a database.
 *
 * SCORE MODEL (documented here, the single source of truth):
 *
 *   score = 0.55 * semantic   (cosine similarity of the two cards' canonical
 *                              projection embeddings, clamped to [0,1])
 *         + 0.20 * category   (taxonomy-tree closeness: 1.0 exact node,
 *                              -0.15 per tree step below the lowest common
 *                              ancestor, counting both sides, floor 0.4 —
 *                              so a parent/child pair is 0.85 and a sibling
 *                              pair 0.7)
 *         + 0.15 * geo        (1.0 at the same centre point, decaying linearly
 *                              with distance over the two cards' combined
 *                              radii; a flat 0.6 for a pair that meets on a
 *                              declared reach — a whole country, or anywhere —
 *                              rather than on distance; buckets with no
 *                              resolved centre point fall back to the
 *                              pre-0.3.0 string comparison)
 *         + 0.10 * price      (fit of WANT ceiling over HAVE reserve floor;
 *                              neutral 0.6 when either side declared no band)
 *
 *   Weights sum to 1; every component is in [0,1], so score is in [0,1].
 *
 * DECISION (per pair that passes ALL hard rules):
 *   score >= max(0.75 + bump(want_owner), 0.75 + bump(have_owner)) -> MATCH
 *   score >= 0.55                                                  -> NEAR-MISS (stored, never sent)
 *   otherwise                                                       -> discarded
 *
 * PERSONAL THRESHOLD NUDGE (simple model, no ML): each account carries
 * reputation.threshold_bump in [0, 0.10]. A 'not-for-me' verdict adds +0.01;
 * a 'good-call' verdict subtracts 0.01 (floor 0). The account's effective
 * match-creation threshold is 0.75 + bump. There are NO other ranking inputs:
 * match quality is the only ranking signal (no paid ranking, ever).
 *
 * HARD RULES (all must pass before a score is even considered):
 *   - opposite types (WANT vs HAVE), different accounts, no mute either way;
 *   - both PUBLISHED, unexpired (TTL), not paused by a kill switch;
 *   - category-tree compatibility (equal, ancestor, descendant, or siblings
 *     under a shared parent that is itself below the top level);
 *   - geo: each side's reach covers where the other side is — two radius cards
 *     when their centre points are within the sum of the two radii, a
 *     'country' card over any card in the same country, an 'anywhere' card
 *     over everything, and the test runs both ways;
 *   - price-band intersection: WANT ceiling >= HAVE reserve floor, computed
 *     on decrypted bands server-side only - bands NEVER leave the engine;
 *   - urgency routing: a card with urgency='today' only matches counterparties
 *     "fast enough to matter" (agent token seen in the last hour, or a
 *     business account).
 */
import { loadTaxonomy } from '../protocol.js';

export const WEIGHTS = { semantic: 0.55, category: 0.2, geo: 0.15, price: 0.1 } as const;
export const CREATE_THRESHOLD = 0.75;
export const NEAR_MISS_FLOOR = 0.55;
export const MAX_THRESHOLD_BUMP = 0.1;
export const THRESHOLD_BUMP_STEP = 0.01;

/** Collection-window defaults (minutes). Per-card override may only shorten. */
export const COLLECT_WINDOW_DEFAULT_MIN = 360; // 6h, goods
export const COLLECT_WINDOW_URGENT_MIN = 15; // urgency = 'today'

export function defaultCollectWindowMinutes(urgency: string): number {
  return urgency === 'today' ? COLLECT_WINDOW_URGENT_MIN : COLLECT_WINDOW_DEFAULT_MIN;
}

export function collectWindowMinutes(urgency: string, override: number | null | undefined): number {
  const dflt = defaultCollectWindowMinutes(urgency);
  if (override != null && override >= 1) return Math.min(override, dflt);
  return dflt;
}

// ---------------------------------------------------------------------------
// Canonical projection text: what gets embedded for a card. Deliberately NOT
// the card's values verbatim as a blob - a deterministic projection of the
// STRUCTURED card only:
//   - the taxonomy category path with human labels (so 'goods.bicycle.mountain'
//     embeds as its meaning, not just a token);
//   - the sorted attribute key/value pairs, lowercased, string values
//     truncated to 60 chars (attribute keys are already schema-constrained
//     lower_snake_case and identity/sensitive keys are structurally banned).
// The card TYPE is excluded on purpose: a WANT and a HAVE for the same thing
// must land close together in the embedding space.
// ---------------------------------------------------------------------------
let taxonomyCache: any | undefined;
function taxonomy(): any {
  if (!taxonomyCache) taxonomyCache = loadTaxonomy();
  return taxonomyCache;
}

/** Human label for the category's leaf node ("Mountain bikes"). Unknown
 *  nodes fall back to the raw leaf segment — same honest fallback as
 *  categoryLabelPath. Emails show ONLY this, never the raw slug. */
export function categoryLeafLabel(category: string): string {
  const nodes = taxonomy().nodes ?? {};
  const parts = category.split('.');
  return nodes[category]?.label ?? parts[parts.length - 1];
}

export function categoryLabelPath(category: string): string {
  const nodes = taxonomy().nodes ?? {};
  const parts = category.split('.');
  const labels: string[] = [];
  for (let i = 1; i <= parts.length; i++) {
    const key = parts.slice(0, i).join('.');
    const label = nodes[key]?.label;
    labels.push(label ?? parts[i - 1]);
  }
  return labels.join(' > ');
}

export function projectionText(card: { category: string; attributes?: any }): string {
  const attrs = Object.entries(card.attributes ?? {})
    .filter(([, v]) => ['string', 'number', 'boolean'].includes(typeof v))
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}: ${String(v).toLowerCase().slice(0, 60)}`);
  const head = `category: ${card.category} (${categoryLabelPath(card.category)})`;
  return attrs.length ? `${head}; ${attrs.join('; ')}` : head;
}

// ---------------------------------------------------------------------------
// Category tree.
// ---------------------------------------------------------------------------

/** The path with its last segment removed, or '' for a top-level node. */
function parentOf(category: string): string {
  const cut = category.lastIndexOf('.');
  return cut === -1 ? '' : category.slice(0, cut);
}

/**
 * Compatible iff one category equals or is an ancestor/descendant of the
 * other, OR the two are SIBLINGS under a shared parent that is itself below
 * the top level.
 *
 * The sibling case is why goods.bicycle.mountain and goods.bicycle.road reach
 * the blend: two people who each described a bike and differed only on the
 * discipline were being kept apart by the filing, and semantic similarity —
 * which carries more than half the score — is the thing that should decide a
 * pair like that.
 *
 * The shared parent has to contain a dot, so the rule stops one level down
 * from the top: goods.bicycle and goods.electronics share only 'goods', and
 * admitting them would open every top-level vertical to itself. Nothing wider
 * than immediate siblings is admitted either — goods.bicycle.mountain and
 * goods.skateboard share no immediate parent and stay apart.
 */
export function categoryCompatible(a: string, b: string): boolean {
  if (a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`)) return true;
  const parent = parentOf(a);
  return parent !== '' && parent === parentOf(b) && parent.includes('.');
}

/**
 * 1.0 exact, then -0.15 per tree step below the lowest common ancestor,
 * counting both sides, floored at 0.4. On the ancestor line one side is zero
 * steps, so a parent/child pair is 0.85 and a grandparent/grandchild 0.7,
 * exactly as before. Siblings are one step each: 1 - 0.15 x 2 = 0.7.
 * Incompatible pairs score 0.
 */
export function categoryCloseness(a: string, b: string): number {
  if (!categoryCompatible(a, b)) return 0;
  const pa = a.split('.');
  const pb = b.split('.');
  let shared = 0;
  while (shared < pa.length && shared < pb.length && pa[shared] === pb[shared]) shared++;
  const steps = pa.length - shared + (pb.length - shared);
  return Math.max(0.4, 1 - 0.15 * steps);
}

// ---------------------------------------------------------------------------
// Geo. A card answers two questions, and they are not the same one.
//
// WHERE IT IS. Since 0.3.0 every card that names a locality carries a centre
// point, resolved server-side (see geo/normalise.ts), so "Canberra" and
// "AU-ACT" — once two unequal strings — now sit on the same spot. A card whose
// bucket answers to nothing in the gazetteer has no centre point; those fall
// back to the pre-0.3.0 comparison (same bucket, or one bucket a prefix of the
// other), for cards written before the change and for run-scoped test islands.
//
// HOW FAR ITS OWNER WILL GO. The reach: 'radius' (within radius_km, which is
// all a card could ever say before), 'country' (anywhere in the place's own
// country — something they would post), or 'anywhere' (no limit at all —
// something done online). Until reach existed, a laptop someone would send to
// any address in the country had to choose between an honest town and an
// honest distance, and could not have both.
//
// THE RULE: each side's reach has to cover where the other side is. Two
// radius cards meet exactly as they always did, on the sum of their radii. A
// 'country' card covers any card whose place resolved to the same country; an
// 'anywhere' card covers every card. Because the test runs both ways, a
// nationwide HAVE in Canberra meets a WANT in Perth only when that WANT
// reaches nationwide too — the person collecting has to be as willing to cross
// the distance as the person sending. A card the switchboard could not place
// carries no country code, so 'country' has nothing to reach across and falls
// back to the radius the card already has.
//
// Distance is APPROXIMATE by design — location on the switchboard is an area,
// never a point, so neither is the answer.
// ---------------------------------------------------------------------------
export { decodeGeohash, encodeGeohash, haversineKm, isGeohash } from '../geo/geohash.js';
import { decodeGeohash, haversineKm, isGeohash } from '../geo/geohash.js';

/** Radius assumed for a card that carries a centre point but no radius. */
export const DEFAULT_GEO_RADIUS_KM = 25;

/**
 * Geo contribution for a pair that meets on a declared reach rather than on
 * distance. Flat and moderate on purpose: a nationwide card meeting one 3,000
 * km away is a real match and should not be scored as though the two were
 * adjacent suburbs. A pair that ALSO happens to be within radius keeps its
 * distance score, so declaring a wider reach never costs a card its local
 * matches.
 */
export const REACH_GEO_CLOSENESS = 0.6;

/** How far a card's owner will meet the other side. Absent means 'radius'. */
export type GeoReach = 'radius' | 'country' | 'anywhere';

export interface GeoBucket {
  bucket: string;
  place?: string;
  radius_km?: number;
  /** Resolved centre point; null/undefined for an unresolved bucket. */
  lat?: number | null;
  lon?: number | null;
  /** Absent on a card written before reach existed: that card meant 'radius'. */
  reach?: GeoReach | null;
  /** ISO 3166-1 alpha-2 of the resolved place; null when nothing placed it. */
  country?: string | null;
}

interface GeoEval {
  compatible: boolean;
  closeness: number; // [0,1]
}

function centre(g: GeoBucket): { lat: number; lon: number } | undefined {
  if (typeof g.lat === 'number' && typeof g.lon === 'number') {
    return { lat: g.lat, lon: g.lon };
  }
  return undefined;
}

export function reachOf(g: GeoBucket): GeoReach {
  return g.reach === 'country' || g.reach === 'anywhere' ? g.reach : 'radius';
}

/**
 * Distance against the sum of the two radii — the whole of the rule before
 * reach existed, and still the whole of it for two radius cards.
 */
function evaluateByDistance(a: GeoBucket, b: GeoBucket): GeoEval {
  const ca = centre(a);
  const cb = centre(b);
  if (ca && cb) {
    const dist = haversineKm(ca, cb);
    const reach = (a.radius_km ?? DEFAULT_GEO_RADIUS_KM) + (b.radius_km ?? DEFAULT_GEO_RADIUS_KM);
    if (dist > reach) return { compatible: false, closeness: 0 };
    return { compatible: true, closeness: reach > 0 ? Math.max(0, 1 - dist / reach) : 1 };
  }
  // ---- pre-0.3.0 buckets, no centre point on at least one side ----
  if (a.bucket === b.bucket) return { compatible: true, closeness: 1 };
  if (isGeohash(a.bucket) && isGeohash(b.bucket)) {
    const ga = decodeGeohash(a.bucket);
    const gb = decodeGeohash(b.bucket);
    const dist = haversineKm(ga, gb);
    const reach = (a.radius_km ?? 0) + (b.radius_km ?? 0) + ga.cellKm + gb.cellKm;
    if (dist > reach) return { compatible: false, closeness: 0 };
    return { compatible: true, closeness: Math.max(0, 1 - dist / reach) };
  }
  // Opaque region codes: prefix relation is the only overlap signal we have.
  if (a.bucket.startsWith(b.bucket) || b.bucket.startsWith(a.bucket)) {
    return { compatible: true, closeness: 0.8 };
  }
  return { compatible: false, closeness: 0 };
}

/** Does `self`'s reach cover where `other` sits? */
function reaches(self: GeoBucket, other: GeoBucket): boolean {
  switch (reachOf(self)) {
    case 'anywhere':
      return true;
    case 'country':
      // No country code on either side means nothing to compare, so the card
      // keeps the behaviour it had before it said anything about reach.
      if (!self.country || !other.country) return evaluateByDistance(self, other).compatible;
      return self.country === other.country;
    default:
      return evaluateByDistance(self, other).compatible;
  }
}

export function evaluateGeo(a: GeoBucket, b: GeoBucket): GeoEval {
  // Two radius cards: unchanged, down to the score.
  if (reachOf(a) === 'radius' && reachOf(b) === 'radius') return evaluateByDistance(a, b);
  if (!reaches(a, b) || !reaches(b, a)) return { compatible: false, closeness: 0 };
  const byDistance = evaluateByDistance(a, b);
  return {
    compatible: true,
    closeness: Math.max(REACH_GEO_CLOSENESS, byDistance.compatible ? byDistance.closeness : 0),
  };
}

// ---------------------------------------------------------------------------
// Price bands. Computed on DECRYPTED bands inside the engine only; the bands
// themselves never appear in any output of these functions beyond a boolean
// and a fit scalar.
// ---------------------------------------------------------------------------
export interface PriceBand {
  band: { min?: number; max?: number };
  ccy: string;
}

interface PriceEval {
  compatible: boolean;
  fit: number; // [0,1]
}

/**
 * Intersection rule: WANT ceiling (band.max) >= HAVE reserve floor (band.min).
 * A side with no band (or no bound on the relevant side) imposes no
 * constraint. Mixed currencies are treated as incompatible (no FX in 0.F).
 * Fit: 1.0 when the ceiling clears the floor by >= 25% of the ceiling,
 * linear below that; 0.6 neutral when either side declared no usable bound.
 */
export function evaluatePrice(
  want: PriceBand | undefined,
  have: PriceBand | undefined,
): PriceEval {
  const ceiling = want?.band?.max;
  const floor = have?.band?.min;
  if (ceiling == null || floor == null) return { compatible: true, fit: 0.6 };
  if (want!.ccy !== have!.ccy) return { compatible: false, fit: 0 };
  if (ceiling < floor) return { compatible: false, fit: 0 };
  if (ceiling <= 0) return { compatible: true, fit: 1 };
  const headroom = (ceiling - floor) / ceiling; // [0,1]
  return { compatible: true, fit: Math.min(1, headroom / 0.25) };
}

// ---------------------------------------------------------------------------
// Blend + decision.
// ---------------------------------------------------------------------------
export interface PairInputs {
  semantic: number; // raw cosine similarity, may be [-1,1]
  categoryA: string;
  categoryB: string;
  geoA: GeoBucket;
  geoB: GeoBucket;
  /** decrypted, engine-side only */
  wantBand?: PriceBand;
  haveBand?: PriceBand;
}

export interface PairEval {
  hardRulesPass: boolean;
  failed?: 'category' | 'geo' | 'price';
  score: number;
}

export function evaluatePair(p: PairInputs): PairEval {
  if (!categoryCompatible(p.categoryA, p.categoryB)) {
    return { hardRulesPass: false, failed: 'category', score: 0 };
  }
  const geo = evaluateGeo(p.geoA, p.geoB);
  if (!geo.compatible) return { hardRulesPass: false, failed: 'geo', score: 0 };
  const price = evaluatePrice(p.wantBand, p.haveBand);
  if (!price.compatible) return { hardRulesPass: false, failed: 'price', score: 0 };
  const semantic = Math.max(0, Math.min(1, p.semantic));
  const score =
    WEIGHTS.semantic * semantic +
    WEIGHTS.category * categoryCloseness(p.categoryA, p.categoryB) +
    WEIGHTS.geo * geo.closeness +
    WEIGHTS.price * price.fit;
  return { hardRulesPass: true, score: Math.min(1, score) };
}

export type PairDecision = 'match' | 'near-miss' | 'discard';

export function decide(score: number, bumpWant: number, bumpHave: number): PairDecision {
  const threshold = CREATE_THRESHOLD + Math.max(bumpWant, bumpHave);
  if (score >= threshold) return 'match';
  if (score >= NEAR_MISS_FLOOR) return 'near-miss';
  return 'discard';
}

/** Ladder probing pattern: >= 3 offers by one side on one match, amounts
 *  strictly monotonically increasing (classic reserve-probing walk). */
export function isLadderPattern(amountsInOrder: number[]): boolean {
  if (amountsInOrder.length < 3) return false;
  const tail = amountsInOrder.slice(-3);
  return tail[0] < tail[1] && tail[1] < tail[2];
}
