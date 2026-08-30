import { describe, expect, it } from 'vitest';
import {
  CREATE_THRESHOLD,
  NEAR_MISS_FLOOR,
  WEIGHTS,
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
