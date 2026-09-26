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
 * Resolution never guesses. Since 26 September 2026 a place is taken only
 * when it is written in full — town, state and country — and anything less
 * (a bare name, a state, a country) is refused with one fixed sentence saying
 * to write it out. What does resolve comes back written out in full, so the
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
  countryNameOf,
  countryNamed,
  describePlace,
  looksLikeStreetAddress,
  regionNamed,
  resolveFullPlace,
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
 * How a stored card's location reads on its owner's main page: the place
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
 * someone, in the same plain words on the main page and in the publish
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
  'Name the town in full, with its state and country (for example "Hobart, Tasmania, Australia"). Locations here are areas, never street addresses.';

/**
 * THE ONE SENTENCE FOR A PLACE NOT WRITTEN IN FULL (26 September 2026).
 *
 * The founder's decision: the switchboard never guesses which town was meant.
 * A bare name, a town without its state or country, a state, a country and a
 * division code are all refused the same way, with the same fixed sentence and
 * no list of candidates — a list is how a person in Hobart was once offered
 * four towns in Indiana. The sentence names the one thing to do, and points at
 * the form the switchboard already hands over for the human's own area, which
 * is written in full and passes as it is.
 *
 * Its own code, LOCATION_NOT_FULL, rather than LOCATION_AMBIGUOUS: that one
 * carries candidates and means "which of these", and this means "write it
 * out", which an assistant can do without asking anyone when the area on
 * file already says it.
 */
export const PLACE_NOT_FULL =
  'Write the place in full: town, state and country, for example "Hobart, Tasmania, Australia". Your human\'s own area on file is written that way already.';

const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

/** Written out, and nothing answers to it written that way. */
const doesNotKnow = (place: string) =>
  `The switchboard does not know '${clip(place, 80)}'. Check the town, state and country, or name the nearest town, written the same way.`;

/**
 * Written in full and still more than one town: the parts describe two places
 * at once. The candidates ride along, each written in full, so the agent asks
 * its human which and posts that one exactly as given.
 */
function namesSeveralPlaces(place: string, displays: string[]): string {
  const head = `'${clip(place, 40)}' names more than one place. Ask your human which, then post it exactly as written here:`;
  let msg = head;
  for (const d of displays) {
    const next = `${msg} ${d};`;
    if (next.length > 299) break;
    msg = next;
  }
  return msg === head ? `${head} ${clip(displays[0], 60)}.` : `${msg.slice(0, -1)}.`;
}

/** The place a posting's text names, or the refusal that says why not. */
function placeFromText(text: string): Place {
  const answer = resolveFullPlace(text);
  switch (answer.kind) {
    case 'place':
      return answer.place;
    case 'not_full':
      throw new OsbError('LOCATION_NOT_FULL', { human_action: PLACE_NOT_FULL });
    case 'unknown':
      throw new OsbError('LOCATION_UNRESOLVED', { human_action: doesNotKnow(text) });
    case 'several': {
      const candidates = answer.places.map((p) => {
        const full = describePlace(p);
        return { display: full, place: full };
      });
      throw new OsbError('LOCATION_AMBIGUOUS', {
        human_action: namesSeveralPlaces(text, candidates.map((c) => c.display)),
        candidates,
      });
    }
  }
}

/**
 * Resolve a card's geo into stored columns, and say what it resolved to.
 *
 * A `place` is taken only when it is written in full — town, state and
 * country (gazetteer.ts resolveFullPlace). Throws LOCATION_NOT_FULL for
 * anything less, LOCATION_UNRESOLVED for a street address or a full writing
 * nothing answers to, and LOCATION_AMBIGUOUS, with every candidate written
 * in full, in the rare case a full writing still describes two towns.
 *
 * Until 26 September 2026 this took a hint about the human's own country and
 * settled a shared name with it, and before that settled one by size. Both
 * are gone: nothing about who is posting changes where a posting goes.
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
    const hit = placeFromText(place);
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

  // An invented bucket ("canberra", "AU-ACT", "AU"). Written in full, it is
  // placed the way a place is. Anything less that still names somewhere on
  // the map is refused the way a place would be (26 September 2026): the
  // gazetteer used to pick the biggest of whatever answered to it, which is
  // the guess the posting path no longer makes.
  const bucketAnswer = resolveFullPlace(bucket!);
  if (bucketAnswer.kind === 'place') return placed(bucket!, bucketAnswer.place);
  const onTheMap = resolvePlace(bucket!) ?? regionNamed(bucket!) ?? countryNamed(bucket!);
  if (bucketAnswer.kind !== 'unknown' && onTheMap) placeFromText(bucket!);

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
