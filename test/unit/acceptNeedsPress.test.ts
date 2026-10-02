/**
 * N4: an accept is only ever recorded from
 * the human's own press. acceptOfferByHuman checks recorded_via itself, the
 * ops queue's accept op is refused, and the database constraint says the same.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/crypto.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  writeConsentEvent: vi.fn(async () => 'consent-events/x'),
}));

import { writeConsentEvent } from '../../src/crypto.js';
import * as db from '../../src/db.js';
import {
  ACCEPT_RECORDED_VIA,
  acceptOfferByHuman,
  isAcceptRecordedVia,
} from '../../src/domain/offers.js';

const root = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(writeConsentEvent).mockClear();
});

describe('acceptOfferByHuman needs a press', () => {
  it('the closed set is the page press and nothing else', () => {
    expect([...ACCEPT_RECORDED_VIA]).toEqual(['counter']);
    expect(isAcceptRecordedVia('counter')).toBe(true);
    for (const v of ['internal-ops', 'ops-cli', 'integration-suite', 'agent', '', 'Counter', undefined, null, 1]) {
      expect(isAcceptRecordedVia(v)).toBe(false);
    }
  });

  it.each([
    ['internal-ops'],
    ['ops-cli'],
    ['integration-suite'],
    [''],
    [undefined],
    [null],
  ])('refuses %j before reading or writing anything', async (via) => {
    const query = vi.fn(async () => {
      throw new Error('the database must not be asked');
    });
    vi.spyOn(db, 'getPool').mockReturnValue({ query } as any);
    await expect(acceptOfferByHuman('offer-1', 'acct-1', via as any)).rejects.toThrow(
      /only recorded from the human's own press/,
    );
    expect(query).not.toHaveBeenCalled();
    expect(writeConsentEvent).not.toHaveBeenCalled();
  });

  it('lets a press through to the ordinary checks', async () => {
    // With a real recorded_via it goes on to load the offer; here there is
    // none, so it fails on that instead — past the press check.
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    vi.spyOn(db, 'getPool').mockReturnValue({ query } as any);
    await expect(acceptOfferByHuman('offer-1', 'acct-1', 'counter')).rejects.not.toThrow(
      /only recorded from the human's own press/,
    );
    expect(query).toHaveBeenCalled();
  });

  it('every caller in src passes the press value', () => {
    const routes = read('src/counter/routes.ts');
    const calls = [...routes.matchAll(/acceptOfferByHuman\(([^)]*)\)/g)].map((m) => m[1]);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const args of calls) expect(args).toMatch(/'counter'/);
  });
});

describe('the ops queue cannot accept', () => {
  it('the accept op no longer calls acceptOfferByHuman or supplies a recorded_via', () => {
    const w = read('src/workers/opsWorker.ts');
    expect(w).not.toMatch(/acceptOfferByHuman\(/);
    expect(w).not.toMatch(/\?\? *'internal-ops'/);
    const arm = w.slice(w.indexOf("case 'accept-offer-by-human'"));
    expect(arm.slice(0, arm.indexOf('break;'))).toMatch(/refused/);
  });

  it('the database refuses an offer-accept that is not a press', () => {
    const sql = read('migrations/061_accept_needs_a_press.sql');
    expect(sql).toMatch(/ALTER TABLE consent_tokens ADD CONSTRAINT consent_tokens_recorded_via_press\s+CHECK \(recorded_via = 'counter'\)/);
  });
});
