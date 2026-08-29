import { describe, expect, it } from 'vitest';
import {
  categoryDenied,
  categoryKnownAndOpen,
  globMatches,
  screeningReasonCodes,
} from '../../src/denylist.js';

describe('deny-list glob matching', () => {
  it('matches ** suffixes and bare nodes', () => {
    expect(globMatches('goods.weapons.**', 'goods.weapons.knives')).toBe(true);
    expect(globMatches('goods.weapons', 'goods.weapons')).toBe(true);
    expect(globMatches('goods.weapons.**', 'goods.weapons')).toBe(false);
    expect(globMatches('goods.**', 'goods.bicycle.mountain')).toBe(true);
    expect(globMatches('goods.weapons.**', 'goods.bicycle')).toBe(false);
  });
});

describe('category deny decisions', () => {
  it('denies weapons, medication, animals outright', () => {
    expect(categoryDenied('goods.weapons')?.reason_code).toBe('weapons');
    expect(categoryDenied('goods.medication.prescription')?.reason_code).toBe(
      'prescription-medication',
    );
    expect(categoryDenied('goods.animals')?.reason_code).toBe('live-animals');
  });
  it('treats vertical-policy-pending as prohibited', () => {
    expect(categoryDenied('goods.alcohol')?.status).toBe('vertical-policy-pending');
  });
  it('does NOT category-deny ordinary goods via screening-only entries', () => {
    expect(categoryDenied('goods.bicycle.mountain')).toBeUndefined();
  });
  it('screening-only reason codes apply to all goods', () => {
    const codes = screeningReasonCodes('goods.bicycle.mountain');
    expect(codes).toContain('stolen-goods-markers');
    expect(codes).toContain('recalled-goods');
  });
});

describe('taxonomy openness', () => {
  it('accepts known open categories and rejects reserved/unknown', () => {
    expect(categoryKnownAndOpen('goods.bicycle.mountain').ok).toBe(true);
    expect(categoryKnownAndOpen('services.plumbing').ok).toBe(false);
    expect(categoryKnownAndOpen('goods.not-a-real-node').ok).toBe(false);
  });
});
