/**
 * Geohash cells and great-circle distance. Pure functions, no I/O.
 *
 * A geohash4 cell is the switchboard's canonical location bucket: roughly a
 * 40 x 20 km box, coarse enough that a card never points at a doorstep and
 * fine enough that two people in one city land in the same neighbourhood.
 */
export const GEOHASH32 = '0123456789bcdefghjkmnpqrstuvwxyz';

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

/** Encode a point as a geohash of the given precision (4 by default). */
export function encodeGeohash(lat: number, lon: number, precision = 4): string {
  let latMin = -90, latMax = 90, lonMin = -180, lonMax = 180;
  let even = true;
  let bit = 0;
  let idx = 0;
  let out = '';
  while (out.length < precision) {
    if (even) {
      const mid = (lonMin + lonMax) / 2;
      if (lon >= mid) { idx = idx * 2 + 1; lonMin = mid; } else { idx *= 2; lonMax = mid; }
    } else {
      const mid = (latMin + latMax) / 2;
      if (lat >= mid) { idx = idx * 2 + 1; latMin = mid; } else { idx *= 2; latMax = mid; }
    }
    even = !even;
    if (++bit === 5) {
      out += GEOHASH32[idx];
      bit = 0;
      idx = 0;
    }
  }
  return out;
}

export function haversineKm(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}
