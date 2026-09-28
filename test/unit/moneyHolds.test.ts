/**
 * Money that must move once, or not at all (2026-09-28 review).
 *
 *   1. The seller's "I have it back" and the default rule's release are one
 *      locked decision: exactly one of them can win, and the loser moves
 *      nothing.
 *   2. A chargeback holds the payment: no sweep picks the settlement up, no
 *      confirm goes through, and neither money call moves anything — in the
 *      plain sentence the page and the agent both read.
 *   8. Two "paid" events for one payment never refund the payment the
 *      settlement now holds, and a stray refund names its figure.
 *   9. A release retried past Stripe's idempotency window adopts the transfer
 *      that already went out rather than sending a second one; a stray refund
 *      that fails is said at error level under a stable tag.
 *
 * No database, no Stripe: a fake pool that honours FOR UPDATE with a real
 * mutex, and a fake Stripe that records what it was asked to do.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as db from '../../src/db.js';
import * as crypto from '../../src/crypto.js';
import * as accounts from '../../src/domain/accounts.js';
import { OsbError } from '../../src/protocol.js';
import type { Config } from '../../src/config.js';

// ---------------------------------------------------------------------------
// A fake Stripe that says what it was asked.
// ---------------------------------------------------------------------------
const stripeCalls: { fn: string; args: any[] }[] = [];
let listedTransfers: any[] = [];
let refundCreateFails = false;
let piShape: any = {};
const fakeStripe = {
  transfers: {
    list: async (...args: any[]) => {
      stripeCalls.push({ fn: 'transfers.list', args });
      return { data: listedTransfers };
    },
    create: async (...args: any[]) => {
      stripeCalls.push({ fn: 'transfers.create', args });
      return { id: 'tr_new' };
    },
  },
  refunds: {
    list: async (...args: any[]) => {
      stripeCalls.push({ fn: 'refunds.list', args });
      return { data: [] };
    },
    create: async (...args: any[]) => {
      stripeCalls.push({ fn: 'refunds.create', args });
      if (refundCreateFails) {
        throw Object.assign(new Error('secret-bearing message'), {
          type: 'StripeInvalidRequestError',
          code: 'charge_disputed',
        });
      }
      return { id: 're_new' };
    },
  },
  paymentIntents: {
    retrieve: async (...args: any[]) => {
      stripeCalls.push({ fn: 'paymentIntents.retrieve', args });
      return { id: args[0], latest_charge: 'ch_1', ...piShape };
    },
  },
  v2: {
    core: {
      accounts: {
        retrieve: async () => ({
          configuration: {
            recipient: {
              capabilities: { stripe_balance: { stripe_transfers: { status: 'active' } } },
            },
          },
        }),
      },
    },
  },
};
vi.mock('../../src/stripe.js', async (orig) => ({
  ...(await orig<typeof import('../../src/stripe.js')>()),
  getStripe: async () => fakeStripe,
}));

const settlements = await import('../../src/domain/settlements.js');
const settlementStripe = await import('../../src/domain/settlementStripe.js');
const webhook = await import('../../src/stripeWebhook.js');

const cfg = {
  envName: 'dev',
  counterOrigin: 'https://my.test',
  stripeSecretArn: 'arn:unused',
} as unknown as Config;

const SID = '7a2e5c1d-9f4b-4c8a-b3e6-2d1f0a9b8c7d';
const AGREED_MINOR = 8765;

const row = (over: Record<string, any> = {}): any => ({
  id: SID,
  match_id: '0d9f2c1e-7b4a-4f7e-9c2d-1a2b3c4d5e6f',
  proposer_account: 'buyer-acct',
  buyer_account: 'buyer-acct',
  seller_account: 'seller-acct',
  amount: '87.65',
  ccy: 'AUD',
  state: 'disputed',
  stripe_payment_intent: 'pi_held',
  stripe_transfer_id: null,
  stripe_refund_id: null,
  dispute_ground: 'not_as_described',
  disputed_at: new Date('2026-09-01T00:00:00Z'),
  deadlock_at: new Date('2026-09-15T00:00:00Z'),
  delivery_tracking: null,
  returned_at: null,
  return_received_at: null,
  return_disputed_at: null,
  refund_minor: null,
  release_minor: null,
  chargeback_at: null,
  auto_release_at: null,
  handed_over_at: null,
  split_proposed_by: null,
  ...over,
});

// ---------------------------------------------------------------------------
// A fake pool that means it: one row, a real lock for FOR UPDATE, and every
// UPDATE's WHERE evaluated against the row as it is at that moment.
// ---------------------------------------------------------------------------
let world: any;
let sqlSeen: string[];
let stateWrites: string[];

function whereHolds(sql: string, params: any[], r: any): boolean {
  const where = sql.slice(sql.indexOf('WHERE'));
  const any = where.match(/state = ANY\(\$(\d+)::text\[\]\)/);
  if (any && !params[Number(any[1]) - 1].includes(r.state)) return false;
  const inList = where.match(/state IN \(([^)]*)\)/);
  if (inList) {
    const allowed = inList[1].split(',').map((x) => x.trim().replace(/'/g, ''));
    if (!allowed.includes(r.state)) return false;
  }
  if (/state = 'approved'/.test(where) && r.state !== 'approved') return false;
  for (const m of where.matchAll(/(\w+) IS (NOT )?NULL/g)) {
    const isNull = r[m[1]] === null || r[m[1]] === undefined;
    if (m[2] ? isNull : !isNull) return false;
  }
  if (/deadlock_at <= now\(\)/.test(where) && !(r.deadlock_at && r.deadlock_at <= new Date())) {
    return false;
  }
  return true;
}

function makePool() {
  let locked: Promise<void> = Promise.resolve();
  const query = async (sql: string, params: any[] = []) => {
    sqlSeen.push(sql);
    const rows = (r: any[]) => ({ rows: r, rowCount: r.length });
    const t = sql.trim();
    if (/^SELECT chargeback_at FROM settlements/.test(t)) return rows([world]);
    if (/^SELECT \* FROM settlements WHERE id/.test(t)) return rows(world ? [{ ...world }] : []);
    if (/^SELECT \* FROM settlements WHERE stripe_payment_intent/.test(t)) {
      return rows(world?.stripe_payment_intent === params[0] ? [{ ...world }] : []);
    }
    if (/^UPDATE settlements SET state/.test(t)) {
      if (!whereHolds(t, params, world)) return rows([]);
      world = { ...world, state: params[1] };
      stateWrites.push(params[1]);
      return rows([{ ...world }]);
    }
    if (/^UPDATE settlements SET return_received_at/.test(t)) {
      if (!whereHolds(t, params, world)) return rows([]);
      world = { ...world, return_received_at: new Date(), refund_minor: params[1], release_minor: 0 };
      return rows([{ ...world }]);
    }
    if (/^UPDATE settlements SET refund_minor = 0, release_minor/.test(t)) {
      if (!whereHolds(t, params, world)) return rows([]);
      world = { ...world, refund_minor: 0, release_minor: params[1] };
      return rows([{ ...world }]);
    }
    if (/^UPDATE settlements SET stripe_checkout_session/.test(t)) {
      if (!whereHolds(t, params, world)) return rows([]);
      world = { ...world, stripe_payment_intent: params[2] };
      return rows([{ id: world.id }]);
    }
    if (/^UPDATE settlements SET stripe_transfer_id/.test(t)) {
      world = { ...world, stripe_transfer_id: world.stripe_transfer_id ?? params[1] };
      return rows([]);
    }
    if (/^UPDATE settlements SET stripe_refund_id/.test(t)) {
      world = { ...world, stripe_refund_id: world.stripe_refund_id ?? params[1] };
      return rows([]);
    }
    return rows([]);
  };
  const connect = async () => {
    let release: () => void = () => {};
    const client = {
      query: async (sql: string, params: any[] = []) => {
        if (/FOR UPDATE/.test(sql)) {
          // Wait for whoever holds the row, then hold it ourselves until
          // COMMIT or ROLLBACK.
          const prev = locked;
          let done!: () => void;
          locked = new Promise<void>((res) => (done = res));
          await prev;
          release = done;
        }
        if (/^(COMMIT|ROLLBACK)$/.test(sql.trim())) {
          release();
          release = () => {};
          return { rows: [], rowCount: 0 };
        }
        return query(sql, params);
      },
      release: () => {},
    };
    return client;
  };
  return { query, connect } as any;
}

beforeEach(() => {
  world = row();
  sqlSeen = [];
  stateWrites = [];
  stripeCalls.length = 0;
  listedTransfers = [];
  refundCreateFails = false;
  piShape = {};
  vi.spyOn(db, 'getPool').mockReturnValue(makePool());
  // A consent write that yields, so two roads genuinely interleave.
  vi.spyOn(crypto, 'writeConsentEvent').mockImplementation(async () => {
    await new Promise((r) => setTimeout(r, 5));
    return 'consent-key';
  });
  vi.spyOn(accounts, 'getAccount').mockResolvedValue({
    id: 'seller-acct',
    stripe_account_id_enc: 'enc',
    data_key_enc: 'dk',
  } as any);
  vi.spyOn(crypto, 'decryptFields').mockResolvedValue({ stripe_account_id: 'acct_seller' } as any);
});
afterEach(() => vi.restoreAllMocks());

const seller = () => settlements.counterAction('seller-acct');
const buyer = () => settlements.counterAction('buyer-acct');
const notUnlocked = (e: unknown) => e instanceof OsbError && e.payload.code === 'NOT_UNLOCKED_YET';

// ---------------------------------------------------------------------------
describe('1. the seller\'s "I have it back" and the default rule: one wins', () => {
  it('refuses "I have it back" once the seller has disputed the return', async () => {
    world = row({ returned_at: new Date('2026-09-05'), return_disputed_at: new Date('2026-09-06') });
    const e = await settlements.confirmReturnReceived(seller(), SID).catch((x) => x);
    expect(notUnlocked(e)).toBe(true);
    expect(e.payload.human_action).toMatch(/not what it claims to be/);
    expect(world.refund_minor).toBeNull();
    expect(world.return_received_at).toBeNull();
  });

  it('the deadlock sweep leaves out a return the seller has received', async () => {
    await settlements.settlementsDueForDeadlock();
    const q = sqlSeen.find((s) => /deadlock_at <= now\(\)/.test(s))!;
    expect(q).toMatch(/return_received_at IS NULL/);
  });

  it('a received return retried by the sweep is the refund road, never the rule', async () => {
    await settlements.returnRefundsAwaitingPayment();
    const q = sqlSeen.at(-1)!;
    expect(q).toMatch(/return_received_at IS NOT NULL/);
    expect(q).toMatch(/stripe_refund_id IS NULL/);
    expect(q).toMatch(/chargeback_at IS NULL/);
  });

  it('the default rule re-reads under the lock and refuses a return received since the sweep looked', async () => {
    // What the sweep's snapshot saw: a contested return and delivery shown,
    // so the rule would release. What the row says now: received.
    world = row({
      delivery_tracking: 'AP 1',
      returned_at: new Date('2026-09-05'),
      return_disputed_at: new Date('2026-09-06'),
      return_received_at: new Date('2026-09-20'),
    });
    const e = await settlements
      .deadlockReleaseSettlement(settlements.scheduledAction(), SID)
      .catch((x) => x);
    expect(notUnlocked(e)).toBe(true);
    expect(stateWrites).toEqual([]);
  });

  it('pressed at the same moment on a row the rule would refund: the seller wins, the rule moves nothing', async () => {
    world = row({ delivery_tracking: 'AP 1', returned_at: new Date('2026-09-05') });
    const [a, b] = await Promise.allSettled([
      settlements.confirmReturnReceived(seller(), SID),
      settlements.deadlockReleaseSettlement(settlements.scheduledAction(), SID),
    ]);
    expect(a.status).toBe('fulfilled');
    expect(b.status).toBe('rejected');
    expect(stateWrites).toEqual([]);
    expect(world.refund_minor).toBe(AGREED_MINOR);
    expect(world.release_minor).toBe(0);
  });

  it('pressed at the same moment on a contested return: the rule wins, the seller is refused', async () => {
    world = row({
      delivery_tracking: 'AP 1',
      returned_at: new Date('2026-09-05'),
      return_disputed_at: new Date('2026-09-06'),
    });
    const [a, b] = await Promise.allSettled([
      settlements.deadlockReleaseSettlement(settlements.scheduledAction(), SID),
      settlements.confirmReturnReceived(seller(), SID),
    ]);
    expect(a.status).toBe('fulfilled');
    expect(b.status).toBe('rejected');
    expect(stateWrites).toEqual(['confirmed']);
    expect(world.release_minor).toBe(AGREED_MINOR);
    expect(world.return_received_at).toBeNull();
  });

  it('exactly one wins when the rule would release and a received return lands first', async () => {
    // A row where both could have been attempted from stale reads: the lock
    // serialises them and the second sees the first's write.
    world = row({ delivery_tracking: 'AP 1', returned_at: new Date('2026-09-05') });
    await settlements.confirmReturnReceived(seller(), SID);
    // Now the row changes under a sweep that looked earlier and saw a
    // contested return (simulated by stamping it after the fact).
    world = { ...world, return_disputed_at: new Date() };
    const e = await settlements
      .deadlockReleaseSettlement(settlements.scheduledAction(), SID)
      .catch((x) => x);
    expect(notUnlocked(e)).toBe(true);
    expect(stateWrites).toEqual([]);
  });

  it('pressed again after a failed refund, hands back the row for the retry and writes nothing new', async () => {
    world = row({ returned_at: new Date('2026-09-05') });
    await settlements.confirmReturnReceived(seller(), SID);
    const writesBefore = sqlSeen.filter((s) => /^UPDATE/.test(s.trim())).length;
    const again = await settlements.confirmReturnReceived(seller(), SID);
    expect(again.refund_minor).toBe(AGREED_MINOR);
    expect(sqlSeen.filter((s) => /^UPDATE/.test(s.trim())).length).toBe(writesBefore);
  });
});

// ---------------------------------------------------------------------------
describe('2. a chargeback holds the payment', () => {
  const hold = settlements.CHARGEBACK_HOLD;

  it('the sentence is the plain one', () => {
    expect(hold).toBe(
      "The buyer's bank has opened a dispute; the payment is held until it is settled.",
    );
  });

  it('every sweep that moves money leaves a chargeback out', async () => {
    await settlements.settlementsDueForAutoRelease();
    await settlements.autoReleasesAwaitingTransfer();
    await settlements.splitsAwaitingPayment();
    await settlements.settlementsDueForReturnRefund(7);
    await settlements.settlementsDueForNeverArrivedRefund(7);
    await settlements.settlementsDueForDeadlock();
    await settlements.returnRefundsAwaitingPayment();
    const selects = sqlSeen.filter((s) => /^SELECT \* FROM settlements\s+WHERE/.test(s.trim()));
    expect(selects).toHaveLength(7);
    for (const q of selects) expect(q).toMatch(/chargeback_at IS NULL/);
  });

  it('the release transfer is refused and Stripe is never asked', async () => {
    world = row({ state: 'confirmed', chargeback_at: new Date() });
    await expect(settlementStripe.transferToSellerForSettlement(cfg, world)).rejects.toMatchObject({ payload: { human_action: hold } });
    expect(stripeCalls).toEqual([]);
  });

  it('asks the database, not the row it was handed', async () => {
    const stale = row({ state: 'confirmed' });
    world = { ...stale, chargeback_at: new Date() };
    await expect(settlementStripe.transferToSellerForSettlement(cfg, stale)).rejects.toMatchObject({ payload: { human_action: hold } });
    expect(stripeCalls).toEqual([]);
  });

  it('the refund is refused too', async () => {
    world = row({ chargeback_at: new Date() });
    await expect(
      settlementStripe.refundAgreedAmountForSettlement(world, AGREED_MINOR),
    ).rejects.toMatchObject({ payload: { human_action: hold } });
    expect(stripeCalls).toEqual([]);
  });

  it("the buyer's confirm is refused in the same words and moves no state", async () => {
    world = row({ state: 'evidence-locked', chargeback_at: new Date() });
    const e = await settlements.confirmReceipt(buyer(), SID).catch((x) => x);
    expect(notUnlocked(e)).toBe(true);
    expect(e.payload.human_action).toBe(hold);
    expect(stateWrites).toEqual([]);
  });

  it('the clock cannot confirm past a chargeback that lands after the sweep looked', async () => {
    world = row({ state: 'evidence-locked', chargeback_at: new Date() });
    const e = await settlements
      .autoReleaseSettlement(settlements.scheduledAction(), SID)
      .catch((x) => x);
    expect(notUnlocked(e)).toBe(true);
    expect(stateWrites).toEqual([]);
  });

  it('the settlement read carries the sentence while the settlement is live, and not after', () => {
    const live = settlements.withNote(cfg, row({ state: 'funded', chargeback_at: new Date() }), 'buyer-acct') as any;
    expect(live.note.text).toBe(hold);
    const ended = settlements.withNote(cfg, row({ state: 'released', chargeback_at: new Date() }), 'buyer-acct') as any;
    expect(ended.note).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
describe('8. two "paid" events for one payment', () => {
  const ctx = () => settlements.webhookAction('evt_1', 'checkout.session.completed');

  it('the loser of the claim does not refund the payment the settlement now holds', async () => {
    world = row({ state: 'approved', stripe_payment_intent: null, buyer_total_minor: 9049 });
    piShape = {
      status: 'succeeded',
      amount_received: 9049,
      currency: 'aud',
      transfer_group: SID,
    };
    const log = vi.fn();
    const alarm = vi.fn();
    await Promise.all([
      webhook.handleFunding(cfg, ctx(), SID, 'pi_same', 'cs_1', log, alarm),
      webhook.handleFunding(cfg, ctx(), SID, 'pi_same', 'cs_1', log, alarm),
    ]);
    expect(world.stripe_payment_intent).toBe('pi_same');
    expect(stripeCalls.filter((c) => c.fn === 'refunds.create')).toEqual([]);
    expect(alarm).not.toHaveBeenCalled();
  });

  it('a genuinely stray payment is refunded with its figure named', async () => {
    world = row({ state: 'funded', stripe_payment_intent: 'pi_held' });
    piShape = { amount_received: 9049, latest_charge: { id: 'ch_2', amount_refunded: 49 } };
    const out = await webhook.refundStrayPayment(SID, 'pi_other', vi.fn(), vi.fn());
    expect(out).toBe('refunded');
    const created = stripeCalls.filter((c) => c.fn === 'refunds.create');
    expect(created).toHaveLength(1);
    expect(created[0].args[0]).toMatchObject({ payment_intent: 'pi_other', amount: 9000 });
    expect(created[0].args[1]).toEqual({ idempotencyKey: 'osb-settlement-stray-pi_other' });
  });

  it('re-reads the row and skips a payment the settlement holds', async () => {
    world = row({ state: 'funded', stripe_payment_intent: 'pi_held' });
    const out = await webhook.refundStrayPayment(SID, 'pi_held', vi.fn(), vi.fn());
    expect(out).toBe('held-by-settlement');
    expect(stripeCalls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe('9. the quiet failures', () => {
  it('a stray refund that fails is said at error level under the operator tag, without the message', async () => {
    world = row({ state: 'funded', stripe_payment_intent: 'pi_held' });
    piShape = { amount_received: 9049, latest_charge: { id: 'ch_2', amount_refunded: 0 } };
    refundCreateFails = true;
    const alarm = vi.fn();
    const out = await webhook.refundStrayPayment(SID, 'pi_other', vi.fn(), alarm);
    expect(out).toBe('failed');
    expect(alarm).toHaveBeenCalledTimes(1);
    const [, extra] = alarm.mock.calls[0];
    expect(extra).toMatchObject({
      tag: 'money-needs-operator',
      settlement_id: SID,
      error_code: 'charge_disputed',
    });
    expect(JSON.stringify(extra)).not.toContain('secret-bearing');
  });

  it('a payment that does not match its settlement raises the operator alarm', async () => {
    world = row({ state: 'approved', stripe_payment_intent: null, buyer_total_minor: 9049 });
    piShape = { status: 'succeeded', amount_received: 1, currency: 'aud', transfer_group: SID };
    const alarm = vi.fn();
    await webhook.handleFunding(
      cfg,
      settlements.webhookAction('evt_2', 'checkout.session.completed'),
      SID,
      'pi_bad',
      'cs_2',
      vi.fn(),
      alarm,
    );
    expect(alarm).toHaveBeenCalledTimes(1);
    expect(alarm.mock.calls[0][1]).toMatchObject({ tag: 'money-needs-operator', settlement_id: SID });
    expect(stateWrites).toEqual([]);
  });

  it('a release retried past the idempotency window adopts the transfer that already went out', async () => {
    world = row({ state: 'confirmed' });
    listedTransfers = [
      { id: 'tr_someone_else', destination: 'acct_other', metadata: { osb_settlement_id: SID } },
      { id: 'tr_ours', destination: 'acct_seller', metadata: { osb_settlement_id: SID } },
    ];
    const t = await settlementStripe.transferToSellerForSettlement(cfg, world);
    expect(t.id).toBe('tr_ours');
    expect(stripeCalls.map((c) => c.fn)).toEqual(['transfers.list']);
    expect(stripeCalls[0].args[0]).toMatchObject({ transfer_group: SID });
    expect(world.stripe_transfer_id).toBe('tr_ours');
  });

  it('with nothing out yet, creates the transfer under the settlement key', async () => {
    world = row({ state: 'confirmed' });
    const t = await settlementStripe.transferToSellerForSettlement(cfg, world);
    expect(t.id).toBe('tr_new');
    expect(stripeCalls.map((c) => c.fn)).toEqual(['transfers.list', 'transfers.create']);
    expect(stripeCalls[1].args[1]).toEqual({ idempotencyKey: `osb-settlement-release-${SID}` });
  });
});
