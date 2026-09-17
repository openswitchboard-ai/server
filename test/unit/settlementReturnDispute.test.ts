/**
 * Two records of the same parcel, and a switchboard that judges neither.
 *
 * The defect this suite exists to hold shut is an edit one party could make to
 * the other party's words. Adding delivery tracking rewrote `dispute_ground`:
 * a buyer's "it never arrived" silently became "it arrived and something is
 * wrong with it" the moment the seller typed a reference in. The buyer's own
 * account of the argument was gone from the row — while the frozen vault record
 * still said what they had actually chosen — and with it went the automatic
 * refund the terms give a buyer whose parcel nobody can show.
 *
 * The other half of the same shape was the return. A buyer could mark a return
 * sent with any reference at all, and if the seller had nothing to say for a
 * week the agreed amount went back, whatever had actually turned up. There was
 * no way for the seller to say "that is not what came back".
 *
 * WHAT IS PROVED HERE, with no database, no AWS and no Stripe:
 *   - adding tracking writes tracking, a stamp for when, and nothing else: the
 *     ground the buyer chose is not in the statement at all;
 *   - the never-arrived refund is still selected on that untouched ground, and
 *     what takes a seller who answered out of it is the tracking itself;
 *   - the seller's answer to a return stops the return-silence clock;
 *   - the default rule's ordering: a return outranks delivery tracking only
 *     while nobody has said a word against it, and a contested record counts
 *     for neither side;
 *   - who may say it, and when: the seller, while a return is open.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as db from '../../src/db.js';
import * as crypto from '../../src/crypto.js';
import * as settlements from '../../src/domain/settlements.js';
import type { Config } from '../../src/config.js';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', '..', 'src', 'domain', 'settlements.ts'), 'utf8');

const cfg = {
  envName: 'dev',
  counterOrigin: 'https://my.test',
  evidenceBucket: 'osb-evidence-dev',
  settlementAutoReleaseDays: 7,
  settlementDisputeDeadlockDays: 14,
  settlementReturnSilenceDays: 7,
  settlementTrackingGraceDays: 7,
} as unknown as Config;

const SID = '7a2e5c1d-9f4b-4c8a-b3e6-2d1f0a9b8c7d';
const MID = '0d9f2c1e-7b4a-4f7e-9c2d-1a2b3c4d5e6f';

const row = (over: Record<string, any> = {}): any => ({
  id: SID,
  match_id: MID,
  proposer_account: 'buyer-acct',
  buyer_account: 'buyer-acct',
  seller_account: 'seller-acct',
  amount: '87.65',
  ccy: 'AUD',
  state: 'disputed',
  dispute_ground: 'not_arrived',
  disputed_at: new Date('2026-09-01T00:00:00Z'),
  deadlock_at: new Date('2026-09-15T00:00:00Z'),
  delivery_tracking: null,
  delivery_tracking_key: null,
  tracking_added_at: null,
  return_tracking: null,
  return_tracking_key: null,
  returned_at: null,
  return_received_at: null,
  return_disputed_at: null,
  refund_minor: null,
  release_minor: null,
  split_proposed_by: null,
  ...over,
});

/** Every UPDATE the code under test ran, with its parameters. */
let updates: { sql: string; params: any[] }[];
let consent: Record<string, any>[];

function fakePool(world: any[]) {
  return {
    query: async (sql: string, params: any[] = []) => {
      const rows = (r: any[]) => ({ rows: r, rowCount: r.length });
      if (/^SELECT \* FROM settlements WHERE id/.test(sql.trim())) {
        return rows(world.filter((s) => s.id === params[0]));
      }
      if (/^UPDATE settlements/.test(sql.trim())) {
        updates.push({ sql, params });
        const found = world.find((s) => s.id === params[0]);
        return rows(found ? [found] : []);
      }
      return rows([]);
    },
  } as any;
}

beforeEach(() => {
  updates = [];
  consent = [];
  vi.spyOn(crypto, 'writeConsentEvent').mockImplementation(async (e: any) => {
    consent.push(e);
    return 'consent-key';
  });
});
afterEach(() => vi.restoreAllMocks());

// ---------------------------------------------------------------------------
describe('the ground is the disputer\'s word, and only theirs', () => {
  it('writes tracking and a stamp, and never touches the ground', async () => {
    const world = [row()];
    vi.spyOn(db, 'getPool').mockReturnValue(fakePool(world));
    vi.spyOn(
      await import('../../src/domain/evidence.js'),
      'freezeTrackingRecord',
    ).mockResolvedValue('tracking-key');
    await settlements.addDeliveryTracking(
      settlements.counterAction('seller-acct'),
      cfg,
      SID,
      'AP 7XY441',
    );
    expect(updates).toHaveLength(1);
    expect(updates[0].sql).toContain('delivery_tracking = $2');
    expect(updates[0].sql).toContain('tracking_added_at = COALESCE(tracking_added_at, now())');
    // The whole of the defect, in one assertion: the seller's hand cannot
    // reach the column holding the buyer's account of what went wrong.
    expect(updates[0].sql).not.toContain('dispute_ground');
  });

  it('keeps the ground out of the statement in the source, not just in a mock', () => {
    const fn = src.slice(src.indexOf('export async function addDeliveryTracking'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    expect(body).not.toContain("'not_as_described'");
  });

  it('still selects the never-arrived refund on the untouched ground', async () => {
    let asked = '';
    vi.spyOn(db, 'getPool').mockReturnValue({
      query: async (sql: string) => {
        asked = sql;
        return { rows: [], rowCount: 0 };
      },
    } as any);
    await settlements.settlementsDueForNeverArrivedRefund(7);
    expect(asked).toContain("dispute_ground = 'not_arrived'");
    // And what takes the seller who answered out of it is their own record,
    // rather than an edit to the buyer's.
    expect(asked).toContain('delivery_tracking IS NULL');
  });
});

// ---------------------------------------------------------------------------
describe('the seller\'s answer to a return', () => {
  it('stamps the column, and says so in the consent record', async () => {
    const world = [row({ returned_at: new Date('2026-09-05T00:00:00Z'), return_tracking: 'AP 9' })];
    vi.spyOn(db, 'getPool').mockReturnValue(fakePool(world));
    await settlements.disputeReturn(settlements.counterAction('seller-acct'), SID);
    expect(updates).toHaveLength(1);
    expect(updates[0].sql).toContain('return_disputed_at = COALESCE(return_disputed_at, now())');
    // Guarded on the same facts the button is shown on, so a stale page
    // cannot answer a return that has already been received.
    expect(updates[0].sql).toContain('returned_at IS NOT NULL AND return_received_at IS NULL');
    expect(consent[0]).toMatchObject({
      event: 'settlement-return-disputed',
      party: 'seller',
      account_id: 'seller-acct',
    });
  });

  it('is the seller\'s alone, and only while there is a return to answer', async () => {
    vi.spyOn(db, 'getPool').mockReturnValue(
      fakePool([row({ returned_at: new Date('2026-09-05T00:00:00Z') })]),
    );
    await expect(
      settlements.disputeReturn(settlements.counterAction('buyer-acct'), SID),
    ).rejects.toThrow(/the seller is the one answering a return/);
    expect(updates).toEqual([]);
  });

  it('has nothing to answer before the buyer has sent anything back', async () => {
    vi.spyOn(db, 'getPool').mockReturnValue(fakePool([row()]));
    await expect(
      settlements.disputeReturn(settlements.counterAction('seller-acct'), SID),
    ).rejects.toMatchObject({
      payload: { human_action: expect.stringMatching(/not said they sent it back/) },
    });
    expect(updates).toEqual([]);
  });

  it('is not a way to take back "I have it"', async () => {
    vi.spyOn(db, 'getPool').mockReturnValue(
      fakePool([
        row({
          returned_at: new Date('2026-09-05T00:00:00Z'),
          return_received_at: new Date('2026-09-08T00:00:00Z'),
        }),
      ]),
    );
    await expect(
      settlements.disputeReturn(settlements.counterAction('seller-acct'), SID),
    ).rejects.toMatchObject({
      payload: { human_action: expect.stringMatching(/already said you have it back/) },
    });
    expect(updates).toEqual([]);
  });

  it('said twice is said once: nothing is written the second time', async () => {
    const already = new Date('2026-09-06T00:00:00Z');
    vi.spyOn(db, 'getPool').mockReturnValue(
      fakePool([
        row({ returned_at: new Date('2026-09-05T00:00:00Z'), return_disputed_at: already }),
      ]),
    );
    const r = await settlements.disputeReturn(settlements.counterAction('seller-acct'), SID);
    expect(r.return_disputed_at).toBe(already);
    expect(updates).toEqual([]);
    expect(consent).toEqual([]);
  });

  it('stops the return-silence clock: a seller who answered was not silent', async () => {
    let asked = '';
    vi.spyOn(db, 'getPool').mockReturnValue({
      query: async (sql: string) => {
        asked = sql;
        return { rows: [], rowCount: 0 };
      },
    } as any);
    await settlements.settlementsDueForReturnRefund(7);
    expect(asked).toContain('return_disputed_at IS NULL');
  });
});

// ---------------------------------------------------------------------------
describe('the default rule, with a record the other side has answered', () => {
  const at = new Date('2026-09-05T00:00:00Z');

  it('lets an unanswered return outrank delivery tracking, as it always did', () => {
    expect(
      settlements.deadlockOutcome({ returned_at: at, delivery_tracking: 'AP 1' }),
    ).toBe('refund');
    expect(
      settlements.deadlockOutcome({
        returned_at: at,
        delivery_tracking: 'AP 1',
        return_disputed_at: null,
      }),
    ).toBe('refund');
  });

  it('stops counting a return the seller has answered', () => {
    // The contested record falls out, and the rule looks at what is left: the
    // seller can show where it went, so it goes to them.
    expect(
      settlements.deadlockOutcome({
        returned_at: at,
        delivery_tracking: 'AP 1',
        return_disputed_at: at,
      }),
    ).toBe('release');
    // With nothing left on either side it falls where it always fell: back to
    // the buyer, because posting tracked is the seller's responsibility.
    expect(
      settlements.deadlockOutcome({
        returned_at: at,
        delivery_tracking: null,
        return_disputed_at: at,
      }),
    ).toBe('refund');
  });

  it('is unchanged everywhere nobody has answered anything', () => {
    expect(settlements.deadlockOutcome({ returned_at: null, delivery_tracking: 'AP 1' })).toBe(
      'release',
    );
    expect(settlements.deadlockOutcome({ returned_at: null, delivery_tracking: null })).toBe(
      'refund',
    );
  });
});

// ---------------------------------------------------------------------------
describe('what each side is told', () => {
  const link = `https://my.test/settlements/${SID}`;

  it('tells both sides that two records stand, and nothing moves on its own', () => {
    const contested = row({
      returned_at: new Date('2026-09-05T00:00:00Z'),
      return_disputed_at: new Date('2026-09-06T00:00:00Z'),
    });
    const seller = settlements.disputeNote(contested, 'seller', link)!;
    const buyer = settlements.disputeNote(contested, 'buyer', link)!;
    expect(seller).toContain('not what it claims to be');
    expect(buyer).toContain('not what it claims to be');
    for (const note of [seller, buyer]) {
      expect(note).toContain('stand against each other');
      expect(note).not.toMatch(/\byou can (?:accept|approve|agree|propose|confirm)\b/i);
    }
  });

  it('tells both sides that tracking answers "it never arrived" without settling it', () => {
    const both = row({ dispute_ground: 'not_arrived', delivery_tracking: 'AP 7XY441' });
    for (const side of ['buyer', 'seller'] as const) {
      const note = settlements.disputeNote(both, side, link)!;
      expect(note).toContain('nothing goes either way on its own');
      expect(note).toContain(link);
    }
    // And the seller is no longer being told they have seven days to add what
    // they have already added.
    expect(settlements.disputeNote(both, 'seller', link)).not.toContain('seven days');
  });

  it('still asks a seller who has added nothing for the tracking', () => {
    const note = settlements.disputeNote(row({ dispute_ground: 'not_arrived' }), 'seller', link)!;
    expect(note).toContain('seven days');
  });
});
