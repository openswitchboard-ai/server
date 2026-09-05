/**
 * Matching-engine rules: pure, deterministic functions only (no I/O), so the
 * whole rule set is unit-testable without AWS or a database.
 *
 * SCORE MODEL (documented here, the single source of truth):
 *
 *   score = Ws * semantic     (cosine similarity of the two cards' canonical
 *                              projection embeddings, clamped to [0,1])
 *         + Wc * category     (taxonomy-tree closeness: 1.0 exact node,
 *                              -0.15 per tree step below the lowest common
 *                              ancestor, counting both sides, floor 0.4 —
 *                              so a parent/child pair is 0.85 and a sibling
 *                              pair 0.7)
 *         + Wg * geo          (1.0 at the same centre point, decaying linearly
 *                              with distance over the two cards' combined
 *                              radii; a flat 0.6 for a pair that meets on a
 *                              declared reach — a whole country, or anywhere —
 *                              rather than on distance; buckets with no
 *                              resolved centre point fall back to the
 *                              pre-0.3.0 string comparison)
 *         + Wp * price        (fit of WANT ceiling over HAVE reserve floor;
 *                              neutral 0.6 when ONE side declared a band and
 *                              the other did not, and dropped from the blend
 *                              entirely — the other three weights
 *                              renormalised — when NEITHER side said anything
 *                              about price at all)
 *
 *   Every component is in [0,1] and the weights sum to 1, so score is in
 *   [0,1]. The weights themselves are NOT a single fixed set: see below.
 *
 * ASSERTION-SCALED WEIGHTS (why the blend has two shapes).
 *
 *   The semantic component is a similarity between two projection texts, and
 *   a projection text is category + attributes. When one card lists five
 *   attributes and the other lists one, the two texts are different LENGTHS
 *   as much as they are different in meaning, and the cosine falls for a
 *   reason that has nothing to do with the two people disagreeing. A seller
 *   writing out a 2021 Giant Trance in good condition and a buyer writing
 *   "used mountain bike, medium" are the same errand; the buyer is not
 *   contradicting anything, they are simply not asserting much.
 *
 *   That asymmetry is the majority real-world case on the WANT side, so the
 *   blend leans on semantic similarity in proportion to how much the two
 *   cards actually assert. THINNESS is the attribute count of the SPARSER
 *   side: thin = min(attrCount(A), attrCount(B)), counting the same scalar
 *   attributes projectionText embeds.
 *
 *     thin >= 3 (both sides rich):   semantic 0.55, category 0.20, geo 0.15
 *     thin <= 2 (one side is thin):  semantic 0.30, category 0.35, geo 0.25
 *
 *   Price stays 0.10 in both, where there is a price term at all (see the
 *   next section). Each set sums to 1.0 (asserted in the tests).
 *   The shift is a FLAT step at thin <= 2 rather than an interpolation over
 *   0, 1, 2 — two weight sets are a thing a person can hold in their head and
 *   reconstruct from a score, and no evidence available today says where a
 *   smooth curve between them should bend.
 *
 *   What moves out of semantic goes to the two components a thin card CAN
 *   still be trusted on: it named a category and it named a place, and both
 *   of those are structured, checked, and unaffected by how much prose sits
 *   beside them.
 *
 * AN UNASSERTED DIMENSION CANNOT VOTE (the price term).
 *
 *   This is the same principle as thinness, carried one step further.
 *   Thinness says a card that asserted little should not have the semantic
 *   component decide it. This says a dimension NEITHER card asserted should
 *   not be in the blend at all.
 *
 *   Most cards arrive with no price on them: someone selling a bike says what
 *   the bike is and where it is, and leaves the money for the conversation.
 *   For a pair like that the price component was a flat 0.6 at weight 0.10 —
 *   0.06 of score handed to every such pair alike, standing in for 0.10 of
 *   weight the three components that DID measure something would otherwise
 *   have shared. Two people who agreed on the category, sat in one town, and
 *   wrote compatible descriptions were dragged back toward 0.6 by a dimension
 *   on which neither of them had spoken. That is dilution, and it says
 *   nothing about the pair.
 *
 *   So when neither side declares a price signal — no band, or a band with no
 *   numeric bound on either end — the price term is REMOVED and the remaining
 *   three weights are divided by their own sum (0.9 under either set), so
 *   they again sum to 1:
 *
 *     rich, no price:  semantic 0.61111, category 0.22222, geo 0.16667
 *     thin, no price:  semantic 0.33333, category 0.38889, geo 0.27778
 *
 *   Equivalently, and this is the easiest way to read any old number: a
 *   no-price score is (the old score - 0.06) / 0.9. That lifts every pair
 *   whose other three components averaged better than 0.6 and lowers every
 *   pair that averaged worse, which is the right way round — the pair is now
 *   judged on what it actually said.
 *
 *   ONE DECLARED SIDE KEEPS THE TERM. A card that named a band asserted
 *   something, and the neutral 0.6 that evaluatePrice returns when the other
 *   side left the relevant bound unset is the honest reading of "one of them
 *   named a number and the other did not". Nothing about that path changes:
 *   the price term stays at its 0.10 and the weights stay as they were.
 *
 *   WORKED ARITHMETIC (three pairs, so the effect is legible without running
 *   anything). All three are pairs where NEITHER side declared a band, which
 *   is the common case, so all three run on the renormalised no-price blend.
 *
 *   (a) The duet pair, dev 2026-09-05 (realism-reports/duet-2026-09-05T09-52
 *       -42-102Z.json, and byte-identical to the 09-19-26-360Z run before
 *       it). HAVE: goods.bicycle.mountain, 5 attributes (year, brand, model,
 *       condition, frame_size), Canberra r3dp r=25. WANT: the same node, 1
 *       attribute (frame_size: medium), Canberra r3dp r=20. Neither side
 *       declared a band.
 *
 *       The reports record a blended score and nothing else, so the semantic
 *       value is backed out of the earlier run, which scored 0.60715854 on
 *       the ORIGINAL weights with both cards resolving to one point (geo 1.0):
 *           0.60715854 = 0.55 s + 0.20 (1.0) + 0.15 (1.0) + 0.10 (0.6)
 *           0.55 s     = 0.60715854 - 0.41 = 0.19715854
 *           s          = 0.35847007
 *
 *       thin = min(5, 1) = 1, so the thin set applies. The 09-52-42 run
 *       recorded 0.7489263 against a 0.75 threshold — short by 0.0011 — and
 *       its geo closeness backs out of the thin blend at the same semantic:
 *           0.7489263 = 0.30 (0.35847007) + 0.35 (1.0) + 0.25 g + 0.10 (0.6)
 *           0.25 g    = 0.7489263 - 0.10754102 - 0.35 - 0.06 = 0.23138528
 *           g         = 0.92554111
 *       (the two Canberra cards did not land on one point that run; over the
 *       pair's combined reach of 45 km that closeness is about 3.4 km apart).
 *
 *       Neither card said anything about price, so the price term goes and
 *       the other three are divided by 0.9:
 *           0.33333333 (0.35847007) + 0.38888889 (1.0) + 0.27777778 (0.92554111)
 *         = 0.11949002 + 0.38888889 + 0.25709475
 *         = 0.76547367  -> MATCH (threshold 0.75)
 *       which is the recorded score with the price term taken back out:
 *           (0.7489263 - 0.06) / 0.9 = 0.76547367
 *       The 0.06 that had been standing between these two people was the one
 *       component neither of them had said a word about.
 *
 *   (b) A thin pair one node apart. The same two cards, on one spot (geo 1.0)
 *       so the filing is the only difference from (a), but the WANT filed
 *       under goods.bicycle.road: siblings, categoryCloseness 0.7. With the
 *       neutral price term that pair scored 0.66254102; without it:
 *           0.33333333 (0.35847007) + 0.38888889 (0.7) + 0.27777778 (1.0)
 *         = 0.11949002 + 0.27222222 + 0.27777778
 *         = 0.66949002  -> NEAR-MISS (stored, never sent)
 *           check: (0.66254102 - 0.06) / 0.9 = 0.66949002
 *       Dropping the price term does not rescue this one, and should not. The
 *       sibling step now costs 0.11667 of blend rather than 0.105, so the
 *       pair is further from the line by that measure and still 0.08 short.
 *
 *   (c) A rich pair that does not agree. Both sides list 4 attributes, same
 *       node, same spot, no bands, and the descriptions have little to do
 *       with each other — semantic 0.40. thin = 4, so the rich set applies:
 *           0.61111111 (0.40) + 0.22222222 (1.0) + 0.16666667 (1.0)
 *         = 0.24444444 + 0.22222222 + 0.16666667
 *         = 0.63333333  -> NEAR-MISS
 *           check: (0.63 - 0.06) / 0.9 = 0.63333333
 *       It was 0.63 with the neutral price term in it, so renormalising moved
 *       it by 0.0033 and changed nothing about the decision. Two
 *       cards that both said plenty and still did not line up are a pair the
 *       embedding is entitled to judge, and it keeps its share of the blend.
 *
 *   WHAT THIS DOES NOT DO. There is no new hard rule for contradicting
 *   attributes. Two cards that assert the same key with conflicting values —
 *   frame_size medium against frame_size large — put both strings into their
 *   projection texts, and the cosine between them falls; that is the
 *   mechanism that already prices a contradiction, and it is unchanged here.
 *   Note that a contradiction takes two assertions, so any pair with a real
 *   one has at least one attribute on the sparser side and is usually rich on
 *   both. Where a contradiction does land in the thin set, semantic still
 *   carries 0.30 of the blend and the near-miss floor still catches it.
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

export interface BlendWeights {
  semantic: number;
  category: number;
  geo: number;
  price: number;
}

/**
 * The blend for a pair where BOTH sides asserted something substantial
 * (>= 3 attributes each). Unchanged since the model was written, and still
 * exported under the old name because it is still the default reading of the
 * score model.
 */
export const WEIGHTS = { semantic: 0.55, category: 0.2, geo: 0.15, price: 0.1 } as const;

/**
 * The blend for a pair where the SPARSER side asserted little (<= 2
 * attributes). Semantic gives up 0.25 of the blend, which goes to the two
 * components a thin card can still be trusted on: category (+0.15) and geo
 * (+0.10). Price is untouched. See the SCORE MODEL header for the worked
 * arithmetic.
 */
export const THIN_WEIGHTS = { semantic: 0.3, category: 0.35, geo: 0.25, price: 0.1 } as const;

/**
 * The same blend with the price term removed and the remaining three weights
 * divided by their own sum, for a pair where NEITHER side said anything about
 * price. See the SCORE MODEL header, AN UNASSERTED DIMENSION CANNOT VOTE.
 */
function withoutPrice(w: BlendWeights): BlendWeights {
  const rest = w.semantic + w.category + w.geo;
  return Object.freeze({
    semantic: w.semantic / rest,
    category: w.category / rest,
    geo: w.geo / rest,
    price: 0,
  });
}

/** WEIGHTS with no price term: semantic 0.61111, category 0.22222, geo 0.16667. */
export const WEIGHTS_NO_PRICE = withoutPrice(WEIGHTS);

/** THIN_WEIGHTS with no price term: semantic 0.33333, category 0.38889, geo 0.27778. */
export const THIN_WEIGHTS_NO_PRICE = withoutPrice(THIN_WEIGHTS);

/** At or below this many attributes on the sparser side, the pair is thin. */
export const THIN_ATTR_MAX = 2;

/**
 * How many attributes a card asserts, counted exactly as projectionText
 * counts them: scalars only, since a nested or null value contributes nothing
 * to the embedded text and so cannot be what the semantic score is reading.
 */
export function attrCount(attributes: unknown): number {
  if (!attributes || typeof attributes !== 'object') return 0;
  return Object.values(attributes as Record<string, unknown>).filter((v) =>
    ['string', 'number', 'boolean'].includes(typeof v),
  ).length;
}

/**
 * The blend to score this pair with. Thinness is the SPARSER side's count: a
 * rich card meeting a thin one is a thin pair, because the thing that went
 * wrong is the asymmetry, and the sparser side is the one that measures it.
 *
 * `priceAsserted` is whether EITHER side said anything about price. When
 * neither did, the price term is dropped and the other three weights are
 * renormalised. It defaults to true, so a caller that only knows how much the
 * two cards asserted gets the blend it always got.
 */
export function weightsFor(
  attrCountA: number,
  attrCountB: number,
  priceAsserted = true,
): BlendWeights {
  const thin = Math.min(attrCountA, attrCountB) <= THIN_ATTR_MAX;
  if (priceAsserted) return thin ? THIN_WEIGHTS : WEIGHTS;
  return thin ? THIN_WEIGHTS_NO_PRICE : WEIGHTS_NO_PRICE;
}

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
 * Did this card say anything at all about price? A band with at least one
 * finite bound is an assertion; no band, or a band with neither bound set, is
 * silence. This is what decides whether the price term is in the blend —
 * never what it scores, which is evaluatePrice's job and is unchanged.
 */
export function assertsPrice(band: PriceBand | undefined): boolean {
  if (!band?.band) return false;
  return Number.isFinite(band.band.min) || Number.isFinite(band.band.max);
}

/**
 * Intersection rule: WANT ceiling (band.max) >= HAVE reserve floor (band.min).
 * A side with no band (or no bound on the relevant side) imposes no
 * constraint. Mixed currencies are treated as incompatible (no FX in 0.F).
 * Fit: 1.0 when the ceiling clears the floor by >= 25% of the ceiling,
 * linear below that; 0.6 neutral when either side declared no usable bound.
 *
 * The neutral 0.6 is still returned when NEITHER side declared anything, and
 * it is still the right answer to "how well do these two bands fit" — there
 * is nothing to fit. What changed is that evaluatePair no longer puts that
 * answer in the blend for such a pair (see assertsPrice and weightsFor).
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
  /**
   * The two cards' attributes, used ONLY to count how much each side asserted
   * and pick the blend (see weightsFor). Values are never compared here — the
   * semantic component is where attribute content is read. Absent means the
   * card asserted nothing, which is a thin card and is scored as one.
   */
  attributesA?: unknown;
  attributesB?: unknown;
  /** decrypted, engine-side only */
  wantBand?: PriceBand;
  haveBand?: PriceBand;
}

export interface PairEval {
  hardRulesPass: boolean;
  failed?: 'category' | 'geo' | 'price';
  score: number;
  /**
   * The weights this pair was ACTUALLY scored with, so a caller can log or
   * explain the number: one of the four sets — rich or thin, with the price
   * term or with it dropped and the rest renormalised (price: 0).
   */
  weights?: BlendWeights;
  /** The sparser side's attribute count — the thinness the blend keyed on. */
  thinness?: number;
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
  const nA = attrCount(p.attributesA);
  const nB = attrCount(p.attributesB);
  // One side naming a band is enough to keep the price term. With neither,
  // w.price is 0 and the other three weights already carry the whole blend.
  const priceAsserted = assertsPrice(p.wantBand) || assertsPrice(p.haveBand);
  const w = weightsFor(nA, nB, priceAsserted);
  const score =
    w.semantic * semantic +
    w.category * categoryCloseness(p.categoryA, p.categoryB) +
    w.geo * geo.closeness +
    w.price * price.fit;
  return {
    hardRulesPass: true,
    score: Math.min(1, score),
    weights: w,
    thinness: Math.min(nA, nB),
  };
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
