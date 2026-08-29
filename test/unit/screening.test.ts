import { describe, expect, it } from 'vitest';
import { collectFreeText, screenCard } from '../../src/domain/screening.js';

const cfg: any = { bedrockModelId: 'unused-in-these-tests' };

describe('screening free-text collection', () => {
  it('collects only author-controlled string attribute values', () => {
    const texts = collectFreeText({
      attributes: { condition: 'good', model: 'Trek Marlin 5', year: 2019, tubeless: true },
    } as any);
    expect(texts).toEqual(['condition: good', 'model: Trek Marlin 5']);
  });
});

describe('screening deterministic deny-list branch', () => {
  it('rejects a denied category without needing the model', async () => {
    const verdict = await screenCard(cfg, {
      category: 'goods.weapons.knives',
      attributes: {},
    } as any);
    expect(verdict.pass).toBe(false);
    expect(verdict.reason_code).toBe('weapons');
  });

  it('passes a clean card with no free text without needing the model', async () => {
    const verdict = await screenCard(cfg, {
      category: 'goods.bicycle.mountain',
      attributes: { year: 2019 },
    } as any);
    expect(verdict.pass).toBe(true);
  });
});
