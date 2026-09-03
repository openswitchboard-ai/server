import { describe, expect, it, vi } from 'vitest';

// The prefilter lives beside the engine, and the engine imports the pool.
vi.mock('../../src/db.js', () => ({ getPool: () => ({ query: vi.fn() }) }));

import {
  CANDIDATE_ORDER,
  GEO_PREFILTER_SLACK_KM,
  candidateQueryShape,
  prefilterKeeps,
} from '../../src/domain/matcher.js';
import {
  CREATE_THRESHOLD,
  NEAR_MISS_FLOOR,
  REACH_GEO_CLOSENESS,
  WEIGHTS,
  DEFAULT_GEO_RADIUS_KM,
  categoryCloseness,
  categoryCompatible,
  collectWindowMinutes,
  decide,
  decodeGeohash,
  evaluateGeo,
  evaluatePair,
  evaluatePrice,
  isGeohash,
  isLadderPattern,
  projectionText,
} from '../../src/domain/matchRules.js';

describe('canonical projection text', () => {
  it('is deterministic, type-free, category-labelled, attribute-sorted', () => {
    const t = projectionText({
      category: 'goods.bicycle.mountain',
      attributes: { model: 'Trek Marlin 5', condition: 'good', year: 2019 },
    });
    expect(t).toBe(
      'category: goods.bicycle.mountain (Secondhand consumer goods > Bicycles > Mountain bikes); condition: good; model: trek marlin 5; year: 2019',
    );
    // No WANT/HAVE marker: both types of the same thing embed identically.
    expect(t).not.toMatch(/WANT|HAVE/);
  });

  it('truncates long string values (never a raw free-text dump)', () => {
    const long = 'x'.repeat(200);
    const t = projectionText({ category: 'goods.tools', attributes: { model: long } });
    expect(t).toContain('model: ' + 'x'.repeat(60));
    expect(t).not.toContain('x'.repeat(61));
  });
});

describe('category tree', () => {
  it('compatible: equal / ancestor / descendant only', () => {
    expect(categoryCompatible('goods.bicycle.mountain', 'goods.bicycle.mountain')).toBe(true);
    expect(categoryCompatible('goods.bicycle', 'goods.bicycle.mountain')).toBe(true);
    expect(categoryCompatible('goods.bicycle.mountain', 'goods.bicycle')).toBe(true);
    expect(categoryCompatible('goods.bicycle.mountain', 'goods.furniture.sofa')).toBe(false);
    expect(categoryCompatible('goods.bicycle', 'goods.bicycles')).toBe(false); // no fuzzy prefixes
  });
  it('closeness decays 0.15 per step', () => {
    expect(categoryCloseness('a.b.c', 'a.b.c')).toBe(1);
    expect(categoryCloseness('a.b', 'a.b.c')).toBeCloseTo(0.85);
    expect(categoryCloseness('a', 'a.b.c')).toBeCloseTo(0.7);
  });
});

describe('geo buckets', () => {
  it('recognises geohashes', () => {
    expect(isGeohash('qd66')).toBe(true);
    expect(isGeohash('KF00A')).toBe(false); // 'a' is not a geohash32 character
  });
  it('decodes qd66 near Perth', () => {
    const c = decodeGeohash('qd66');
    expect(c.lat).toBeGreaterThan(-33);
    expect(c.lat).toBeLessThan(-31);
    expect(c.lon).toBeGreaterThan(115);
    expect(c.lon).toBeLessThan(117);
  });
  it('same bucket always compatible', () => {
    expect(evaluateGeo({ bucket: 'qd66' }, { bucket: 'qd66' }).compatible).toBe(true);
  });
  it('nearby geohash cells overlap; far ones do not', () => {
    // qd66 (Perth) vs r3gx (Sydney-ish): thousands of km apart.
    const far = evaluateGeo({ bucket: 'qd66', radius_km: 25 }, { bucket: 'r3gx', radius_km: 25 });
    expect(far.compatible).toBe(false);
    // Adjacent cells with modest radii overlap.
    const near = evaluateGeo({ bucket: 'qd66', radius_km: 50 }, { bucket: 'qd67', radius_km: 50 });
    expect(near.compatible).toBe(true);
  });
  it('opaque region codes: prefix relation only', () => {
    expect(evaluateGeo({ bucket: 'AU-WA' }, { bucket: 'AU-WA-PER' }).compatible).toBe(true);
    expect(evaluateGeo({ bucket: 'AU-WA' }, { bucket: 'AU-NSW' }).compatible).toBe(false);
  });
});

describe('price bands (decrypted engine-side only)', () => {
  it('WANT ceiling >= HAVE floor', () => {
    expect(
      evaluatePrice(
        { band: { max: 750 }, ccy: 'AUD' },
        { band: { min: 400 }, ccy: 'AUD' },
      ).compatible,
    ).toBe(true);
    expect(
      evaluatePrice(
        { band: { max: 100 }, ccy: 'AUD' },
        { band: { min: 5000 }, ccy: 'AUD' },
      ).compatible,
    ).toBe(false);
  });
  it('a missing band imposes no constraint (neutral fit)', () => {
    expect(evaluatePrice(undefined, undefined)).toEqual({ compatible: true, fit: 0.6 });
    expect(evaluatePrice({ band: { max: 100 }, ccy: 'AUD' }, undefined).fit).toBe(0.6);
  });
  it('mixed currencies never intersect (no FX in 0.F)', () => {
    expect(
      evaluatePrice(
        { band: { max: 750 }, ccy: 'AUD' },
        { band: { min: 10 }, ccy: 'USD' },
      ).compatible,
    ).toBe(false);
  });
});

describe('score blend + decision', () => {
  it('weights sum to 1', () => {
    expect(WEIGHTS.semantic + WEIGHTS.category + WEIGHTS.geo + WEIGHTS.price).toBeCloseTo(1);
  });
  it('a designed twin pair scores above the create threshold', () => {
    const r = evaluatePair({
      semantic: 0.97,
      categoryA: 'goods.bicycle.mountain',
      categoryB: 'goods.bicycle.mountain',
      geoA: { bucket: 'qd66', radius_km: 25 },
      geoB: { bucket: 'qd66', radius_km: 25 },
      wantBand: { band: { max: 750 }, ccy: 'AUD' },
      haveBand: { band: { min: 400 }, ccy: 'AUD' },
    });
    expect(r.hardRulesPass).toBe(true);
    expect(r.score).toBeGreaterThanOrEqual(CREATE_THRESHOLD);
  });
  it('hard-rule failures never score', () => {
    const geo = evaluatePair({
      semantic: 1,
      categoryA: 'goods.bicycle.mountain',
      categoryB: 'goods.bicycle.mountain',
      geoA: { bucket: 'qd66', radius_km: 5 },
      geoB: { bucket: 'r3gx', radius_km: 5 },
    });
    expect(geo).toMatchObject({ hardRulesPass: false, failed: 'geo', score: 0 });
    const price = evaluatePair({
      semantic: 1,
      categoryA: 'goods.bicycle.mountain',
      categoryB: 'goods.bicycle.mountain',
      geoA: { bucket: 'qd66' },
      geoB: { bucket: 'qd66' },
      wantBand: { band: { max: 100 }, ccy: 'AUD' },
      haveBand: { band: { min: 5000 }, ccy: 'AUD' },
    });
    expect(price).toMatchObject({ hardRulesPass: false, failed: 'price', score: 0 });
    const cat = evaluatePair({
      semantic: 1,
      categoryA: 'goods.bicycle.mountain',
      categoryB: 'goods.furniture.sofa',
      geoA: { bucket: 'qd66' },
      geoB: { bucket: 'qd66' },
    });
    expect(cat).toMatchObject({ hardRulesPass: false, failed: 'category', score: 0 });
  });
  it('a nationwide pair passes the geo rule and scores below an adjacent one', () => {
    // Canberra and Perth: 3,100 km, and a real match when both sides said
    // they would post it. It should not score as though they were neighbours.
    const canberra = {
      bucket: 'r3dp',
      lat: -35.2835,
      lon: 149.1281,
      radius_km: 25,
      reach: 'country' as const,
      country: 'AU',
    };
    const perth = {
      bucket: 'qd66',
      lat: -31.9522,
      lon: 115.8614,
      radius_km: 25,
      reach: 'country' as const,
      country: 'AU',
    };
    const same = {
      semantic: 0.97,
      categoryA: 'goods.electronics.laptop',
      categoryB: 'goods.electronics.laptop',
      wantBand: { band: { max: 750 }, ccy: 'AUD' },
      haveBand: { band: { min: 400 }, ccy: 'AUD' },
    };
    const nationwide = evaluatePair({ ...same, geoA: canberra, geoB: perth });
    const adjacent = evaluatePair({ ...same, geoA: canberra, geoB: { ...canberra } });
    expect(nationwide.hardRulesPass).toBe(true);
    expect(nationwide.score).toBeLessThan(adjacent.score);
    expect(nationwide.score - adjacent.score).toBeCloseTo(
      WEIGHTS.geo * (REACH_GEO_CLOSENESS - 1),
      6,
    );
    // The same two places with the reach unstated are still too far apart.
    expect(
      evaluatePair({
        ...same,
        geoA: { ...canberra, reach: 'radius' as const },
        geoB: { ...perth, reach: 'radius' as const },
      }),
    ).toMatchObject({ hardRulesPass: false, failed: 'geo' });
  });
  it('decision bands: match / near-miss / discard, with personal bumps', () => {
    expect(decide(0.8, 0, 0)).toBe('match');
    expect(decide(0.7, 0, 0)).toBe('near-miss');
    expect(decide(0.5, 0, 0)).toBe('discard');
    expect(NEAR_MISS_FLOOR).toBe(0.55);
    // A not-for-me-nudged user's threshold rises: 0.76 no longer clears 0.75+0.02.
    expect(decide(0.76, 0.02, 0)).toBe('near-miss');
    expect(decide(0.78, 0.02, 0)).toBe('match');
  });
});

/**
 * The candidate prefilter. The engine used to take the 50 nearest cards on
 * the whole board and hope the other half of the pair was among them; on a
 * board holding hundreds of near-identical cards it never was. These are the
 * cases that pile-up produced, and the promise the filter has to keep: it
 * narrows the pool, and it never drops a pair the rules would have matched.
 */
describe('candidate prefilter', () => {
  const CANBERRA = { lat: -35.2835, lon: 149.1281 };
  const PERTH = { lat: -31.9522, lon: 115.8614 }; // ~3,100 km from Canberra

  const placedSource = {
    category: 'goods.bicycle.mountain',
    geo: { bucket: 'r3dp', radius_km: 25, ...CANBERRA, reach: 'radius' as const, country: 'AU' },
  };
  const placedCandidate = (over: Record<string, any> = {}) => ({
    category: 'goods.bicycle.mountain',
    geo: { bucket: 'r3dp', radius_km: 25 },
    geo_lat: CANBERRA.lat,
    geo_lon: CANBERRA.lon,
    geo_radius_km: 25,
    ...over,
  });

  it('finds the one same-category card among sixty off-category clones', () => {
    const clones = Array.from({ length: 60 }, () =>
      placedCandidate({ category: 'goods.furniture.sofa' }),
    );
    const real = placedCandidate();
    const kept = [...clones, real].filter((c) => prefilterKeeps(placedSource, c));
    expect(kept).toEqual([real]);
    // An ancestor and a descendant of the source's own node stay in: the
    // filter is categoryCompatible itself, not a same-leaf shortcut.
    expect(prefilterKeeps(placedSource, placedCandidate({ category: 'goods.bicycle' }))).toBe(true);
    expect(
      prefilterKeeps(placedSource, placedCandidate({ category: 'goods.bicycle.mountain.hardtail' })),
    ).toBe(true);
  });

  it('leaves behind sixty same-category clones parked in a bucket of their own', () => {
    // The dev pile, exactly: identical fixture cards in run-scoped buckets
    // the gazetteer cannot place, which is why they carry no centre point.
    const leftovers = Array.from({ length: 60 }, (_, i) => ({
      category: 'goods.bicycle.mountain',
      geo: { bucket: `g_${i.toString(16).padStart(4, '0')}`, radius_km: 25 },
      geo_lat: null,
      geo_lon: null,
      geo_radius_km: 25,
    }));
    expect(leftovers.filter((c) => prefilterKeeps(placedSource, c))).toEqual([]);
    // And an island card still meets the other card on ITS island.
    const island = { category: 'goods.bicycle.mountain', geo: { bucket: 'g_00ff' }, geo_lat: null };
    const islandSource = { category: 'goods.bicycle.mountain', geo: { bucket: 'g_00ff' } };
    expect(prefilterKeeps(islandSource, island)).toBe(true);
    expect(prefilterKeeps(islandSource, leftovers[0])).toBe(false);
  });

  it('drops candidates no radius could reach, and keeps the ones nearby', () => {
    expect(
      prefilterKeeps(
        placedSource,
        placedCandidate({ geo_lat: PERTH.lat, geo_lon: PERTH.lon, geo: { bucket: 'qd66' } }),
      ),
    ).toBe(false);
    // 30 km up the road, inside 25 + 25: kept.
    expect(
      prefilterKeeps(placedSource, placedCandidate({ geo_lat: CANBERRA.lat + 0.27 })),
    ).toBe(true);
  });

  it('keeps a card that reaches a country or anywhere, however far off it is', () => {
    const perth = { geo_lat: PERTH.lat, geo_lon: PERTH.lon };
    for (const reach of ['country', 'anywhere']) {
      expect(
        prefilterKeeps(
          placedSource,
          placedCandidate({ ...perth, geo: { bucket: 'qd66', radius_km: 25, reach } }),
        ),
      ).toBe(true);
    }
    // And a source that reaches wide keeps everything for the rules to judge.
    const wide = { ...placedSource, geo: { ...placedSource.geo, reach: 'anywhere' as const } };
    expect(prefilterKeeps(wide, placedCandidate({ ...perth }))).toBe(true);
  });

  it('never drops a pair the geo rule would have matched', () => {
    // The box is a superset of the circle the rule measures - including at
    // the latitudes where a degree of longitude stops being 111 km.
    let checked = 0;
    for (const base of [CANBERRA, PERTH, { lat: 60.17, lon: 24.94 }, { lat: 1.35, lon: 103.82 }]) {
      for (const dLat of [-4, -1, -0.2, 0, 0.2, 1, 4]) {
        for (const dLon of [-6, -2, -0.3, 0, 0.3, 2, 6]) {
          for (const radius of [1, 25, 250, 500]) {
            const src = {
              category: 'goods.bicycle.mountain',
              geo: { bucket: 'b', radius_km: radius, lat: base.lat, lon: base.lon },
            };
            const cand = {
              category: 'goods.bicycle.mountain',
              geo: { bucket: 'c', radius_km: radius },
              geo_lat: base.lat + dLat,
              geo_lon: base.lon + dLon,
              geo_radius_km: radius,
            };
            if (
              evaluateGeo(src.geo, {
                bucket: 'c',
                radius_km: radius,
                lat: cand.geo_lat,
                lon: cand.geo_lon,
              }).compatible
            ) {
              checked++;
              expect(prefilterKeeps(src, cand), `${base.lat} ${dLat}/${dLon} r${radius}`).toBe(true);
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(50);
  });

  it('hands Postgres the same rule, and the tie-break that keeps it stable', () => {
    const q = candidateQueryShape({ account_id: 'acct-1', type: 'WANT', ...placedSource });
    // The category clause is the hard rule: equal, ancestor, descendant.
    expect(q.where).toContain(`c.category = $3::text`);
    expect(q.where).toContain(`left(c.category, length($3::text) + 1) = $3::text || '.'`);
    expect(q.where).toContain(`left($3::text, length(c.category) + 1) = c.category || '.'`);
    // Opposite type, the source's own account excluded, and the category.
    expect(q.params.slice(0, 4)).toEqual(['HAVE', 'acct-1', 'goods.bicycle.mountain', false]);
    // Centre, radius and the box's degrees-per-km, then the slack.
    expect(q.params.slice(4, 8)).toEqual([
      CANBERRA.lat,
      CANBERRA.lon,
      25,
      expect.closeTo(1 / 111.32, 6),
    ]);
    expect(q.params[9]).toBe(GEO_PREFILTER_SLACK_KM);
    expect(q.params[10]).toBe(DEFAULT_GEO_RADIUS_KM);
    expect(q.params.slice(11)).toEqual(['r3dp', true]); // bucket, and it is a geohash
    // Nearest first, newest of the equals first.
    expect(q.order).toBe('c.embedding <=> $14::vector, c.created_at DESC');
    expect(CANDIDATE_ORDER).toContain('c.created_at DESC');
    expect(q.limit).toBe(50);
    expect(q.poolCap).toBeGreaterThan(q.limit);
  });

  it('an unplaced source asks for its own bucket, not for the whole board', () => {
    const q = candidateQueryShape({
      account_id: 'acct-1',
      type: 'HAVE',
      category: 'goods.bicycle.mountain',
      geo: { bucket: 'g_beef', radius_km: 25, lat: null, lon: null },
    });
    expect(q.params[0]).toBe('WANT');
    expect(q.params[4]).toBeNull(); // no centre point
    expect(q.params[5]).toBeNull();
    expect(q.params.slice(11)).toEqual(['g_beef', false]); // '_' is not geohash32
    expect(q.where).toContain(`COALESCE(c.geo->>'bucket', '') = $12::text`);
  });
});

describe('collection window + ladder', () => {
  it('defaults 6h goods / 15min today; overrides only shorten', () => {
    expect(collectWindowMinutes('none', null)).toBe(360);
    expect(collectWindowMinutes('today', null)).toBe(15);
    expect(collectWindowMinutes('none', 30)).toBe(30);
    expect(collectWindowMinutes('none', 100000)).toBe(360); // cannot lengthen
    expect(collectWindowMinutes('today', 60)).toBe(15); // cannot lengthen
  });
  it('ladder pattern: >=3 strictly increasing amounts', () => {
    expect(isLadderPattern([100, 110, 120])).toBe(true);
    expect(isLadderPattern([100, 120])).toBe(false);
    expect(isLadderPattern([100, 90, 120])).toBe(false);
    expect(isLadderPattern([100, 100, 120])).toBe(false);
    expect(isLadderPattern([50, 100, 110, 120])).toBe(true);
  });
});
