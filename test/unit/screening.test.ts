import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyVerdict, collectFreeText, screenCard } from '../../src/domain/screening.js';
import * as db from '../../src/db.js';

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

/**
 * The rejection EVENT is the state change, and applyVerdict is where it
 * happens. It says whether its UPDATE actually landed, because that is what
 * the worker hangs the human's notification off: a card already rejected is
 * not rejected a second time, so nobody is mailed a second time either.
 */
describe('applyVerdict reports whether the state change landed', () => {
  afterEach(() => vi.restoreAllMocks());

  const fakePool = (rowCount: number) => {
    const calls: { sql: string; params: any[] }[] = [];
    vi.spyOn(db, 'getPool').mockReturnValue({
      query: async (sql: string, params: any[] = []) => {
        calls.push({ sql, params });
        return { rows: [], rowCount };
      },
    } as any);
    return calls;
  };

  it('writes the verdict with its timestamp and reports the row it changed', async () => {
    const calls = fakePool(1);
    const r = await applyVerdict(cfg, 'card-1', { pass: false, reason_code: 'weapons' });
    expect(r.applied).toBe(true);
    expect(r.screening).toMatchObject({ pass: false, reason_code: 'weapons' });
    expect(Date.parse(r.screening.at)).toBeGreaterThan(0);
    expect(calls[0].sql).toContain("lifecycle_state='SCREENING_REJECTED'");
    expect(calls[0].sql).toContain("AND lifecycle_state='PENDING_SCREENING'");
    expect(JSON.parse(calls[0].params[1])).toEqual(r.screening);
  });

  it('reports no change when the card had already left PENDING_SCREENING', async () => {
    fakePool(0);
    const r = await applyVerdict(cfg, 'card-1', { pass: false, reason_code: 'weapons' });
    expect(r.applied).toBe(false);
  });
});
