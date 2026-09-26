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
  ambiguousPlaces,
  countryNamed,
  describePlace,
  gazetteerSource,
  looksLikeStreetAddress,
  normaliseKey,
  qualifyPlace,
  regionNamed,
  resolvePlace,
  resolvePlaceFor,
  settledInCountry,
} from '../../src/geo/gazetteer.js';
import { countryOfArea, countryOfTimeZone, homeCountry } from '../../src/geo/homeCountry.js';
import {
  MAX_RADIUS_KM,
  describeReach,
  describeStoredGeo,
  describeStoredReach,
  geoOf,
  normaliseGeo,
} from '../../src/geo/normalise.js';
import { REACH_GEO_CLOSENESS, evaluateGeo, evaluatePair } from '../../src/domain/matchRules.js';
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
    // 900,000, which beat every real Franklin on population. A person typing
    // the name of their suburb and landing on a city on another continent is
    // worse than landing nowhere.
    const franklin = resolvePlace('Franklin')!;
    expect(normaliseKey(franklin.name)).toBe('franklin');
    // And the name is in question anyway, so the posting path asks rather
    // than picks: the refuse-with-candidates path was always right here.
    const candidates = ambiguousPlaces('Franklin')!;
    expect(candidates.length).toBeGreaterThanOrEqual(2);
    for (const p of candidates) expect(normaliseKey(p.name)).toBe('franklin');

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

  it('lists the candidates when several cities answer to one bare name', () => {
    const perth = ambiguousPlaces('Perth')!;
    expect(perth.length).toBeGreaterThanOrEqual(2);
    expect(perth.length).toBeLessThanOrEqual(5);
    const displays = perth.map((p) => qualifyPlace(p).display);
    expect(displays).toContain('Perth, Western Australia, AU');
    expect(displays).toContain('Perth, Scotland, GB');
    // Largest first, so a human reads the likely one at the top.
    expect(perth[0].country).toBe('AU');
    for (const name of ['Richmond', 'Springfield', 'London', 'Victoria']) {
      expect(ambiguousPlaces(name)!.length, name).toBeGreaterThanOrEqual(2);
    }
  });

  it('every candidate carries the exact string that selects it', () => {
    for (const name of ['Perth', 'Richmond', 'Springfield', 'London']) {
      for (const p of ambiguousPlaces(name)!) {
        const choice = qualifyPlace(p);
        const back = resolvePlace(choice.place);
        expect(back, `${name}: ${choice.place}`).toBeDefined();
        expect(haversineKm(back!, p), choice.display).toBeLessThan(5);
      }
    }
  });

  it('a name one city plainly owns still resolves without asking', () => {
    // Paris is eighty times its nearest namesake, and no rival is a town in
    // its own right. Perth in Scotland is.
    for (const name of ['Paris', 'Canberra', 'Fremantle', 'Waco', 'Yass', 'Tokyo', 'Adelaide']) {
      expect(ambiguousPlaces(name), name).toBeUndefined();
    }
    expect(resolvePlace('Paris')!.country).toBe('FR');
    // A comma or a code already settles the question.
    for (const s of ['Perth, Scotland', 'Perth, WA', 'AU-ACT', 'AU']) {
      expect(ambiguousPlaces(s), s).toBeUndefined();
    }
  });

  it("offers the human's own country first when a name is shared", () => {
    // The rehearsal (19 September 2026): a person living in Franklin, ACT was
    // offered five Franklins, every one of them in the United States, and
    // their assistant told them truthfully that the name only resolved to US
    // cities. Both Australian Franklins were in the asset the whole time,
    // ranked off the end of the list by population.
    const plain = ambiguousPlaces('Franklin')!.map((p) => qualifyPlace(p).display);
    expect(plain.every((d) => d.endsWith(', US'))).toBe(true);

    const mine = ambiguousPlaces('Franklin', { country: 'AU' })!.map(
      (p) => qualifyPlace(p).display,
    );
    expect(mine[0]).toBe('Franklin, Australian Capital Territory, AU');
    expect(mine[1]).toBe('Franklin, Tasmania, AU');
    // Still five, and the American ones still in population order behind.
    expect(mine.length).toBe(5);
    expect(mine.slice(2)).toEqual(plain.slice(0, 3));
    // And every one of them still selects the place it names.
    for (const p of ambiguousPlaces('Franklin', { country: 'AU' })!) {
      expect(resolvePlace(qualifyPlace(p).place)!.country).toBe(p.country);
    }
  });

  it('leaves the order alone when the hint names a country without the name', () => {
    const plain = ambiguousPlaces('Franklin')!.map((p) => qualifyPlace(p).display);
    for (const cc of ['JP', 'FR', 'XX']) {
      expect(
        ambiguousPlaces('Franklin', { country: cc })!.map((p) => qualifyPlace(p).display),
        cc,
      ).toEqual(plain);
    }
    expect(ambiguousPlaces('Franklin', {})!.map((p) => qualifyPlace(p).display)).toEqual(plain);
  });

  it('a hint answers only where the human\'s own country holds one place of that name', () => {
    // A name one city plainly owns is still not put to anyone, hint or no
    // hint: an Australian typing "Sydney" is asked no more than anyone else.
    for (const name of ['Paris', 'Canberra', 'Adelaide', 'Tokyo']) {
      expect(ambiguousPlaces(name, { country: 'AU' }), name).toBeUndefined();
    }
    // 26 September 2026: an Australian account whose own area is Hobart was
    // offered Hobart, Indiana. One Hobart in Australia, so that is the answer.
    expect(ambiguousPlaces('Hobart')!.length).toBeGreaterThanOrEqual(2);
    expect(ambiguousPlaces('Hobart', { country: 'AU' })).toBeUndefined();
    expect(settledInCountry('Hobart', { country: 'AU' })!.admin1).toBeTruthy();
    expect(describePlace(resolvePlaceFor('Hobart', { country: 'AU' })!)).toContain('Tasmania');
    // The same for any country holding exactly one of a shared name.
    const za = settledInCountry('Franklin', { country: 'ZA' })!;
    expect(qualifyPlace(za).display).toBe('Franklin, KwaZulu-Natal, ZA');
    expect(ambiguousPlaces('Franklin', { country: 'ZA' })).toBeUndefined();
    // Where the country holds two, the name stays in question, theirs first.
    expect(settledInCountry('Franklin', { country: 'AU' })).toBeUndefined();
    expect(ambiguousPlaces('Franklin', { country: 'AU' })!.length).toBe(5);
    // And with no hint, nothing is settled.
    expect(settledInCountry('Hobart')).toBeUndefined();
    expect(resolvePlaceFor('Paris', { country: 'AU' })!.country).toBe('FR');
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
    // A whole state is wider than the town in it.
    expect(normaliseGeo({ place: 'AU-WA' }).radius_km).toBeGreaterThan(
      normaliseGeo({ place: 'Fremantle' }).radius_km,
    );
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

  it('refuses a state or territory, and says to name a town inside it', () => {
    for (const [place, region] of [
      ['ACT', 'Australian Capital Territory'],
      ['NSW', 'New South Wales'],
      ['WA', 'Western Australia'],
      ['Texas', 'Texas'],
      ['New South Wales', 'New South Wales'],
    ] as [string, string][]) {
      const e = err(() => normaliseGeo({ place, radius_km: 25 }));
      expect(e.payload.code, place).toBe('LOCATION_UNRESOLVED');
      expect(e.payload.human_action, place).toMatch(/state or territory/i);
      expect(e.payload.human_action, place).toContain(region);
      expect(e.payload.human_action!.length, place).toBeLessThanOrEqual(300);
    }
    // A bucket carrying the same shorthand is refused the same way.
    expect(err(() => normaliseGeo({ bucket: 'ACT' })).payload.human_action).toMatch(
      /state or territory/i,
    );
  });

  it('refuses a bare country, and says to name a town inside it', () => {
    // The second incident: a card posted as "AU" sat on the centroid of the
    // continent, 476 km from the city it belonged to.
    for (const [place, country] of [
      ['AU', 'Australia'],
      ['AUS', 'Australia'],
      ['Australia', 'Australia'],
      ['US', 'United States'],
    ] as [string, string][]) {
      const e = err(() => normaliseGeo({ place, radius_km: 25 }));
      expect(e.payload.code, place).toBe('LOCATION_UNRESOLVED');
      expect(e.payload.human_action, place).toMatch(/whole country/i);
      expect(e.payload.human_action, place).toContain(country);
      expect(e.payload.human_action!.length, place).toBeLessThanOrEqual(300);
    }
    // A bucket carrying the same shorthand is refused the same way.
    expect(err(() => normaliseGeo({ bucket: 'AU' })).payload.human_action).toMatch(
      /whole country/i,
    );
    // The deliberate forms are untouched.
    expect(normaliseGeo({ place: 'AU-ACT', radius_km: 25 }).lat).not.toBeNull();
  });

  it('refuses a name several cities answer to, and hands back the candidates', () => {
    const e = err(() => normaliseGeo({ place: 'Perth', radius_km: 25 }));
    expect(e.payload.code).toBe('LOCATION_AMBIGUOUS');
    expect(e.payload.human_action).toMatch(/names more than one place/i);
    expect(e.payload.human_action!.length).toBeLessThanOrEqual(300);
    const displays = e.payload.candidates!.map((c) => c.display);
    expect(displays).toContain('Perth, Western Australia, AU');
    expect(displays).toContain('Perth, Scotland, GB');
    expect(e.payload.candidates!.length).toBeLessThanOrEqual(5);
    // The candidate's own string is what an agent reposts with, and it works.
    for (const c of e.payload.candidates!) {
      expect(normaliseGeo({ place: c.place, radius_km: 25 }).lat, c.place).not.toBeNull();
    }
    const scotland = normaliseGeo({ place: 'Perth, Scotland', radius_km: 25 });
    expect(scotland.resolved!.country).toBe('GB');
    expect(
      haversineKm({ lat: scotland.lat!, lon: scotland.lon! }, { lat: 56.3959, lon: -3.4308 }),
    ).toBeLessThan(10);
    // A name with one clear owner still goes through silently.
    expect(normaliseGeo({ place: 'Paris', radius_km: 25 }).resolved!.country).toBe('FR');
  });

  it('the two gazetteer defects, from the posting side', () => {
    // "Franklin" is asked about rather than answered, and every candidate
    // offered is a place actually called Franklin.
    const e = err(() => normaliseGeo({ place: 'Franklin', radius_km: 25 }));
    expect(e.payload.code).toBe('LOCATION_AMBIGUOUS');
    for (const c of e.payload.candidates!) {
      expect(c.place.split(',')[0]).toBe('Franklin');
      expect(normaliseGeo({ place: c.place, radius_km: 25 }).lat, c.place).not.toBeNull();
    }
    // A posting written the way people speak lands where it should, and in
    // the same cell as the comma'd form matching has always used.
    const spaced = normaliseGeo({ place: 'Franklin ACT', radius_km: 25 });
    const commad = normaliseGeo({ place: 'Franklin, ACT', radius_km: 25 });
    expect(spaced.geo.bucket).toBe(commad.geo.bucket);
    expect(spaced.resolved!.display).toContain('Australian Capital Territory');
    const newtown = normaliseGeo({ place: 'Newtown NSW', radius_km: 25 });
    expect(newtown.geo.bucket).toBe(normaliseGeo({ place: 'Newtown, NSW', radius_km: 25 }).geo.bucket);
    expect(newtown.resolved!.display).toContain('New South Wales');
    // Two people describing one suburb two ways still meet.
    expect(
      haversineKm({ lat: spaced.lat!, lon: spaced.lon! }, { lat: commad.lat!, lon: commad.lon! }),
    ).toBeLessThan(1);
  });

  it('says out loud where it put the card, and how far it reaches', () => {
    expect(normaliseGeo({ place: 'Canberra', radius_km: 150 }).resolved!.display).toBe(
      'Canberra, Australian Capital Territory, Australia — matching within 150 km',
    );
    expect(normaliseGeo({ bucket: 'canberra' }).resolved!.display).toContain(
      'Australian Capital Territory',
    );
    // A bare cell was never a named place, so there is nothing to read back.
    expect(normaliseGeo({ bucket: 'qd66' }).resolved).toBeUndefined();
  });

  it('reads a stored card location back for the main page', () => {
    expect(describeStoredGeo({ place: 'Canberra', bucket: 'r3dp', radius_km: 25 })).toBe(
      'Canberra, Australian Capital Territory, Australia',
    );
    // A place the gazetteer no longer answers to keeps its own string.
    expect(describeStoredGeo({ place: 'Nowhereville', bucket: 'r3dp' })).toBe('Nowhereville');
    expect(describeStoredGeo({ bucket: 'g_a3f1' })).toBe('g_a3f1');
  });

  it('the towns inside those regions still place exactly where they are', () => {
    for (const [place, lat, lon] of [
      ['Canberra', -35.2835, 149.1281],
      ['Fremantle', -32.0563, 115.7456],
      ['Waco', 31.5493, -97.1467],
      ['Yass', -34.8404, 148.9099],
    ] as [string, number, number][]) {
      const n = normaliseGeo({ place, radius_km: 25 });
      expect(haversineKm({ lat: n.lat!, lon: n.lon! }, { lat, lon }), place).toBeLessThan(5);
    }
    // The incident, in one line: "ACT" must never land in the Waco cell.
    expect(normaliseGeo({ place: 'Waco' }).geo.bucket).toBe('9vdg');
    expect(() => normaliseGeo({ place: 'ACT' })).toThrow();
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
    const n = normaliseGeo({ place: 'Canberra', reach: 'country', radius_km: 25 });
    expect(n.country).toBe('AU');
    expect(n.reach).toBe('country');
    // The reach is stored on the card; the place is still a real town.
    expect(n.geo).toEqual({
      place: 'Canberra',
      bucket: 'r3dp',
      radius_km: 25,
      reach: 'country',
    });
  });

  it('leaves the stored geo alone when the reach is the default', () => {
    // Every card written before reach existed meant this, so it has to look
    // exactly like one.
    expect(normaliseGeo({ place: 'Canberra', reach: 'radius', radius_km: 25 }).geo).toEqual({
      place: 'Canberra',
      bucket: 'r3dp',
      radius_km: 25,
    });
    expect(normaliseGeo({ place: 'Canberra', radius_km: 25 }).reach).toBe('radius');
  });

  it('a nationwide pair meets across a country, and stops at its border', () => {
    // Canberra to Perth is about 3,100 km: no radius reaches it.
    const canberra = card('Canberra', 'country');
    const perth = card('Perth, Western Australia', 'country');
    const auckland = card('Auckland', 'country');
    expect(evaluateGeo(canberra, perth).compatible).toBe(true);
    expect(evaluateGeo(canberra, auckland).compatible).toBe(false);
    // And the radius pair those same two places make is still refused.
    expect(evaluateGeo(card('Canberra'), card('Perth, Western Australia')).compatible).toBe(false);
  });

  it('both sides have to reach: nationwide alone is not enough', () => {
    // The person collecting has to be as willing to cross the distance as
    // the person sending, or nobody is going anywhere.
    const nationwide = card('Canberra', 'country');
    const local = card('Perth, Western Australia');
    expect(evaluateGeo(nationwide, local).compatible).toBe(false);
    expect(evaluateGeo(local, nationwide).compatible).toBe(false);
  });

  it('anywhere meets anywhere, across countries', () => {
    const canberra = card('Canberra', 'anywhere');
    const auckland = card('Auckland', 'anywhere');
    const glasgow = card('Glasgow', 'anywhere');
    expect(evaluateGeo(canberra, auckland).compatible).toBe(true);
    expect(evaluateGeo(canberra, glasgow).compatible).toBe(true);
    // Anywhere covers a nationwide card only when it is in that country too.
    expect(evaluateGeo(canberra, card('Perth, Western Australia', 'country')).compatible).toBe(true);
    expect(evaluateGeo(canberra, card('Auckland', 'country')).compatible).toBe(false);
  });

  it('scores a reach match flat and moderate, not as though it were adjacent', () => {
    const far = evaluateGeo(card('Canberra', 'country'), card('Perth, Western Australia', 'country'));
    expect(far.closeness).toBe(REACH_GEO_CLOSENESS);
    expect(far.closeness).toBeLessThan(
      evaluateGeo(card('Canberra'), card('Canberra')).closeness,
    );
    // A pair that is ALSO close keeps its distance score: saying you would
    // post it should never cost you the neighbour who would walk over.
    const near = evaluateGeo(card('Canberra', 'country'), card('Canberra', 'country'));
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
    expect(evaluateGeo(unplaced, card('Canberra', 'country')).compatible).toBe(false);
  });

  it('reads the reach back in plain words, all three ways', () => {
    expect(normaliseGeo({ place: 'Canberra', reach: 'country' }).resolved!.display).toBe(
      'Canberra, Australian Capital Territory, Australia — reaching all of Australia',
    );
    expect(normaliseGeo({ place: 'Canberra', reach: 'anywhere' }).resolved!.display).toBe(
      'Canberra, Australian Capital Territory, Australia — reaching anywhere',
    );
    expect(normaliseGeo({ place: 'Canberra', radius_km: 25 }).resolved!.display).toBe(
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

  it('tells an agent that names a country where reach lives', () => {
    const e = err(() => normaliseGeo({ place: 'Australia' }));
    expect(e.payload.code).toBe('LOCATION_UNRESOLVED');
    expect(e.payload.human_action).toMatch(/whole country/);
    expect(e.payload.human_action).toMatch(/reach to "country"/);
    // The refusal itself stands: a country is still not a place to put a card.
    expect(e.payload.human_action).toMatch(/name the town or city/);
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

  it('either places a name or refuses it with something an agent can act on', () => {
    // The whole corpus through the publish path's location gate. Two things
    // have to hold for every one of a quarter of a million names: nothing
    // escapes as a bare error (which would be a 500 on a card someone tried
    // to post), and an ambiguity refusal never offers one candidate, which
    // would be a choice with nothing to choose.
    const keys = everyKey();
    expect(keys.length).toBeGreaterThan(100_000);
    const broke: string[] = [];
    let placed = 0;
    let refused = 0;
    for (const key of keys) {
      const candidates = ambiguousPlaces(key);
      if (candidates && candidates.length < 2) broke.push(`one candidate: ${key}`);
      try {
        normaliseGeo({ place: key, radius_km: 25 });
        placed++;
      } catch (e: any) {
        if (e?.payload?.code) refused++;
        else broke.push(`${key}: ${e?.message}`);
      }
    }
    expect(broke.slice(0, 10)).toEqual([]);
    expect(placed).toBeGreaterThan(0);
    expect(refused).toBeGreaterThan(0);
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
    // A hint is worth having only where it is right. An unknown zone costs
    // the ordering that was there before it, which is what everyone had.
    for (const tz of ['Europe/Paris', 'Asia/Tokyo', 'UTC', '', '   ', 'nonsense', null, undefined]) {
      expect(countryOfTimeZone(tz), String(tz)).toBeUndefined();
    }
  });

  it('prefers the area on file over the clock, and drops an area in question', () => {
    // A zone travels with a laptop; an area is something the person said.
    expect(homeCountry({ area: 'Canberra', timezone: 'America/New_York' })).toBe('AU');
    expect(homeCountry({ timezone: 'Australia/Sydney' })).toBe('AU');
    // "Franklin" is the very question a hint is meant to help with, so it is
    // no answer to it: the clock behind it is used instead.
    expect(homeCountry({ area: 'Franklin', timezone: 'Australia/Sydney' })).toBe('AU');
    expect(homeCountry({ area: 'Franklin' })).toBeUndefined();
    expect(homeCountry({})).toBeUndefined();
    expect(countryOfArea('Franklin, ACT')).toBe('AU');
  });

  it('carries the hint through the publish path without changing what places', () => {
    const hint = { country: 'AU' };
    // What resolves, resolves the same way with a hint as without one.
    for (const place of ['Canberra', 'Franklin, ACT', 'Perth, Scotland', 'AU-ACT']) {
      expect(normaliseGeo({ place, radius_km: 25 }, hint).geo.bucket, place).toBe(
        normaliseGeo({ place, radius_km: 25 }).geo.bucket,
      );
    }
    // What is refused is still refused — and now the first place the agent
    // reads out to its human is the one down the road.
    const e = err(() => normaliseGeo({ place: 'Franklin', radius_km: 25 }, hint));
    expect(e.payload.code).toBe('LOCATION_AMBIGUOUS');
    expect(e.payload.candidates[0].place).toBe('Franklin, Australian Capital Territory');
    expect(e.payload.human_action).toContain('Franklin, Australian Capital Territory, AU');
  });

  it('places a shared name in the human\'s own country where it holds only one', () => {
    // The probe: "Hobart" from an Australian account came back asking which,
    // with four American Hobarts on the list.
    const hobart = normaliseGeo({ place: 'Hobart', radius_km: 25 }, { country: 'AU' });
    expect(hobart.country).toBe('AU');
    expect(hobart.resolved!.display).toContain('Tasmania');
    // And it lands where "Hobart, Tasmania" always has.
    expect(hobart.geo.bucket).toBe(normaliseGeo({ place: 'Hobart, Tasmania', radius_km: 25 }).geo.bucket);
    // With no hint it is still asked.
    expect(err(() => normaliseGeo({ place: 'Hobart', radius_km: 25 })).payload.code).toBe(
      'LOCATION_AMBIGUOUS',
    );
  });

  it('reads a shared area name on the clock\'s country', () => {
    expect(homeCountry({ area: 'Hobart', timezone: 'Australia/Hobart' })).toBe('AU');
    expect(countryOfArea('Hobart', 'AU')).toBe('AU');
    expect(countryOfArea('Hobart')).toBeUndefined();
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
    expect(MANUAL_BODY).toMatch(/post again with the fuller form it gives you/i);
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
    expect(geo.description).toMatch(/suburb, city or region/);
    expect(geo.properties.reach.enum).toEqual(['radius', 'country', 'anywhere']);
    expect(publish.description).toMatch(/nearest suburb, city or region/);
    // The distinction the field exists for, at the point the model acts on it.
    expect(publish.description).toMatch(/`place` is the nearest suburb, city or region/);
    // anyOf cannot be expressed by constrained-decoding grammar compilers; the
    // server validates every listing against the full schema regardless.
    const blob = JSON.stringify(publish.inputSchema);
    for (const k of ['$ref', '$defs', 'anyOf', 'oneOf', 'allOf', 'propertyNames', 'format']) {
      expect(blob, k).not.toContain(`"${k}"`);
    }
  });
});
