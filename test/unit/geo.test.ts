import { describe, expect, it } from 'vitest';
import {
  decodeGeohash,
  encodeGeohash,
  haversineKm,
  isGeohash,
} from '../../src/geo/geohash.js';
import {
  gazetteerSource,
  looksLikeStreetAddress,
  normaliseKey,
  resolvePlace,
} from '../../src/geo/gazetteer.js';
import { MAX_RADIUS_KM, geoOf, normaliseGeo } from '../../src/geo/normalise.js';
import { evaluateGeo, evaluatePair } from '../../src/domain/matchRules.js';
import { OsbError } from '../../src/protocol.js';

describe('geohash cells', () => {
  it('round-trips a point through a geohash4 cell', () => {
    const bucket = encodeGeohash(-35.2835, 149.1281, 4);
    expect(bucket).toBe('r3dp');
    expect(isGeohash(bucket)).toBe(true);
    const c = decodeGeohash(bucket);
    expect(haversineKm(c, { lat: -35.2835, lon: 149.1281 })).toBeLessThan(30);
  });

  it('decodes qd66 near Perth and r3gx near Sydney', () => {
    const perth = decodeGeohash('qd66');
    expect(perth.lat).toBeGreaterThan(-33);
    expect(perth.lat).toBeLessThan(-31);
    expect(perth.lon).toBeGreaterThan(115);
    expect(perth.lon).toBeLessThan(117);
    expect(haversineKm(perth, decodeGeohash('r3gx'))).toBeGreaterThan(2500);
  });

  it('haversine: known distances', () => {
    // Canberra -> Sydney is about 240 km.
    const d = haversineKm({ lat: -35.2835, lon: 149.1281 }, { lat: -33.8688, lon: 151.2093 });
    expect(d).toBeGreaterThan(220);
    expect(d).toBeLessThan(260);
    expect(haversineKm({ lat: 10, lon: 20 }, { lat: 10, lon: 20 })).toBe(0);
  });
});

describe('gazetteer', () => {
  it('ships a dated asset with a source line', () => {
    const s = gazetteerSource();
    expect(s.source).toMatch(/GeoNames/);
    expect(s.rows).toBeGreaterThan(100_000);
  });

  it('normalises lookup keys the way the builder did', () => {
    expect(normaliseKey('Kraków')).toBe('krakow');
    expect(normaliseKey("  O'Connor ")).toBe('oconnor');
    expect(normaliseKey('Newtown, NSW')).toBe('newtown nsw');
  });

  it('resolves an exact city name', () => {
    const p = resolvePlace('Canberra')!;
    expect(p.kind).toBe('city');
    expect(p.country).toBe('AU');
    expect(haversineKm(p, { lat: -35.2835, lon: 149.1281 })).toBeLessThan(5);
  });

  it('is case- and accent-insensitive, and resolves an alternate spelling', () => {
    expect(resolvePlace('canberra')!.name).toBe(resolvePlace('CANBERRA')!.name);
    const withAccent = resolvePlace('Kraków')!;
    const without = resolvePlace('Krakow')!;
    expect(withAccent.lat).toBe(without.lat);
    // 'Cracow' is an alternate spelling carried by the source data.
    const alt = resolvePlace('Cracow');
    expect(alt).toBeDefined();
    expect(haversineKm(alt!, without)).toBeLessThan(10);
  });

  it('resolves an ISO 3166-2 subdivision code', () => {
    const act = resolvePlace('AU-ACT')!;
    expect(act.kind).toBe('admin1');
    expect(act.country).toBe('AU');
    // The territory sits on top of the city that fills it.
    expect(haversineKm(act, resolvePlace('Canberra')!)).toBeLessThan(25);
    expect(resolvePlace('US-CA')!.name).toBe('California');
    // The GeoNames division code answers too.
    expect(resolvePlace('AU-01')!.name).toBe(act.name);
  });

  it('resolves a country by name and by code, with a wide reach', () => {
    const byCode = resolvePlace('AU')!;
    const byName = resolvePlace('Australia')!;
    const byIso3 = resolvePlace('AUS')!;
    expect(byCode.kind).toBe('country');
    expect(byName.lat).toBe(byCode.lat);
    expect(byIso3.lat).toBe(byCode.lat);
    expect(byCode.reach_km).toBeGreaterThan(200);
  });

  it('narrows an ambiguous name by a trailing hint', () => {
    const il = resolvePlace('Springfield, IL')!;
    expect(il.country).toBe('US');
    expect(il.lat).toBeGreaterThan(38);
    expect(il.lat).toBeLessThan(41);
    expect(resolvePlace('Richmond, Australia')!.country).toBe('AU');
  });

  it('answers nothing for a name it does not know', () => {
    expect(resolvePlace('Nowhereville')).toBeUndefined();
    expect(resolvePlace('')).toBeUndefined();
    expect(resolvePlace('   ')).toBeUndefined();
  });

  it('recognises a street address', () => {
    for (const s of [
      '12 Smith St',
      '12A Smith Street',
      '3/45 Northbourne Ave',
      'Unit 5, 12 Smith St',
      'Level 3, 100 George Street',
      'PO Box 42',
      'Smith St 12',
    ]) {
      expect(looksLikeStreetAddress(s), s).toBe(true);
    }
    for (const s of ['Canberra', 'Newtown, NSW', 'AU-ACT', 'Stratford-upon-Avon', 'Sankt Gallen']) {
      expect(looksLikeStreetAddress(s), s).toBe(false);
    }
  });
});

const err = (fn: () => unknown): OsbError => {
  try {
    fn();
  } catch (e) {
    return e as OsbError;
  }
  throw new Error('expected a refusal');
};

describe('card location normalisation', () => {
  it('a named place becomes a centre point, a canonical cell and a reach', () => {
    const n = normaliseGeo({ place: 'Canberra', radius_km: 25 });
    expect(n.geo).toEqual({ place: 'Canberra', bucket: 'r3dp', radius_km: 25 });
    expect(n.lat).toBeCloseTo(-35.28, 1);
    expect(n.lon).toBeCloseTo(149.13, 1);
    expect(n.resolved?.name).toBe('Canberra');
  });

  it('an unstated radius takes the width of the named area', () => {
    expect(normaliseGeo({ place: 'Canberra' }).radius_km).toBeGreaterThan(0);
    expect(normaliseGeo({ place: 'Australia' }).radius_km).toBeGreaterThan(100);
  });

  it('a radius above the protocol ceiling is clamped', () => {
    expect(normaliseGeo({ place: 'Canberra', radius_km: 5000 }).radius_km).toBe(MAX_RADIUS_KM);
  });

  it('a geohash bucket decodes to the centre of its cell', () => {
    const n = normaliseGeo({ bucket: 'qd66', radius_km: 25 });
    expect(n.geo.bucket).toBe('qd66');
    expect(n.geo.place).toBeUndefined();
    const c = decodeGeohash('qd66');
    expect(n.lat).toBe(c.lat);
    expect(n.lon).toBe(c.lon);
  });

  it('an invented bucket the gazetteer knows becomes a place and a canonical cell', () => {
    const canberra = normaliseGeo({ bucket: 'canberra', radius_km: 25 });
    expect(canberra.geo).toEqual({ place: 'canberra', bucket: 'r3dp', radius_km: 25 });
    const act = normaliseGeo({ bucket: 'AU-ACT', radius_km: 25 });
    expect(act.lat).not.toBeNull();
    // The whole point: these two used to be unequal strings.
    expect(haversineKm({ lat: canberra.lat!, lon: canberra.lon! }, { lat: act.lat!, lon: act.lon! }))
      .toBeLessThan(25);
  });

  it('a bucket nothing answers to keeps its string and stays unplaced', () => {
    const n = normaliseGeo({ bucket: 'g_a3f1', radius_km: 25 });
    expect(n.geo).toEqual({ bucket: 'g_a3f1', radius_km: 25 });
    expect(n.lat).toBeNull();
    expect(n.lon).toBeNull();
  });

  it('refuses a street address', () => {
    const e = err(() => normaliseGeo({ place: '12 Smith St' }));
    expect(e.payload.code).toBe('LOCATION_UNRESOLVED');
    expect(e.payload.human_action).toMatch(/street address/i);
  });

  it('refuses a place it cannot find, and says what to send instead', () => {
    const e = err(() => normaliseGeo({ place: 'Nowhereville' }));
    expect(e.payload.code).toBe('LOCATION_UNRESOLVED');
    expect(e.payload.human_action).toMatch(/nearest city|region/i);
  });

  it('refuses a geo with nothing to centre on', () => {
    expect(err(() => normaliseGeo({ radius_km: 25 })).payload.code).toBe('LOCATION_UNRESOLVED');
  });

  it('human_action stays inside the protocol ceiling for a long place name', () => {
    const long = 'Q'.repeat(80);
    expect(err(() => normaliseGeo({ place: long })).payload.human_action!.length)
      .toBeLessThanOrEqual(300);
  });
});

describe('distance matching', () => {
  const at = (lat: number, lon: number, radius_km: number, bucket = 'r3dp') => ({
    bucket,
    lat,
    lon,
    radius_km,
  });

  it('two cards in one city overlap however their agents spelled it', () => {
    const a = normaliseGeo({ place: 'Canberra', radius_km: 25 });
    const b = normaliseGeo({ place: 'AU-ACT', radius_km: 25 });
    const r = evaluateGeo(
      { bucket: a.geo.bucket, lat: a.lat, lon: a.lon, radius_km: a.radius_km },
      { bucket: b.geo.bucket, lat: b.lat, lon: b.lon, radius_km: b.radius_km },
    );
    expect(r.compatible).toBe(true);
    expect(r.closeness).toBeGreaterThan(0.8);
  });

  it('radii that reach each other overlap; radii that fall short do not', () => {
    const canberra = { lat: -35.2835, lon: 149.1281 };
    const sydney = { lat: -33.8688, lon: 151.2093 }; // ~240 km away
    expect(
      evaluateGeo(at(canberra.lat, canberra.lon, 150), at(sydney.lat, sydney.lon, 150)).compatible,
    ).toBe(true);
    expect(
      evaluateGeo(at(canberra.lat, canberra.lon, 50), at(sydney.lat, sydney.lon, 50)).compatible,
    ).toBe(false);
    // Exactly at the boundary the two still meet.
    const d = haversineKm(canberra, sydney);
    expect(
      evaluateGeo(at(canberra.lat, canberra.lon, d / 2), at(sydney.lat, sydney.lon, d / 2))
        .compatible,
    ).toBe(true);
  });

  it('closeness decays with distance across the combined reach', () => {
    const near = evaluateGeo(at(0, 0, 100), at(0, 0.1, 100));
    const far = evaluateGeo(at(0, 0, 100), at(0, 1.5, 100));
    expect(near.closeness).toBeGreaterThan(far.closeness);
    expect(near.closeness).toBeGreaterThan(0.9);
    expect(evaluateGeo(at(0, 0, 100), at(0, 0, 100)).closeness).toBe(1);
  });

  it('an unplaced bucket falls back to the pre-0.3.0 comparison', () => {
    expect(evaluateGeo({ bucket: 'g_a3f1' }, { bucket: 'g_a3f1' }).compatible).toBe(true);
    expect(evaluateGeo({ bucket: 'g_a3f1' }, { bucket: 'g_b7c2' }).compatible).toBe(false);
    expect(evaluateGeo({ bucket: 'AU-WA' }, { bucket: 'AU-WA-PER' }).compatible).toBe(true);
    // One side placed, the other not: the string comparison still decides.
    expect(
      evaluateGeo({ bucket: 'g_a3f1' }, { bucket: 'r3dp', lat: -35.28, lon: 149.13 }).compatible,
    ).toBe(false);
  });

  it('geo is a hard rule inside the pair evaluation', () => {
    const same = {
      semantic: 0.97,
      categoryA: 'goods.bicycle.mountain',
      categoryB: 'goods.bicycle.mountain',
    };
    expect(
      evaluatePair({ ...same, geoA: at(-35.28, 149.13, 25), geoB: at(-35.3, 149.11, 25) })
        .hardRulesPass,
    ).toBe(true);
    expect(
      evaluatePair({ ...same, geoA: at(-35.28, 149.13, 10), geoB: at(-31.95, 115.86, 10) }),
    ).toMatchObject({ hardRulesPass: false, failed: 'geo', score: 0 });
  });

  it('reads a stored card row as a matching input', () => {
    const g = geoOf({
      geo: { place: 'Canberra', bucket: 'r3dp', radius_km: 25 },
      geo_lat: -35.2835,
      geo_lon: 149.1281,
      geo_radius_km: 25,
    });
    expect(g).toEqual({
      bucket: 'r3dp',
      place: 'Canberra',
      radius_km: 25,
      lat: -35.2835,
      lon: 149.1281,
    });
    const unplaced = geoOf({ geo: { bucket: 'g_a3f1', radius_km: 25 }, geo_lat: null, geo_lon: null });
    expect(unplaced.lat).toBeNull();
    expect(unplaced.radius_km).toBe(25);
  });
});

describe('the geo tool schema agents actually see', () => {
  it('offers place, keeps the cell, and stays grammar-friendly', async () => {
    const { TOOLS } = await import('../../src/mcp/tools.js');
    const publish = TOOLS.find((t) => t.name === 'publish_intent')!;
    const geo = publish.inputSchema.properties.card.properties.geo;
    expect(Object.keys(geo.properties).sort()).toEqual(['bucket', 'place', 'radius_km']);
    expect(geo.description).toMatch(/suburb, city or region/);
    expect(publish.description).toMatch(/nearest suburb, city or region/);
    // anyOf cannot be expressed by constrained-decoding grammar compilers; the
    // server validates every card against the full schema regardless.
    const blob = JSON.stringify(publish.inputSchema);
    for (const k of ['$ref', '$defs', 'anyOf', 'oneOf', 'allOf', 'propertyNames', 'format']) {
      expect(blob, k).not.toContain(`"${k}"`);
    }
  });
});
