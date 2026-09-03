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
 *
 * Resolution is never silent about a doubt. Text that names an area too wide
 * to put a person in, and a name that several real cities answer to, are both
 * refused with something the agent can act on rather than resolved to a point
 * nobody chose. What does resolve comes back written out in full, so the
 * agent can read it to its human and the human can say it is wrong.
 *
 * PLACE IS NOT REACH. Where a card is and how far its owner will meet someone
 * are two questions, and for a long time a card could only answer the first.
 * `place` stays what it always was: a real town, resolved here, with regions
 * and countries refused. `reach` is the second answer — within `radius_km` as
 * before, the whole of the place's own country, or anywhere at all — and the
 * country code the gazetteer already knew is now kept, because reaching a
 * country means nothing without knowing which one.
 */
import { OsbError } from '../protocol.js';
import { decodeGeohash, encodeGeohash, isGeohash } from './geohash.js';
import type { GeoReach } from '../domain/matchRules.js';
import {
  ambiguousPlaces,
  countryNamed,
  countryNameOf,
  describePlace,
  looksLikeStreetAddress,
  qualifyPlace,
  regionNamed,
  resolvePlace,
  type Place,
} from './gazetteer.js';

/** Radius assumed for a bucket the gazetteer cannot place. A card that names
 *  an area takes the width of that area instead. */
export const DEFAULT_RADIUS_KM = 25;
/** Ceiling from the protocol schema. */
export const MAX_RADIUS_KM = 500;

export interface NormalisedGeo {
  /** The geo object to store on the card (schema-valid). */
  geo: { place?: string; bucket: string; radius_km: number; reach?: GeoReach };
  /** Centre point, or null when only a bucket string is known. */
  lat: number | null;
  lon: number | null;
  radius_km: number;
  /** How far the owner will meet the other side. */
  reach: GeoReach;
  /** ISO 3166-1 alpha-2 of the resolved place; null when nothing placed it. */
  country: string | null;
  /** What the gazetteer matched, when it matched something. */
  resolved?: { name: string; country: string; kind: string; display: string };
}

/** The reach a stored geo carries. Absent means the old behaviour, which is
 *  what every card written before reach existed meant. */
export function reachOfGeo(geo: any): GeoReach {
  const r = geo?.reach;
  return r === 'country' || r === 'anywhere' ? r : 'radius';
}

/** A stored card row, seen as the matching engine's geo input. */
export function geoOf(row: {
  geo: any;
  geo_lat?: number | null;
  geo_lon?: number | null;
  geo_radius_km?: number | null;
  geo_country?: string | null;
}): {
  bucket: string;
  place?: string;
  radius_km?: number;
  lat: number | null;
  lon: number | null;
  reach: GeoReach;
  country: string | null;
} {
  const lat = row.geo_lat == null ? null : Number(row.geo_lat);
  const lon = row.geo_lon == null ? null : Number(row.geo_lon);
  const radius = row.geo_radius_km == null ? row.geo?.radius_km : Number(row.geo_radius_km);
  return {
    bucket: row.geo?.bucket ?? '',
    ...(row.geo?.place ? { place: row.geo.place } : {}),
    ...(radius == null ? {} : { radius_km: radius }),
    lat,
    lon,
    reach: reachOfGeo(row.geo),
    country: row.geo_country ?? null,
  };
}

/**
 * How a stored card's location reads on its owner's approval page: the place
 * written out in full, so someone who knows the area can see at a glance that
 * the card is where they meant it to be. A place the gazetteer no longer
 * answers to keeps its own string, and a card carrying only a bucket shows
 * the bucket.
 */
export function describeStoredGeo(geo: any): string {
  const place = typeof geo?.place === 'string' ? geo.place.trim() : '';
  if (place) {
    const hit = resolvePlace(place);
    return hit ? describePlace(hit) : place;
  }
  return typeof geo?.bucket === 'string' ? geo.bucket : '';
}

/**
 * The second half of a card's location line: how far its owner will meet
 * someone, in the same plain words on the approval page and in the publish
 * echo. A country the switchboard can name is named — "reaching all of
 * Australia" — because a code is not something to read out to a human.
 */
export function describeReach(
  reach: GeoReach,
  radiusKm: number,
  country?: string | null,
): string {
  if (reach === 'anywhere') return 'reaching anywhere';
  if (reach === 'country') {
    const name = countryNameOf(country);
    return name ? `reaching all of ${name}` : 'reaching its whole country';
  }
  return `matching within ${Math.round(radiusKm)} km`;
}

/** The reach line for a card already in the database. */
export function describeStoredReach(
  geo: any,
  country: string | null | undefined,
  radiusKm: number,
): string {
  return describeReach(reachOfGeo(geo), radiusKm, country);
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

/**
 * A country is wider still. "AU" put a card on the centroid of Australia,
 * 476 km from the city it meant, and said nothing about it. So the
 * switchboard names the country it heard and asks for a town inside it — and,
 * because an agent naming a country usually means a card that reaches one,
 * points at the field that says so. The card lives where the thing lives;
 * reach is how far it travels.
 */
const namesACountry = (place: string, country: string) =>
  `'${place}' is ${country}, a whole country — name the town or city your human is near. To offer nationwide, name your town and set reach to "country" (place "Canberra", reach "country").`;

const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

/**
 * Several real cities answer to some names. Picking the biggest of them and
 * saying nothing is how a Perth card crosses an ocean, so the switchboard
 * hands back the candidates, written out, and the agent asks its human which
 * one. The message carries as many as fit under the protocol's 300-character
 * ceiling; the full list rides in `candidates`.
 */
function namesSeveralPlaces(place: string, displays: string[]): string {
  const head = `'${clip(place, 40)}' names more than one place. Ask your human which, then post it in full:`;
  let msg = head;
  for (const d of displays) {
    const next = `${msg} ${d};`;
    if (next.length > 299) break;
    msg = next;
  }
  return msg === head ? `${head} ${clip(displays[0], 60)}.` : `${msg.slice(0, -1)}.`;
}

/** Refuse a bare region name before anything tries to place it. */
function refuseRegion(text: string): void {
  const region = regionNamed(text);
  if (region) {
    throw new OsbError('LOCATION_UNRESOLVED', { human_action: namesARegion(text, region) });
  }
}

/** Refuse a bare country name or country code, the same way. */
function refuseCountry(text: string): void {
  const country = countryNamed(text);
  if (country) {
    throw new OsbError('LOCATION_UNRESOLVED', {
      human_action: namesACountry(clip(text, 60), country),
    });
  }
}

/** Refuse a name several cities answer to, and say which they are. */
function refuseAmbiguous(text: string): void {
  const places = ambiguousPlaces(text);
  if (!places) return;
  const candidates = places.map(qualifyPlace);
  throw new OsbError('LOCATION_AMBIGUOUS', {
    human_action: namesSeveralPlaces(
      text,
      candidates.map((c) => c.display),
    ),
    candidates,
  });
}

/** Every gate a free-text location passes before anything places it. */
function refuseUnplaceable(text: string): void {
  refuseRegion(text);
  refuseCountry(text);
  refuseAmbiguous(text);
}

/**
 * Resolve a card's geo into stored columns, and say what it resolved to.
 *
 * Throws a machine-readable LOCATION_UNRESOLVED when the text is a street
 * address, names nothing the gazetteer knows, or names an area too wide to
 * put a person in — a state, a country, a country code. Throws
 * LOCATION_AMBIGUOUS, with the candidates, when several real cities answer to
 * the name and none of them plainly owns it.
 *
 * The reach rides through untouched by any of that: it is a statement about
 * the human, not about the map, and there is nothing in it to resolve. It is
 * stored only when it is not the default, so a card written before reach
 * existed and a card that means the same thing look the same in the database.
 */
export function normaliseGeo(geo: any): NormalisedGeo {
  const place: string | undefined =
    typeof geo?.place === 'string' && geo.place.trim() ? geo.place.trim() : undefined;
  const bucket: string | undefined =
    typeof geo?.bucket === 'string' && geo.bucket.trim() ? geo.bucket.trim() : undefined;
  const reach = reachOfGeo(geo);
  const reachField = reach === 'radius' ? {} : { reach };

  if (!place && !bucket) {
    throw new OsbError('LOCATION_UNRESOLVED', { human_action: NAME_A_PLACE });
  }

  /** What a resolved hit becomes, wherever the name came from. */
  const placed = (name: string, hit: Place): NormalisedGeo => {
    const radius = clampRadius(geo.radius_km, hit.reach_km);
    return {
      geo: {
        place: name,
        bucket: encodeGeohash(hit.lat, hit.lon, 4),
        radius_km: radius,
        ...reachField,
      },
      lat: hit.lat,
      lon: hit.lon,
      radius_km: radius,
      reach,
      country: hit.country,
      resolved: {
        name: hit.name,
        country: hit.country,
        kind: hit.kind,
        // Where the card is AND how far it goes, in one line: the two things
        // its human has to be able to check at a glance.
        display: `${describePlace(hit)} — ${describeReach(reach, radius, hit.country)}`,
      },
    };
  };

  // A named locality wins over a bucket: the switchboard resolves it and
  // writes the canonical cell itself.
  if (place) {
    if (looksLikeStreetAddress(place)) {
      throw new OsbError('LOCATION_UNRESOLVED', {
        human_action: `'${place}' reads like a street address. ${NAME_A_PLACE}`,
      });
    }
    refuseUnplaceable(place);
    const hit = resolvePlace(place);
    if (!hit) {
      throw new OsbError('LOCATION_UNRESOLVED', {
        human_action: `The switchboard does not know '${place}'. Try the nearest city or the region it sits in.`,
      });
    }
    return placed(place, hit);
  }

  // A canonical cell: decode it to the centre of the cell. A bare cell was
  // never a named place, so nothing here knows which country it is in.
  if (isGeohash(bucket!)) {
    const c = decodeGeohash(bucket!);
    const radius = clampRadius(geo.radius_km, Math.round(c.cellKm));
    return {
      geo: { bucket: bucket!, radius_km: radius, ...reachField },
      lat: c.lat,
      lon: c.lon,
      radius_km: radius,
      reach,
      country: null,
    };
  }

  // An invented bucket ("canberra", "AU-ACT", "AU"): the gazetteer gets a
  // turn, and what it finds becomes the card's place and canonical cell. A
  // bucket too wide or too shared to place is refused the way a place would be.
  refuseUnplaceable(bucket!);
  const hit = resolvePlace(bucket!);
  if (hit) return placed(bucket!, hit);

  // Nothing answers to it. The card keeps the string and meets only cards
  // carrying the same one (pre-0.3.0 compatibility). With no country to
  // reach across, a reach of "country" falls back to the radius it has.
  const radius = clampRadius(geo.radius_km, DEFAULT_RADIUS_KM);
  return {
    geo: { bucket: bucket!, radius_km: radius, ...reachField },
    lat: null,
    lon: null,
    radius_km: radius,
    reach,
    country: null,
  };
}
