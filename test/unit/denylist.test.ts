import { describe, expect, it } from 'vitest';
import {
  categoryDenied,
  categoryKnownAndOpen,
  categoryStatus,
  globMatches,
  openCategories,
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
  it('accepts known open categories', () => {
    expect(categoryKnownAndOpen('goods.bicycle.mountain').ok).toBe(true);
    expect(categoryKnownAndOpen('goods.electronics.laptop').ok).toBe(true);
    expect(categoryKnownAndOpen('services.repairs.bicycle').ok).toBe(true);
    expect(categoryKnownAndOpen('services.tutoring.maths').ok).toBe(true);
    expect(categoryKnownAndOpen('social.language-exchange').ok).toBe(true);
    expect(categoryKnownAndOpen('social.activity-partner.hiking').ok).toBe(true);
    expect(categoryKnownAndOpen('social.community.volunteering').ok).toBe(true);
  });

  it('rejects a category the taxonomy has never heard of', () => {
    const r = categoryStatus('goods.not-a-real-node');
    expect(r.status).toBe('unknown');
    expect(r.reason).toContain('is not in the taxonomy');
    expect(categoryStatus('goods.laptop.macbook-air').status).toBe('unknown');
    expect(categoryStatus('social.conversation.language-exchange').status).toBe('unknown');
    expect(categoryStatus('nonsense.thing').reason).toContain("top level 'nonsense'");
  });

  it('rejects the reserved top levels', () => {
    expect(categoryStatus('work.freelance').status).toBe('reserved');
    expect(categoryStatus('property.rental').reason).toContain("top level 'property' is reserved");
  });

  it('rejects a reserved node and everything beneath it, with the reason', () => {
    expect(categoryStatus('social.dating').reason).toContain('regulated-vertical');
    expect(categoryStatus('social.dating.casual').status).toBe('reserved');
    expect(categoryStatus('services.trades.electrical').reason).toContain('licensed-trade');
    expect(categoryStatus('services.trades.plumbing').status).toBe('reserved');
    expect(categoryStatus('services.health.medical').reason).toContain('licensed-trade');
    expect(categoryStatus('services.legal.advice').status).toBe('reserved');
    expect(categoryStatus('services.financial.advice').status).toBe('reserved');
    expect(categoryStatus('services.childcare.babysitting').status).toBe('reserved');
  });

  it('is one rule, applied the same way whatever the environment', () => {
    // The gate reads the taxonomy and nothing else. No env var reaches it, so
    // there is nothing for a deployment to differ on.
    process.env.CATEGORY_POLICY = 'open-experiment';
    expect(categoryKnownAndOpen('social.dating.casual').ok).toBe(false);
    expect(categoryKnownAndOpen('anything.at.all').ok).toBe(false);
    delete process.env.CATEGORY_POLICY;
  });

  it('opens a few hundred categories, and every one of them resolves', () => {
    const open = openCategories();
    expect(open.length).toBeGreaterThanOrEqual(300);
    for (const c of open) expect(categoryStatus(c).status).toBe('open');
    expect(open).toContain('goods.electronics.laptop');
    expect(open).toContain('social.language-exchange');
    expect(open).not.toContain('social.dating');
    expect(open).not.toContain('work.freelance');
  });
});
