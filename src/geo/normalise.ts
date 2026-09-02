/**
 * Server-side location normalisation.
 *
 * Agents used to invent their own location buckets — "canberra", "AU-ACT",
 * "AU", a geohash — and two cards in one city missed each other because the
 * two strings differed. From 0.3.0 the switchboard does the work: a card
 * names a locality in `place`, and the switchboard resolves it against its
 * bundled gazetteer to a centre point, a canonical geohash4 cell and a reach
 * in kilometres. Matching then compares distance between two centre points,
 * so "Canberra" and "AU-ACT" meet.
 *
 * Three shapes arrive here:
 *   - `place` text: resolved through the gazetteer.
 *   - a geohash bucket: decoded to the centre of its cell.
 *   - any other bucket string: given to the gazetteer as well, so the
 *     invented buckets already on the network resolve. A bucket that answers
 *     to nothing keeps its string and carries no centre point; those cards
 *     meet only cards holding the same bucket. That path exists for cards
 *     written before 0.3.0 and for run-scoped test islands, and it is the
 *     one case where a card has no coordinates.
 */
import { OsbError } from '../protocol.js';
import { decodeGeohash, encodeGeohash, isGeohash } from './geohash.js';
import { looksLikeStreetAddress, regionNamed, resolvePlace } from './gazetteer.js';

/** Reach assumed for a bucket the gazetteer cannot place. A card that names
 *  an area takes the width of that area instead. */
export const DEFAULT_RADIUS_KM = 25;
/** Ceiling from the protocol schema. */
export const MAX_RADIUS_KM = 500;

export interface NormalisedGeo {
  /** The geo object to store on the card (schema-valid). */
  geo: { place?: string; bucket: string; radius_km: number };
  /** Centre point, or null when only a bucket string is known. */
  lat: number | null;
  lon: number | null;
  radius_km: number;
  /** What the gazetteer matched, when it matched something. */
  resolved?: { name: string; country: string; kind: string };
}

/** A stored card row, seen as the matching engine's geo input. */
export function geoOf(row: {
  geo: any;
  geo_lat?: number | null;
  geo_lon?: number | null;
  geo_radius_km?: number | null;
}): { bucket: string; place?: string; radius_km?: number; lat: number | null; lon: number | null } {
  const lat = row.geo_lat == null ? null : Number(row.geo_lat);
  const lon = row.geo_lon == null ? null : Number(row.geo_lon);
  const radius = row.geo_radius_km == null ? row.geo?.radius_km : Number(row.geo_radius_km);
  return {
    bucket: row.geo?.bucket ?? '',
    ...(row.geo?.place ? { place: row.geo.place } : {}),
    ...(radius == null ? {} : { radius_km: radius }),
    lat,
    lon,
  };
}

function clampRadius(km: number | undefined, fallback: number): number {
  const v = km ?? fallback;
  return Math.max(0.1, Math.min(MAX_RADIUS_KM, v));
}

// Kept short: the protocol caps human_action at 300 characters, and the
// place name itself can add 80.
const NAME_A_PLACE =
  'Name a suburb, city or region (for example "Canberra" or "AU-ACT"). Locations here are areas, never street addresses.';

/**
 * A state or territory is not a place a human lives in. The switchboard says
 * which one it heard and asks for a town inside it, rather than guessing a
 * point: an agent that means the whole territory can still say so plainly, in
 * the "AU-ACT" form.
 */
const namesARegion = (place: string, region: string) =>
  `'${place}' is ${region}, a state or territory — name a town or city in it (or "AU-ACT" form for the whole territory).`;

/** Refuse a bare region name before anything tries to place it. */
function refuseRegion(text: string): void {
  const region = regionNamed(text);
  if (region) {
    throw new OsbError('LOCATION_UNRESOLVED', { human_action: namesARegion(text, region) });
  }
}

/**
 * Resolve a card's geo into stored columns. Throws a machine-readable
 * LOCATION_UNRESOLVED when the text is a street address or names nothing the
 * gazetteer knows.
 */
export function normaliseGeo(geo: any): NormalisedGeo {
  const place: string | undefined =
    typeof geo?.place === 'string' && geo.place.trim() ? geo.place.trim() : undefined;
  const bucket: string | undefined =
    typeof geo?.bucket === 'string' && geo.bucket.trim() ? geo.bucket.trim() : undefined;

  if (!place && !bucket) {
    throw new OsbError('LOCATION_UNRESOLVED', { human_action: NAME_A_PLACE });
  }

  // A named locality wins over a bucket: the switchboard resolves it and
  // writes the canonical cell itself.
  if (place) {
    if (looksLikeStreetAddress(place)) {
      throw new OsbError('LOCATION_UNRESOLVED', {
        human_action: `'${place}' reads like a street address. ${NAME_A_PLACE}`,
      });
    }
    refuseRegion(place);
    const hit = resolvePlace(place);
    if (!hit) {
      throw new OsbError('LOCATION_UNRESOLVED', {
        human_action: `The switchboard does not know '${place}'. Try the nearest city or the region it sits in.`,
      });
    }
    const radius = clampRadius(geo.radius_km, hit.reach_km);
    return {
      geo: { place, bucket: encodeGeohash(hit.lat, hit.lon, 4), radius_km: radius },
      lat: hit.lat,
      lon: hit.lon,
      radius_km: radius,
      resolved: { name: hit.name, country: hit.country, kind: hit.kind },
    };
  }

  // A canonical cell: decode it to the centre of the cell.
  if (isGeohash(bucket!)) {
    const c = decodeGeohash(bucket!);
    const radius = clampRadius(geo.radius_km, Math.round(c.cellKm));
    return {
      geo: { bucket: bucket!, radius_km: radius },
      lat: c.lat,
      lon: c.lon,
      radius_km: radius,
    };
  }

  // An invented bucket ("canberra", "AU-ACT", "AU"): the gazetteer gets a
  // turn, and what it finds becomes the card's place and canonical cell. A
  // bucket that names a bare region is refused the way a place would be.
  refuseRegion(bucket!);
  const hit = resolvePlace(bucket!);
  if (hit) {
    const radius = clampRadius(geo.radius_km, hit.reach_km);
    return {
      geo: { place: bucket!, bucket: encodeGeohash(hit.lat, hit.lon, 4), radius_km: radius },
      lat: hit.lat,
      lon: hit.lon,
      radius_km: radius,
      resolved: { name: hit.name, country: hit.country, kind: hit.kind },
    };
  }

  // Nothing answers to it. The card keeps the string and meets only cards
  // carrying the same one (pre-0.3.0 compatibility).
  const radius = clampRadius(geo.radius_km, DEFAULT_RADIUS_KM);
  return {
    geo: { bucket: bucket!, radius_km: radius },
    lat: null,
    lon: null,
    radius_km: radius,
  };
}
