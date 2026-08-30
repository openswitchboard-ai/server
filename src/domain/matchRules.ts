/**
 * Matching-engine rules: pure, deterministic functions only (no I/O), so the
 * whole rule set is unit-testable without AWS or a database.
 *
 * SCORE MODEL (documented here, the single source of truth):
 *
 *   score = 0.55 * semantic   (cosine similarity of the two cards' canonical
 *                              projection embeddings, clamped to [0,1])
 *         + 0.20 * category   (taxonomy-tree closeness: 1.0 exact node,
 *                              -0.15 per ancestor/descendant step, floor 0.4)
 *         + 0.15 * geo        (1.0 same bucket; geohash pairs decay linearly
 *                              with centre distance over the combined reach;
 *                              prefix-related non-geohash buckets 0.8)
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
 *   - category-tree compatibility (equal, ancestor, or descendant);
 *   - geo bucket + radius overlap;
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

/** Compatible iff one category equals or is an ancestor/descendant of the other. */
export function categoryCompatible(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`);
}

/** 1.0 exact; -0.15 per tree step apart along the ancestor line; floor 0.4. */
export function categoryCloseness(a: string, b: string): number {
  if (!categoryCompatible(a, b)) return 0;
  const steps = Math.abs(a.split('.').length - b.split('.').length);
  return Math.max(0.4, 1 - 0.15 * steps);
}

// ---------------------------------------------------------------------------
// Geo: buckets are coarse cells (geohash where they parse as one, otherwise
// opaque region codes). Radius overlap is APPROXIMATE by design - location is
// never exact on the switchboard, so neither is distance.
// ---------------------------------------------------------------------------
const GEOHASH32 = '0123456789bcdefghjkmnpqrstuvwxyz';

export function isGeohash(bucket: string): boolean {
  const b = bucket.toLowerCase();
  return b.length >= 2 && b.length <= 12 && [...b].every((c) => GEOHASH32.includes(c));
}

/** Decode a geohash to its cell centre {lat, lon} and half-diagonal km. */
export function decodeGeohash(bucket: string): { lat: number; lon: number; cellKm: number } {
  let latMin = -90, latMax = 90, lonMin = -180, lonMax = 180;
  let even = true;
  for (const c of bucket.toLowerCase()) {
    const idx = GEOHASH32.indexOf(c);
    for (let bit = 4; bit >= 0; bit--) {
      const on = (idx >> bit) & 1;
      if (even) {
        const mid = (lonMin + lonMax) / 2;
        if (on) lonMin = mid; else lonMax = mid;
      } else {
        const mid = (latMin + latMax) / 2;
        if (on) latMin = mid; else latMax = mid;
      }
      even = !even;
    }
  }
  const lat = (latMin + latMax) / 2;
  const lon = (lonMin + lonMax) / 2;
  // Half-diagonal of the cell, km (approx; 1 deg lat ~ 111 km).
  const dLatKm = ((latMax - latMin) / 2) * 111;
  const dLonKm = ((lonMax - lonMin) / 2) * 111 * Math.cos((lat * Math.PI) / 180);
  return { lat, lon, cellKm: Math.sqrt(dLatKm * dLatKm + dLonKm * dLonKm) };
}

export function haversineKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

export interface GeoBucket {
  bucket: string;
  radius_km?: number;
}

interface GeoEval {
  compatible: boolean;
  closeness: number; // [0,1]
}

export function evaluateGeo(a: GeoBucket, b: GeoBucket): GeoEval {
  if (a.bucket === b.bucket) return { compatible: true, closeness: 1 };
  if (isGeohash(a.bucket) && isGeohash(b.bucket)) {
    const ca = decodeGeohash(a.bucket);
    const cb = decodeGeohash(b.bucket);
    const dist = haversineKm(ca, cb);
    const reach = (a.radius_km ?? 0) + (b.radius_km ?? 0) + ca.cellKm + cb.cellKm;
    if (dist > reach) return { compatible: false, closeness: 0 };
    return { compatible: true, closeness: Math.max(0, 1 - dist / reach) };
  }
  // Opaque region codes: prefix relation is the only overlap signal we have.
  if (a.bucket.startsWith(b.bucket) || b.bucket.startsWith(a.bucket)) {
    return { compatible: true, closeness: 0.8 };
  }
  return { compatible: false, closeness: 0 };
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
