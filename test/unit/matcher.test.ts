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
  THIN_ATTR_MAX,
  THIN_WEIGHTS,
  WEIGHTS,
  DEFAULT_GEO_RADIUS_KM,
  attrCount,
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
  weightsFor,
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
  it('compatible: equal / ancestor / descendant', () => {
    expect(categoryCompatible('goods.bicycle.mountain', 'goods.bicycle.mountain')).toBe(true);
    expect(categoryCompatible('goods.bicycle', 'goods.bicycle.mountain')).toBe(true);
    expect(categoryCompatible('goods.bicycle.mountain', 'goods.bicycle')).toBe(true);
    expect(categoryCompatible('goods.bicycle.mountain', 'goods.furniture.sofa')).toBe(false);
    expect(categoryCompatible('goods.bicycle', 'goods.bicycles')).toBe(false); // no fuzzy prefixes
  });

  it('compatible: siblings under a parent that is itself below the top level', () => {
    // The whole point of the change: one bike, two disciplines, one parent.
    expect(categoryCompatible('goods.bicycle.mountain', 'goods.bicycle.road')).toBe(true);
    expect(categoryCompatible('goods.bicycle.road', 'goods.bicycle.mountain')).toBe(true);
    // Deeper down the tree the same rule applies, on the immediate parent.
    expect(
      categoryCompatible('goods.bicycle.mountain.hardtail', 'goods.bicycle.mountain.full-suspension'),
    ).toBe(true);
  });

  it('incompatible: top-level siblings, and anything wider than one parent', () => {
    // Shared parent 'goods' is top-level: admitting it would open a whole
    // vertical to itself.
    expect(categoryCompatible('goods.bicycle', 'goods.electronics')).toBe(false);
    expect(categoryCompatible('services.tutoring', 'services.gardening')).toBe(false);
    // Aunt/nephew: no shared IMMEDIATE parent, and not the ancestor line.
    expect(categoryCompatible('goods.bicycle.mountain', 'goods.skateboard')).toBe(false);
    expect(categoryCompatible('goods.skateboard', 'goods.bicycle.mountain')).toBe(false);
    // Cousins two subtrees apart, at equal depth: still no.
    expect(categoryCompatible('goods.bicycle.mountain', 'goods.skateboard.longboard')).toBe(false);
    expect(
      categoryCompatible('services.tutoring.languages', 'social.language-exchange.conversation'),
    ).toBe(false);
    // A top-level node beside a deeper node in another vertical.
    expect(categoryCompatible('goods', 'services.tutoring')).toBe(false);
    expect(categoryCompatible('goods', 'services')).toBe(false);
  });

  it('the rule is exactly: ancestor line OR same immediate parent below the top', () => {
    const paths = [
      'goods',
      'services',
      'goods.bicycle',
      'goods.skateboard',
      'services.tutoring',
      'goods.bicycle.mountain',
      'goods.bicycle.road',
      'goods.skateboard.longboard',
      'goods.bicycle.mountain.hardtail',
      'goods.bicycle.mountain.full-suspension',
    ];
    const parent = (p: string) => (p.includes('.') ? p.slice(0, p.lastIndexOf('.')) : '');
    for (const a of paths) {
      for (const b of paths) {
        const ancestorLine = a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`);
        const siblings = parent(a) !== '' && parent(a) === parent(b) && parent(a).includes('.');
        expect(categoryCompatible(a, b), `${a} x ${b}`).toBe(ancestorLine || siblings);
      }
    }
  });

  it('closeness decays 0.15 per tree step below the common ancestor', () => {
    expect(categoryCloseness('a.b.c', 'a.b.c')).toBe(1);
    expect(categoryCloseness('a.b', 'a.b.c')).toBeCloseTo(0.85);
    expect(categoryCloseness('a', 'a.b.c')).toBeCloseTo(0.7);
    // Siblings: one step each side of the shared parent.
    expect(categoryCloseness('goods.bicycle.mountain', 'goods.bicycle.road')).toBeCloseTo(0.7);
    expect(
      categoryCloseness('goods.bicycle.mountain.hardtail', 'goods.bicycle.mountain.full-suspension'),
    ).toBeCloseTo(0.7);
    // Incompatible pairs score nothing at all, whatever the tree distance.
    expect(categoryCloseness('goods.bicycle.mountain', 'goods.skateboard')).toBe(0);
    expect(categoryCloseness('goods.bicycle', 'goods.electronics')).toBe(0);
    // Floor holds on a long ancestor line.
    expect(categoryCloseness('a', 'a.b.c.d.e.f')).toBe(0.4);
  });

  it('a sibling pair reaches the blend, and semantics decide it', () => {
    const pair = (semantic: number) =>
      evaluatePair({
        semantic,
        categoryA: 'goods.bicycle.mountain',
        categoryB: 'goods.bicycle.road',
        geoA: { bucket: 'r3dp' },
        geoB: { bucket: 'r3dp' },
        wantBand: { band: { max: 750 }, ccy: 'AUD' },
        haveBand: { band: { min: 0 }, ccy: 'AUD' },
      });
    // Alike on everything else: an introduction.
    const strong = pair(0.9);
    expect(strong.hardRulesPass).toBe(true);
    expect(decide(strong.score, 0, 0)).toBe('match');
    // Two bikes that have nothing to do with each other: a near-miss, stored
    // and never sent, which is what the floor is for.
    const weak = pair(0.35);
    expect(weak.hardRulesPass).toBe(true);
    expect(weak.score).toBeGreaterThanOrEqual(NEAR_MISS_FLOOR);
    expect(weak.score).toBeLessThan(CREATE_THRESHOLD);
    expect(decide(weak.score, 0, 0)).toBe('near-miss');
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

// ---------------------------------------------------------------------------
// The duet pair, reconstructed from realism-reports/duet-2026-09-05T09-19-26
// -360Z.json. Two live agents, one bike, one town, both runs byte-identical.
// The report records the blended score and nothing else, so the semantic
// value is backed out of the OLD weights:
//   0.60715854 = 0.55 s + 0.20 (category 1.0, same node)
//                       + 0.15 (geo 1.0, one bucket, r=25 both sides)
//                       + 0.10 (price 0.6, neither side declared a band)
//   s = (0.60715854 - 0.41) / 0.55 = 0.35847007...
// ---------------------------------------------------------------------------
const DUET_RECORDED_SCORE = 0.60715854;
const DUET_SEMANTIC = (DUET_RECORDED_SCORE - 0.41) / 0.55;
const DUET_HAVE_ATTRS = {
  year: 2021,
  brand: 'Giant',
  model: 'Trance',
  condition: 'well kept, good condition',
  frame_size: 'medium',
};
const DUET_WANT_ATTRS = { frame_size: 'medium' };
const CANBERRA_25 = { bucket: 'r3dp', lat: -35.2835, lon: 149.1281, radius_km: 25 };

describe('assertion-scaled weights', () => {
  it('both weight sets sum to 1', () => {
    for (const w of [WEIGHTS, THIN_WEIGHTS]) {
      expect(w.semantic + w.category + w.geo + w.price).toBeCloseTo(1, 10);
    }
  });

  it('counts only the attributes the projection actually embeds', () => {
    expect(attrCount(undefined)).toBe(0);
    expect(attrCount({})).toBe(0);
    expect(attrCount({ a: 'x', b: 2, c: true })).toBe(3);
    // Nested and null values never reach the embedded text, so they assert
    // nothing the semantic score could be reading.
    expect(attrCount({ a: 'x', b: null, c: { d: 1 }, e: ['f'] })).toBe(1);
    expect(attrCount(DUET_HAVE_ATTRS)).toBe(5);
    expect(attrCount(DUET_WANT_ATTRS)).toBe(1);
  });

  it('the sparser side picks the blend, at 0, 1, 2 and 3 attributes', () => {
    // Rich only when BOTH sides clear the line.
    for (let a = 0; a <= 4; a++) {
      for (let b = 0; b <= 4; b++) {
        const expected = Math.min(a, b) >= 3 ? WEIGHTS : THIN_WEIGHTS;
        expect(weightsFor(a, b)).toBe(expected);
      }
    }
    expect(THIN_ATTR_MAX).toBe(2);
    // Spelled out at the boundary, both ways round.
    expect(weightsFor(0, 9)).toBe(THIN_WEIGHTS);
    expect(weightsFor(9, 1)).toBe(THIN_WEIGHTS);
    expect(weightsFor(2, 2)).toBe(THIN_WEIGHTS);
    expect(weightsFor(3, 2)).toBe(THIN_WEIGHTS);
    expect(weightsFor(3, 3)).toBe(WEIGHTS);
    expect(weightsFor(3, 40)).toBe(WEIGHTS);
  });

  it('the duet pair scored 0.6072 on the old weights and clears 0.75 on the new', () => {
    const inputs = {
      semantic: DUET_SEMANTIC,
      categoryA: 'goods.bicycle.mountain',
      categoryB: 'goods.bicycle.mountain',
      geoA: CANBERRA_25,
      geoB: { ...CANBERRA_25 },
      // No bands: both duet cards left price unstated, so fit is the
      // neutral 0.6.
    };
    // The backed-out semantic value reproduces the recorded score under the
    // old blend — the arithmetic in the header, pinned.
    const old =
      WEIGHTS.semantic * DUET_SEMANTIC + WEIGHTS.category * 1 + WEIGHTS.geo * 1 + WEIGHTS.price * 0.6;
    expect(DUET_SEMANTIC).toBeCloseTo(0.35847007, 8);
    expect(old).toBeCloseTo(DUET_RECORDED_SCORE, 8);
    expect(decide(old, 0, 0)).toBe('near-miss');

    const now = evaluatePair({
      ...inputs,
      attributesA: DUET_HAVE_ATTRS,
      attributesB: DUET_WANT_ATTRS,
    });
    expect(now.hardRulesPass).toBe(true);
    expect(now.weights).toBe(THIN_WEIGHTS);
    expect(now.thinness).toBe(1);
    expect(now.score).toBeCloseTo(
      0.3 * DUET_SEMANTIC + 0.35 * 1 + 0.25 * 1 + 0.1 * 0.6,
      8,
    );
    expect(now.score).toBeCloseTo(0.76754102, 6);
    expect(now.score).toBeGreaterThanOrEqual(CREATE_THRESHOLD);
    expect(decide(now.score, 0, 0)).toBe('match');
  });

  it('a card with no attributes at all is thin, not rich', () => {
    const r = evaluatePair({
      semantic: DUET_SEMANTIC,
      categoryA: 'goods.bicycle.mountain',
      categoryB: 'goods.bicycle.mountain',
      geoA: CANBERRA_25,
      geoB: { ...CANBERRA_25 },
      attributesA: DUET_HAVE_ATTRS,
      // attributesB absent: the card asserted nothing.
    });
    expect(r.thinness).toBe(0);
    expect(r.weights).toBe(THIN_WEIGHTS);
  });

  it('a personal threshold bump can still hold the duet pair back', () => {
    // 0.7675 clears 0.75, and a nudged account's 0.77 it does not: the bump
    // keeps working on top of the new blend.
    const score = 0.3 * DUET_SEMANTIC + 0.35 + 0.25 + 0.06;
    expect(decide(score, 0, 0)).toBe('match');
    expect(decide(score, 0.02, 0)).toBe('near-miss');
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
      // Three attributes each, so this pair is scored on the rich blend and
      // the assertion below is about geo alone.
      attributesA: { brand: 'Dell', model: 'XPS 13', condition: 'good' },
      attributesB: { brand: 'Dell', model: 'XPS 13', condition: 'good' },
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
  it('a thin pair one node across stays a near-miss', () => {
    // Case (b) from the SCORE MODEL header. Same two cards as the duet pair,
    // but the WANT is filed under the sibling node: 0.7 category closeness.
    const r = evaluatePair({
      semantic: DUET_SEMANTIC,
      categoryA: 'goods.bicycle.mountain',
      categoryB: 'goods.bicycle.road',
      geoA: CANBERRA_25,
      geoB: { ...CANBERRA_25 },
      attributesA: DUET_HAVE_ATTRS,
      attributesB: DUET_WANT_ATTRS,
    });
    expect(r.weights).toBe(THIN_WEIGHTS);
    expect(r.score).toBeCloseTo(
      0.3 * DUET_SEMANTIC + 0.35 * 0.7 + 0.25 * 1 + 0.1 * 0.6,
      8,
    );
    expect(r.score).toBeCloseTo(0.66254102, 6);
    expect(decide(r.score, 0, 0)).toBe('near-miss');
  });

  it('a rich pair that does not agree is scored exactly as it was before', () => {
    // Case (c): both sides said plenty and still did not line up, so the
    // embedding keeps its 0.55 and the number is the pre-change one.
    const rich = { a: 'x', b: 'y', c: 'z', d: 'w' };
    const r = evaluatePair({
      semantic: 0.4,
      categoryA: 'goods.bicycle.mountain',
      categoryB: 'goods.bicycle.mountain',
      geoA: CANBERRA_25,
      geoB: { ...CANBERRA_25 },
      attributesA: rich,
      attributesB: { ...rich },
    });
    expect(r.weights).toBe(WEIGHTS);
    expect(r.thinness).toBe(4);
    expect(r.score).toBeCloseTo(0.55 * 0.4 + 0.2 * 1 + 0.15 * 1 + 0.1 * 0.6, 8);
    expect(r.score).toBeCloseTo(0.63, 8);
    expect(decide(r.score, 0, 0)).toBe('near-miss');
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
    // An ancestor, a descendant and a sibling of the source's own node stay
    // in: the filter is categoryCompatible itself, never a same-leaf shortcut.
    expect(prefilterKeeps(placedSource, placedCandidate({ category: 'goods.bicycle' }))).toBe(true);
    expect(
      prefilterKeeps(placedSource, placedCandidate({ category: 'goods.bicycle.mountain.hardtail' })),
    ).toBe(true);
    expect(prefilterKeeps(placedSource, placedCandidate({ category: 'goods.bicycle.road' }))).toBe(
      true,
    );
    // And the sibling rule stops where categoryCompatible stops.
    expect(prefilterKeeps(placedSource, placedCandidate({ category: 'goods.skateboard' }))).toBe(
      false,
    );
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
    // The category clause is the hard rule: equal, ancestor, descendant, and
    // siblings under a shared parent that is itself below the top level.
    expect(q.where).toContain(`c.category = $3::text`);
    expect(q.where).toContain(`left(c.category, length($3::text) + 1) = $3::text || '.'`);
    expect(q.where).toContain(`left($3::text, length(c.category) + 1) = c.category || '.'`);
    expect(q.where).toContain(`regexp_replace(c.category, '\\.[^.]+$', '')`);
    expect(q.where).toContain(`regexp_replace($3::text, '\\.[^.]+$', '')`);
    // Dotless categories never reach the sibling branch, either side.
    expect(q.where).toContain(`strpos(c.category, '.') > 0`);
    expect(q.where).toContain(`strpos($3::text, '.') > 0`);
    expect(q.where).toContain(`strpos(regexp_replace($3::text, '\\.[^.]+$', ''), '.') > 0`);
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
