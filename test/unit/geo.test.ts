import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  decodeGeohash,
  encodeGeohash,
  haversineKm,
  isGeohash,
} from '../../src/geo/geohash.js';
import {
  allRows,
  countryNameOf,
  countryNamed,
  describePlace,
  gazetteerSource,
  looksLikeStreetAddress,
  normaliseKey,
  placeAt,
  regionNamed,
  resolveFullPlace,
  resolveOwnArea,
  resolvePlace,
} from '../../src/geo/gazetteer.js';
import { countryOfTimeZone } from '../../src/geo/homeCountry.js';
import {
  MAX_RADIUS_KM,
  PLACE_NOT_FULL,
  describeReach,
  describeStoredGeo,
  describeStoredReach,
  geoOf,
  normaliseGeo,
} from '../../src/geo/normalise.js';
import { REACH_GEO_CLOSENESS, evaluateGeo, evaluatePair } from '../../src/domain/matchRules.js';
import { lintHumanCopy } from '../../src/email/lint.js';
import { OsbError } from '../../src/protocol.js';

/** The full forms the tests post with: town, state and country. */
const CANBERRA = 'Canberra, ACT, Australia';
const PERTH_WA = 'Perth, Western Australia, Australia';
const AUCKLAND = 'Auckland, New Zealand';
const GLASGOW = 'Glasgow, Scotland, United Kingdom';

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

  it('a short or shouted token has to match a place name outright', () => {
    // The incident: GeoNames hangs airport codes off populated places, so
    // "ACT" answered to Waco, Texas and "TAS" to Tashkent. A card reading
    // "ACT" went to a geohash cell 14,000 km from Canberra.
    expect(resolvePlace('ACT')).toBeUndefined();
    expect(resolvePlace('TAS')).toBeUndefined();
    expect(resolvePlace('QLD')).toBeUndefined();
    // Real short names still resolve, by their own name.
    const yass = resolvePlace('Yass')!;
    expect(yass.country).toBe('AU');
    expect(haversineKm(yass, { lat: -34.8404, lon: 148.9099 })).toBeLessThan(5);
    expect(resolvePlace('Waco')!.country).toBe('US');
    expect(resolvePlace('Oslo')!.country).toBe('NO');
    // A written-out name keeps every spelling the source data carries.
    expect(resolvePlace('Cracow')!.name).toBe(resolvePlace('Krakow')!.name);
  });

  it('a name a bigger place merely answers to goes to the places that own it', () => {
    // The defect (Lachlan, 13 September 2026): bare "Franklin" resolved to
    // Columbus, Ohio — an alternate spelling the dump hangs off a city of
    // 900,000, which beat every real Franklin on population. The lenient
    // reader still holds to that; a posting never reaches it, because a bare
    // name is not a full place (26 September 2026).
    const franklin = resolvePlace('Franklin')!;
    expect(normaliseKey(franklin.name)).toBe('franklin');
    expect(resolveFullPlace('Franklin').kind).toBe('not_full');

    // The same rule, the other way: nothing is called "Cracow", so the
    // alternate spelling still answers, and "New York" is still carried by
    // the place whose own name says it.
    expect(resolvePlace('Cracow')!.name).toBe(resolvePlace('Krakow')!.name);
    expect(resolvePlace('Sao Paulo')!.kind).toBe('city');
    expect(resolvePlace('Newtown')!.name).toBe('Newtown');
  });

  it('takes a hint written without a comma, the way people type it', () => {
    // The second defect: "Newtown NSW" resolved to nothing while "Newtown,
    // NSW" resolved fine. The data has the suburb; the parsing wanted a comma.
    for (const [spaced, commad] of [
      ['Newtown NSW', 'Newtown, NSW'],
      ['Franklin ACT', 'Franklin, ACT'],
      ['Braddon ACT', 'Braddon, ACT'],
      ['Springfield IL', 'Springfield, IL'],
      ['Perth Scotland', 'Perth, Scotland'],
      ['Richmond Australia', 'Richmond, Australia'],
    ] as [string, string][]) {
      const a = resolvePlace(spaced);
      const b = resolvePlace(commad)!;
      expect(a, spaced).toBeDefined();
      expect(haversineKm(a!, b), spaced).toBeLessThan(1);
    }
    // Nothing is taken apart that reads as one name on its own.
    expect(resolvePlace('New York')!.name).toBe('New York');
    expect(resolvePlace('Surry Hills')!.name).toBe('Surry Hills');
    // And the refusals hold: a whole country with its own code after it is
    // still a whole country, not a village in Cuba that shares the spelling.
    expect(resolvePlace('Australia AU')).toBeUndefined();
    expect(resolvePlace('New South Wales Australia')).toBeUndefined();
    expect(resolvePlace('Nowhereville NSW')).toBeUndefined();
  });

  it('names the state or territory behind a bare region string', () => {
    expect(regionNamed('ACT')).toBe('Australian Capital Territory');
    expect(regionNamed('NSW')).toBe('New South Wales');
    expect(regionNamed('WA')).toBe('Western Australia');
    expect(regionNamed('Texas')).toBe('Texas');
    expect(regionNamed('New South Wales')).toBe('New South Wales');
    // Not regions: real places, the deliberate division forms, a country
    // code, and a name a hint can settle.
    for (const s of [
      'Canberra',
      'Fremantle',
      'Waco',
      'Yass',
      'Tokyo',
      'Victoria',
      'AU-ACT',
      'US-CA',
      'AU',
      'CA',
      'Australia',
      'Perth, WA',
      'Wa, Ghana',
    ]) {
      expect(regionNamed(s), s).toBeUndefined();
    }
  });

  it('names the country behind a bare country string', () => {
    expect(countryNamed('AU')).toBe('Australia');
    expect(countryNamed('AUS')).toBe('Australia');
    expect(countryNamed('Australia')).toBe('Australia');
    expect(countryNamed('US')).toBe('United States');
    // "CA" is Canada, the way it always was.
    expect(countryNamed('CA')).toBe('Canada');
    // Not countries: towns, the deliberate division forms, anything a comma
    // settles, and a country whose name a real city owns.
    for (const s of ['Canberra', 'Fremantle', 'AU-ACT', 'US-CA', 'Australia, AU', 'Singapore']) {
      expect(countryNamed(s), s).toBeUndefined();
    }
  });

  // -------------------------------------------------------------------------
  // THE FULL PLACE (26 September 2026). The founder's decision: a posting's
  // place is town, state and country, and the switchboard never guesses. Size,
  // the human's own country and every "largest wins" are gone from placing.
  // -------------------------------------------------------------------------
  it('takes a place written in full, by name or by code', () => {
    const full = (s: string) => {
      const a = resolveFullPlace(s);
      expect(a.kind, s).toBe('place');
      return a.kind === 'place' ? describePlace(a.place) : '';
    };
    expect(full('Hobart, Tasmania, Australia')).toBe('Hobart, Tasmania, Australia');
    // Abbreviations inside the full form resolve where they are unambiguous.
    expect(full('Hobart, TAS, AU')).toBe('Hobart, Tasmania, Australia');
    expect(full('Hobart, Tas, Australia')).toBe('Hobart, Tasmania, Australia');
    expect(full(CANBERRA)).toBe('Canberra, Australian Capital Territory, Australia');
    expect(full('Canberra, ACT, AUS')).toBe('Canberra, Australian Capital Territory, Australia');
    expect(full('Franklin, Tasmania, Australia')).toBe('Franklin, Tasmania, Australia');
    expect(full('Franklin, ACT, AU')).toBe('Franklin, Australian Capital Territory, Australia');
    expect(full('Perth, WA, AU')).toBe(PERTH_WA);
    expect(full('Perth, Scotland, GB')).toBe('Perth, Scotland, United Kingdom');
    expect(full('Springfield, IL, US')).toBe('Springfield, Illinois, United States');
    expect(full('Newcastle, NSW, AU')).toBe('Newcastle, New South Wales, Australia');
    // "UK" is what people write; ISO reserves it for the country coded GB.
    expect(full('Glasgow, Scotland, UK')).toBe(GLASGOW);
    // A town sharing its region's name needs no region; a city-state needs its
    // country written after it all the same.
    expect(full('Mexico City, Mexico')).toBe('Mexico City, Mexico');
    expect(full(AUCKLAND)).toBe('Auckland, New Zealand');
    expect(full('Singapore, Singapore')).toBe('Singapore, Singapore');
  });

  it('never guesses: anything short of the full place is not full', () => {
    for (const s of [
      // Bare names, big and small, shared and not.
      'Hobart',
      'Perth',
      'Paris',
      'Canberra',
      'Franklin',
      'Newcastle',
      'Nowhereville',
      // A town without its state, or without its country.
      'Hobart, Tasmania',
      'Hobart, Australia',
      'Perth, Scotland',
      'Franklin, ACT',
      // Regions and countries, however they are written.
      'ACT',
      'NSW',
      'AU-ACT',
      'US-CA',
      'New South Wales, Australia',
      'Australia',
      'AU',
      // Spaced hints are not taken apart: commas say where the parts are.
      'Franklin ACT Australia',
      '',
    ]) {
      expect(resolveFullPlace(s).kind, s).toBe('not_full');
    }
  });

  it('says it does not know a full place written wrongly, rather than moving it', () => {
    // Hobart is in Tasmania. Written as Victoria, it is not quietly put back.
    for (const s of ['Hobart, Victoria, Australia', 'Nowhereville, NSW, Australia', 'Hobart, Tasmania, Canada']) {
      expect(resolveFullPlace(s).kind, s).toBe('unknown');
    }
  });

  it('prefers the town the name belongs to over one that merely contains it', () => {
    // Gobernador Galvez is bigger than Galvez; "Galvez" is still Galvez.
    const a = resolveFullPlace('Galvez, Santa Fe, Argentina');
    expect(a.kind).toBe('place');
    expect(a.kind === 'place' && a.place.name).toBe('Galvez');
  });

  it("reads the human's own area without size, and with their clock's country", () => {
    // The area box is a person typing their own suburb. It settles where one
    // town answers, or one of the towns that do is in their own country.
    const own = (s: string, country?: string) => {
      const p = resolveOwnArea(s, country ? { country } : {});
      return p ? describePlace(p) : undefined;
    };
    expect(own('Hobart', 'AU')).toBe('Hobart, Tasmania, Australia');
    expect(own('Newcastle', 'AU')).toBe('Newcastle, New South Wales, Australia');
    expect(own('Franklin, Tasmania')).toBe('Franklin, Tasmania, Australia');
    expect(own('Franklin, ACT')).toBe('Franklin, Australian Capital Territory, Australia');
    expect(own('Braddon, Australian Capital Territory')).toBe(
      'Braddon, Australian Capital Territory, Australia',
    );
    expect(own('Newtown NSW')).toBe('Newtown, New South Wales, Australia');
    expect(own('Canberra')).toBe('Canberra, Australian Capital Territory, Australia');
    expect(own(CANBERRA)).toBe('Canberra, Australian Capital Territory, Australia');
    // Nothing is settled by size: Hobart is nine times Hobart, Indiana, and
    // with no clock to say which country, the name is still two places.
    expect(own('Hobart')).toBeUndefined();
    expect(own('Paris')).toBeUndefined();
    // Two of the name in their own country leaves it unsettled.
    expect(own('Franklin', 'AU')).toBeUndefined();
    // A state or a country is not a town.
    expect(own('ACT', 'AU')).toBeUndefined();
    expect(own('Australia', 'AU')).toBeUndefined();
  });

  it('whatever the own area settles to is a place a posting takes as written', () => {
    for (const [s, country] of [
      ['Hobart', 'AU'],
      ['Newcastle', 'AU'],
      ['Franklin, Tasmania', undefined],
      ['Braddon, Australian Capital Territory', undefined],
      ['Newtown NSW', undefined],
      ['Fremantle', undefined],
    ] as [string, string | undefined][]) {
      const p = resolveOwnArea(s, country ? { country } : {})!;
      expect(p, s).toBeDefined();
      const back = resolveFullPlace(describePlace(p));
      expect(back.kind, s).toBe('place');
      expect(back.kind === 'place' && haversineKm(back.place, p), s).toBeLessThan(1);
    }
  });

  it('writes a place out in full', () => {
    expect(describePlace(resolvePlace('Canberra')!)).toBe(
      'Canberra, Australian Capital Territory, Australia',
    );
    expect(describePlace(resolvePlace('AU-ACT')!)).toBe(
      'Australian Capital Territory, Australia',
    );
    expect(describePlace(resolvePlace('Perth, Scotland')!)).toBe('Perth, Scotland, United Kingdom');
    expect(describePlace(resolvePlace('Australia')!)).toBe('Australia');
    // A town always carries its country, even one that shares the name, so
    // the written-out form is always one a posting takes.
    expect(describePlace(resolvePlace('Singapore')!)).toBe('Singapore, Singapore');
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
    const n = normaliseGeo({ place: CANBERRA, radius_km: 25 });
    expect(n.geo).toEqual({ place: CANBERRA, bucket: 'r3dp', radius_km: 25 });
    expect(n.lat).toBeCloseTo(-35.28, 1);
    expect(n.lon).toBeCloseTo(149.13, 1);
    expect(n.resolved?.name).toBe('Canberra');
  });

  it('an unstated radius takes the width of the named town', () => {
    expect(normaliseGeo({ place: CANBERRA }).radius_km).toBeGreaterThan(0);
    // A whole state is no longer somewhere a posting can be: wide is a reach.
    expect(err(() => normaliseGeo({ place: 'AU-WA' })).payload.code).toBe('LOCATION_NOT_FULL');
  });

  it('a radius above the protocol ceiling is clamped', () => {
    expect(normaliseGeo({ place: CANBERRA, radius_km: 5000 }).radius_km).toBe(MAX_RADIUS_KM);
  });

  it('a geohash bucket decodes to the centre of its cell', () => {
    const n = normaliseGeo({ bucket: 'qd66', radius_km: 25 });
    expect(n.geo.bucket).toBe('qd66');
    expect(n.geo.place).toBeUndefined();
    const c = decodeGeohash('qd66');
    expect(n.lat).toBe(c.lat);
    expect(n.lon).toBe(c.lon);
  });

  it('an invented bucket is placed only when it is written in full', () => {
    const full = normaliseGeo({ bucket: CANBERRA, radius_km: 25 });
    expect(full.geo).toEqual({ place: CANBERRA, bucket: 'r3dp', radius_km: 25 });
    // A bare name or a division code on the map is refused the way a place
    // is (26 September 2026): the biggest answer is no longer taken for it.
    for (const bucket of ['canberra', 'AU-ACT', 'ACT', 'AU']) {
      expect(err(() => normaliseGeo({ bucket, radius_km: 25 })).payload.code, bucket).toBe(
        'LOCATION_NOT_FULL',
      );
    }
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
    const inFull = err(() => normaliseGeo({ place: '12 Smith St, Hobart, Tasmania, Australia' }));
    expect(inFull.payload.code).toBe('LOCATION_UNRESOLVED');
    expect(inFull.payload.human_action).toMatch(/street address/i);
  });

  it('refuses a full place it cannot find, and says what to check', () => {
    const e = err(() => normaliseGeo({ place: 'Nowhereville, NSW, Australia' }));
    expect(e.payload.code).toBe('LOCATION_UNRESOLVED');
    expect(e.payload.human_action).toMatch(/does not know/i);
    expect(e.payload.human_action).toMatch(/town, state and country/i);
  });

  it('refuses anything not written in full with one fixed sentence and no list', () => {
    // A bare name however big, a shared name however lopsided, a town missing
    // its state or country, a state, a country, a division code: one code,
    // one sentence, no candidates, no foreign towns offered.
    for (const place of [
      'Hobart',
      'Perth',
      'Paris',
      'Franklin',
      'Newcastle',
      'Canberra',
      'Nowhereville',
      'Hobart, Tasmania',
      'Hobart, Australia',
      'Perth, Scotland',
      'Franklin ACT',
      'Newtown NSW',
      'ACT',
      'NSW',
      'WA',
      'Texas',
      'New South Wales',
      'New South Wales, Australia',
      'AU',
      'AUS',
      'Australia',
      'US',
      'AU-ACT',
      'Q'.repeat(80),
    ]) {
      const e = err(() => normaliseGeo({ place, radius_km: 25 }));
      expect(e.payload.code, place).toBe('LOCATION_NOT_FULL');
      expect(e.payload.human_action, place).toBe(PLACE_NOT_FULL);
      expect(e.payload.candidates, place).toBeUndefined();
    }
    expect(PLACE_NOT_FULL).toMatch(/town, state and country/);
    expect(PLACE_NOT_FULL).toContain('Hobart, Tasmania, Australia');
    expect(PLACE_NOT_FULL.length).toBeLessThanOrEqual(300);
    expect(lintHumanCopy(PLACE_NOT_FULL)).toEqual([]);
  });

  it('one town written two full ways lands in one cell', () => {
    const a = normaliseGeo({ place: 'Franklin, ACT, Australia', radius_km: 25 });
    const b = normaliseGeo({ place: 'Franklin, Australian Capital Territory, AU', radius_km: 25 });
    expect(a.geo.bucket).toBe(b.geo.bucket);
    expect(a.resolved!.display).toContain('Australian Capital Territory');
    const scotland = normaliseGeo({ place: 'Perth, Scotland, GB', radius_km: 25 });
    expect(scotland.resolved!.country).toBe('GB');
    expect(
      haversineKm({ lat: scotland.lat!, lon: scotland.lon! }, { lat: 56.3959, lon: -3.4308 }),
    ).toBeLessThan(10);
  });

  it('says out loud where it put the card, and how far it reaches', () => {
    expect(normaliseGeo({ place: CANBERRA, radius_km: 150 }).resolved!.display).toBe(
      'Canberra, Australian Capital Territory, Australia — matching within 150 km',
    );
    expect(normaliseGeo({ bucket: CANBERRA }).resolved!.display).toContain(
      'Australian Capital Territory',
    );
    // A bare cell was never a named place, so there is nothing to read back.
    expect(normaliseGeo({ bucket: 'qd66' }).resolved).toBeUndefined();
  });

  it('reads a stored card location back for the main page', () => {
    // Postings already up keep reading back, however their place was written.
    expect(describeStoredGeo({ place: 'Canberra', bucket: 'r3dp', radius_km: 25 })).toBe(
      'Canberra, Australian Capital Territory, Australia',
    );
    expect(describeStoredGeo({ place: CANBERRA, bucket: 'r3dp', radius_km: 25 })).toBe(
      'Canberra, Australian Capital Territory, Australia',
    );
    // A place the gazetteer no longer answers to keeps its own string.
    expect(describeStoredGeo({ place: 'Nowhereville', bucket: 'r3dp' })).toBe('Nowhereville');
    expect(describeStoredGeo({ bucket: 'g_a3f1' })).toBe('g_a3f1');
  });

  it('the towns inside those regions still place exactly where they are', () => {
    for (const [place, lat, lon] of [
      [CANBERRA, -35.2835, 149.1281],
      ['Fremantle, WA, Australia', -32.0563, 115.7456],
      ['Waco, Texas, United States', 31.5493, -97.1467],
      ['Yass, NSW, Australia', -34.8404, 148.9099],
    ] as [string, number, number][]) {
      const n = normaliseGeo({ place, radius_km: 25 });
      expect(haversineKm({ lat: n.lat!, lon: n.lon! }, { lat, lon }), place).toBeLessThan(5);
    }
    // The incident, in one line: "ACT" must never land in the Waco cell.
    expect(normaliseGeo({ place: 'Waco, TX, US' }).geo.bucket).toBe('9vdg');
    expect(() => normaliseGeo({ place: 'ACT' })).toThrow();
  });

  it('refuses a geo with nothing to centre on', () => {
    expect(err(() => normaliseGeo({ radius_km: 25 })).payload.code).toBe('LOCATION_UNRESOLVED');
  });

  it('human_action stays inside the protocol ceiling for a long place name', () => {
    const long = 'Q'.repeat(80);
    expect(err(() => normaliseGeo({ place: long })).payload.human_action!.length)
      .toBeLessThanOrEqual(300);
    expect(err(() => normaliseGeo({ place: `${long}, ${long}, ${long}` })).payload.human_action!.length)
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
    const a = normaliseGeo({ place: CANBERRA, radius_km: 25 });
    const b = normaliseGeo({ place: 'Canberra, Australian Capital Territory, AU', radius_km: 25 });
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
      reach: 'radius',
      country: null,
    });
    const unplaced = geoOf({ geo: { bucket: 'g_a3f1', radius_km: 25 }, geo_lat: null, geo_lon: null });
    expect(unplaced.lat).toBeNull();
    expect(unplaced.radius_km).toBe(25);
  });

  it('carries the stored reach and country into the matching input', () => {
    const g = geoOf({
      geo: { place: 'Canberra', bucket: 'r3dp', radius_km: 25, reach: 'country' },
      geo_lat: -35.2835,
      geo_lon: 149.1281,
      geo_radius_km: 25,
      geo_country: 'AU',
    });
    expect(g.reach).toBe('country');
    expect(g.country).toBe('AU');
  });
});

// ---------------------------------------------------------------------------
// Reach. Where a card is and how far its owner will go are two questions, and
// until this existed a card could only answer the first.
// ---------------------------------------------------------------------------
describe('reach', () => {
  /** A card as the matching engine sees it, from its own resolved place. */
  const card = (place: string, reach?: 'country' | 'anywhere', radius_km = 25) => {
    const n = normaliseGeo({ place, radius_km, ...(reach ? { reach } : {}) });
    return {
      bucket: n.geo.bucket,
      lat: n.lat,
      lon: n.lon,
      radius_km: n.radius_km,
      reach: n.reach,
      country: n.country,
    };
  };

  it('resolves a place and keeps the country it landed in', () => {
    const n = normaliseGeo({ place: CANBERRA, reach: 'country', radius_km: 25 });
    expect(n.country).toBe('AU');
    expect(n.reach).toBe('country');
    // The reach is stored on the card; the place is still a real town.
    expect(n.geo).toEqual({
      place: CANBERRA,
      bucket: 'r3dp',
      radius_km: 25,
      reach: 'country',
    });
  });

  it('leaves the stored geo alone when the reach is the default', () => {
    // Every card written before reach existed meant this, so it has to look
    // exactly like one.
    expect(normaliseGeo({ place: CANBERRA, reach: 'radius', radius_km: 25 }).geo).toEqual({
      place: CANBERRA,
      bucket: 'r3dp',
      radius_km: 25,
    });
    expect(normaliseGeo({ place: CANBERRA, radius_km: 25 }).reach).toBe('radius');
  });

  it('a nationwide pair meets across a country, and stops at its border', () => {
    // Canberra to Perth is about 3,100 km: no radius reaches it.
    const canberra = card(CANBERRA, 'country');
    const perth = card(PERTH_WA, 'country');
    const auckland = card(AUCKLAND, 'country');
    expect(evaluateGeo(canberra, perth).compatible).toBe(true);
    expect(evaluateGeo(canberra, auckland).compatible).toBe(false);
    // And the radius pair those same two places make is still refused.
    expect(evaluateGeo(card(CANBERRA), card(PERTH_WA)).compatible).toBe(false);
  });

  it('both sides have to reach: nationwide alone is not enough', () => {
    // The person collecting has to be as willing to cross the distance as
    // the person sending, or nobody is going anywhere.
    const nationwide = card(CANBERRA, 'country');
    const local = card(PERTH_WA);
    expect(evaluateGeo(nationwide, local).compatible).toBe(false);
    expect(evaluateGeo(local, nationwide).compatible).toBe(false);
  });

  it('anywhere meets anywhere, across countries', () => {
    const canberra = card(CANBERRA, 'anywhere');
    const auckland = card(AUCKLAND, 'anywhere');
    const glasgow = card(GLASGOW, 'anywhere');
    expect(evaluateGeo(canberra, auckland).compatible).toBe(true);
    expect(evaluateGeo(canberra, glasgow).compatible).toBe(true);
    // Anywhere covers a nationwide card only when it is in that country too.
    expect(evaluateGeo(canberra, card(PERTH_WA, 'country')).compatible).toBe(true);
    expect(evaluateGeo(canberra, card(AUCKLAND, 'country')).compatible).toBe(false);
  });

  it('scores a reach match flat and moderate, not as though it were adjacent', () => {
    const far = evaluateGeo(card(CANBERRA, 'country'), card(PERTH_WA, 'country'));
    expect(far.closeness).toBe(REACH_GEO_CLOSENESS);
    expect(far.closeness).toBeLessThan(
      evaluateGeo(card(CANBERRA), card(CANBERRA)).closeness,
    );
    // A pair that is ALSO close keeps its distance score: saying you would
    // post it should never cost you the neighbour who would walk over.
    const near = evaluateGeo(card(CANBERRA, 'country'), card(CANBERRA, 'country'));
    expect(near.closeness).toBe(1);
  });

  it('a card the switchboard could not place keeps radius behaviour', () => {
    // No country code, so there is no country to reach across.
    const unplaced = { bucket: 'g_a3f1', radius_km: 25, reach: 'country' as const, country: null };
    expect(evaluateGeo(unplaced, { ...unplaced }).compatible).toBe(true);
    expect(
      evaluateGeo(unplaced, { bucket: 'g_b7c2', radius_km: 25, reach: 'country' as const, country: null })
        .compatible,
    ).toBe(false);
    // Against a placed card it is still the string comparison that decides.
    expect(evaluateGeo(unplaced, card(CANBERRA, 'country')).compatible).toBe(false);
  });

  it('reads the reach back in plain words, all three ways', () => {
    expect(normaliseGeo({ place: CANBERRA, reach: 'country' }).resolved!.display).toBe(
      'Canberra, Australian Capital Territory, Australia — reaching all of Australia',
    );
    expect(normaliseGeo({ place: CANBERRA, reach: 'anywhere' }).resolved!.display).toBe(
      'Canberra, Australian Capital Territory, Australia — reaching anywhere',
    );
    expect(normaliseGeo({ place: CANBERRA, radius_km: 25 }).resolved!.display).toBe(
      'Canberra, Australian Capital Territory, Australia — matching within 25 km',
    );
  });

  it('reads a stored card back the same way, for the ledger', () => {
    expect(describeStoredReach({ place: 'Canberra', reach: 'country' }, 'AU', 25)).toBe(
      'reaching all of Australia',
    );
    expect(describeStoredReach({ place: 'Canberra', reach: 'anywhere' }, 'AU', 25)).toBe(
      'reaching anywhere',
    );
    expect(describeStoredReach({ place: 'Canberra' }, 'AU', 150)).toBe('matching within 150 km');
    // A card whose country was never worked out still says something true.
    expect(describeReach('country', 25, null)).toBe('reaching its whole country');
  });

  it('refuses a country as a place, with the one sentence', () => {
    // Until 26 September 2026 a country earned its own sentence pointing at
    // reach. Every place that is not written in full now earns the same one;
    // what reach means is on publish_intent, where the argument is filled in.
    const e = err(() => normaliseGeo({ place: 'Australia' }));
    expect(e.payload.code).toBe('LOCATION_NOT_FULL');
    expect(e.payload.human_action).toBe(PLACE_NOT_FULL);
  });

  it('keeps that refusal inside the protocol ceiling for every country', () => {
    // The message carries a place name and a country name, and the protocol
    // caps human_action at 300 characters.
    for (const place of ['Australia', 'United States', 'Q'.repeat(80), 'AU', 'GB']) {
      const e = err(() => normaliseGeo({ place }));
      expect(e.payload.human_action!.length, place).toBeLessThanOrEqual(300);
    }
  });
});
describe('every name the asset carries', () => {
  /** Every lookup key in the bundled asset — the whole corpus of names an
   *  agent could plausibly send. */
  const everyKey = (): string[] => {
    const path = process.env.OSB_GAZETTEER_PATH ?? 'data/gazetteer.json.gz';
    return Object.keys(JSON.parse(gunzipSync(readFileSync(path)).toString('utf8')).index);
  };

  it('refuses every bare name with something an agent can act on', () => {
    // The whole corpus through the publish path's location gate. Nothing may
    // escape as a bare error (which would be a 500 on a card someone tried to
    // post), and since 26 September 2026 nothing bare is placed at all: a
    // lookup key is one name, and a posting's place is town, state and
    // country.
    const keys = everyKey();
    expect(keys.length).toBeGreaterThan(100_000);
    const broke: string[] = [];
    let placed = 0;
    for (const key of keys) {
      try {
        normaliseGeo({ place: key, radius_km: 25 });
        placed++;
      } catch (e: any) {
        if (!e?.payload?.code) broke.push(`${key}: ${e?.message}`);
      }
    }
    expect(broke.slice(0, 10)).toEqual([]);
    expect(placed).toBe(0);
  });

  it('places every town written out in full, where it is', () => {
    // The other half of the rule: every town in the asset, written the way the
    // switchboard writes it back (describePlace, which is also what an
    // assistant is handed as its human's area), is taken as it stands and
    // lands on a town written exactly that way. The handful that cannot are towns whose own name,
    // or whose country's name, carries a comma of its own ("Bonaire, Saint
    // Eustatius and Saba"), which a comma-separated place cannot say.
    const rows = allRows();
    const missed: string[] = [];
    let towns = 0;
    let unsayable = 0;
    rows.forEach((r, i) => {
      if (r[6] !== 0) return;
      towns++;
      const p = placeAt(i);
      if (p.name.includes(',') || (countryNameOf(p.country) ?? '').includes(',')) {
        unsayable++;
        return;
      }
      const written = describePlace(p);
      const a = resolveFullPlace(written);
      // Two towns of one name in one state are one written form, and the
      // larger stands for both; so the check is that the answer writes out
      // the same, not that it is the same row.
      const same = a.kind === 'place' && normaliseKey(describePlace(a.place)) === normaliseKey(written);
      if (!same) missed.push(`${written}: ${a.kind}`);
    });
    expect(towns).toBeGreaterThan(100_000);
    expect(unsayable).toBeLessThan(60);
    expect(missed.slice(0, 10)).toEqual([]);
  });
});

describe('which country a human is probably in', () => {
  it('reads a country off the zones the switchboard actually sees', () => {
    for (const [tz, cc] of [
      ['Australia/Sydney', 'AU'],
      ['Australia/Perth', 'AU'],
      ['Pacific/Auckland', 'NZ'],
      ['America/New_York', 'US'],
      ['America/Los_Angeles', 'US'],
      ['Pacific/Honolulu', 'US'],
      ['US/Eastern', 'US'],
      ['America/Toronto', 'CA'],
      ['America/St_Johns', 'CA'],
      ['Canada/Pacific', 'CA'],
      ['Europe/London', 'GB'],
      ['Europe/Dublin', 'IE'],
    ] as [string, string][]) {
      expect(countryOfTimeZone(tz), tz).toBe(cc);
    }
  });

  it('says nothing rather than guessing, for a zone it has no table for', () => {
    for (const tz of ['Europe/Paris', 'Asia/Tokyo', 'UTC', '', '   ', 'nonsense', null, undefined]) {
      expect(countryOfTimeZone(tz), String(tz)).toBeUndefined();
    }
  });

  it('has no say in where a posting goes', () => {
    // 26 September 2026: the publish path took a hint and settled "Hobart" for
    // an Australian account. It takes one argument now, and a bare name is
    // refused for everyone alike.
    expect(normaliseGeo.length).toBe(1);
    for (const place of ['Hobart', 'Newcastle', 'Franklin']) {
      expect(err(() => normaliseGeo({ place, radius_km: 25 })).payload.code, place).toBe(
        'LOCATION_NOT_FULL',
      );
    }
  });
});

describe('what the manual tells an agent about places', () => {
  // Version 40 gave the location ARGUMENT one home. What each reach means and
  // what the refusals are is on publish_intent, which is what an agent is
  // reading at the moment it posts; the manual keeps the judgement — where a
  // thing lives against how far a person will go, reading the resolved place
  // back in their own voice, and posting wide. Every rule these two tests held
  // is still held, on whichever of the two now carries it.
  it('says to read the resolved place back, and what the refusals mean', async () => {
    const { MANUAL_BODY } = await import('../../src/mcp/instructions.js');
    const { TOOLS } = await import('../../src/mcp/tools.js');
    const publish = TOOLS.find((t) => t.name === 'publish_intent')!.description;
    expect(MANUAL_BODY).toContain('location_resolved');
    expect(publish).toContain('location_resolved');
    // The refusals are a section of the manual now: read_manual("answers")
    // holds every refusal that is the switchboard working, these two included.
    expect(MANUAL_BODY).toContain('LOCATION_AMBIGUOUS');
    expect(MANUAL_BODY).toContain('LOCATION_UNRESOLVED');
    expect(MANUAL_BODY).toContain('LOCATION_NOT_FULL');
    expect(MANUAL_BODY).toMatch(/post again with the fuller form it gives you/i);
    // 26 September 2026: always the full place, town, state and country.
    expect(MANUAL_BODY).toMatch(/always write the place in full, town, state and country/i);
    expect(publish).toMatch(/`place` IS WRITTEN IN FULL, town, state and country/);
    // The register: the place goes into what the agent says, in its own voice.
    expect(MANUAL_BODY).toMatch(/say if that's wrong/i);
    expect(MANUAL_BODY).toMatch(/amend it there and then/i);
  });

  it('teaches place and reach as two different things, with the translation', async () => {
    const { MANUAL_BODY } = await import('../../src/mcp/instructions.js');
    const { TOOLS } = await import('../../src/mcp/tools.js');
    const publish = TOOLS.find((t) => t.name === 'publish_intent')!.description;
    expect(MANUAL_BODY).toContain('geo.reach');
    expect(MANUAL_BODY).toMatch(/lives where the thing lives/i);
    // The sentence an agent actually has to translate, in both homes: it is
    // the one a rehearsal showed being got wrong.
    expect(MANUAL_BODY).toMatch(/I'll post it anywhere in Australia/);
    // What each reach means is on the tool, where the argument is filled in,
    // in the short form the description budget allows.
    expect(publish).toMatch(/what happens online/);
    expect(publish).toMatch(/"country" for what goes in a parcel/);
    expect(publish).toMatch(/`reach` follows the THING/);
  });

  it('the reach change has a changelog note, and the log stays consistent', async () => {
    const { MANUAL, MANUAL_CHANGELOG } = await import('../../src/mcp/instructions.js');
    const latest = MANUAL_CHANGELOG[MANUAL_CHANGELOG.length - 1];
    expect(latest.version).toBe(MANUAL.version);
    expect(MANUAL_CHANGELOG.some((c) => /reach/i.test(c.note))).toBe(true);
  });
});

describe('the geo tool schema agents actually see', () => {
  it('offers place, keeps the cell, and stays grammar-friendly', async () => {
    const { TOOLS } = await import('../../src/mcp/tools.js');
    const publish = TOOLS.find((t) => t.name === 'publish_intent')!;
    const geo = publish.inputSchema.properties.listing.properties.geo;
    expect(Object.keys(geo.properties).sort()).toEqual(['bucket', 'place', 'radius_km', 'reach']);
    expect(geo.description).toMatch(/the town written in full, with its state and country/);
    expect(geo.properties.reach.enum).toEqual(['radius', 'country', 'anywhere']);
    // The rule the field exists for, at the point the model acts on it.
    expect(publish.description).toMatch(/`place` IS WRITTEN IN FULL, town, state and country, as `area_resolved` is/);
    // anyOf cannot be expressed by constrained-decoding grammar compilers; the
    // server validates every listing against the full schema regardless.
    const blob = JSON.stringify(publish.inputSchema);
    for (const k of ['$ref', '$defs', 'anyOf', 'oneOf', 'allOf', 'propertyNames', 'format']) {
      expect(blob, k).not.toContain(`"${k}"`);
    }
  });
});
