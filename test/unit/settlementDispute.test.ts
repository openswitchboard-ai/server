/**
 * A dispute freezes the payment, and the three roads out of it.
 *
 * The defect this suite exists to hold shut is the one the old behaviour WAS:
 * a dispute refunded the buyer's whole total — the agreed amount, our
 * introductory fee and Stripe's cut of the round trip — and left the item with
 * whoever had it. A buyer holding the goods could press one button and keep
 * both, and the platform paid the processor for the privilege. The public
 * terms say something quite different, and this file is where the code is held
 * to them.
 *
 * WHAT IS PROVED HERE, with no database and no Stripe:
 *   - the split arithmetic: two figures that add up to the agreed amount, and
 *     never a fee in either of them;
 *   - the default rule's truth table, which is the whole of "we do not decide
 *     who is right" written as three lines of code;
 *   - the wire shape of a frozen settlement, validated against the protocol;
 *   - the sentence an agent relays, in the plain register, always pointing at
 *     the human's own page and never at something the agent could do;
 *   - the three sweep rules, driven against a fake pool with fake clocks: what
 *     each one selects, what it moves, and — the part that matters most — that
 *     every refund it sends is of the AGREED AMOUNT.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as db from '../../src/db.js';
import * as crypto from '../../src/crypto.js';
import { validateOutbound } from '../../src/protocol.js';
import type { Config } from '../../src/config.js';

// The Stripe half is stood in for: what this suite asks of it is which
// function was called, with which figure.
const moved: { fn: string; settlementId: string; minor?: number }[] = [];
vi.mock('../../src/domain/settlementStripe.js', () => ({
  refundAgreedAmountForSettlement: async (s: any, minor: number) => {
    moved.push({ fn: 'refund', settlementId: s.id, minor });
  },
  transferToSellerForSettlement: async (_cfg: any, s: any, minor?: number) => {
    moved.push({ fn: 'transfer', settlementId: s.id, minor });
  },
  moveSplitForSettlement: async () => {},
}));

const settlements = await import('../../src/domain/settlements.js');
const { runAutoReleaseSweep } = await import('../../src/workers/settlementAutoRelease.js');

const cfg = {
  envName: 'dev',
  counterOrigin: 'https://my.test',
  stripeSecretArn: 'arn:unused',
  evidenceBucket: 'unused-bucket',
  settlementAutoReleaseDays: 7,
  settlementDisputeDeadlockDays: 14,
  settlementReturnSilenceDays: 7,
  settlementTrackingGraceDays: 7,
} as unknown as Config;

const AGREED = 87.65;
const AGREED_MINOR = 8765;

/** A settlement row, with only the interesting parts named. */
const row = (over: Record<string, any> = {}): any => ({
  id: '7a2e5c1d-9f4b-4c8a-b3e6-2d1f0a9b8c7d',
  match_id: '0d9f2c1e-7b4a-4f7e-9c2d-1a2b3c4d5e6f',
  proposer_account: 'buyer-acct',
  buyer_account: 'buyer-acct',
  seller_account: 'seller-acct',
  amount: String(AGREED),
  ccy: 'AUD',
  description: null,
  state: 'disputed',
  fee_amount_minor: 100,
  processing_fee_minor: 184,
  buyer_total_minor: 9049,
  buyer_approved_at: new Date(),
  seller_approved_at: new Date(),
  stripe_checkout_session: null,
  stripe_payment_intent: 'pi_x',
  stripe_transfer_id: null,
  evidence_manifest_key: null,
  handed_over_at: null,
  auto_release_at: null,
  confirmed_via: null,
  auto_released: false,
  dispute_ground: 'not_as_described',
  disputed_by: 'buyer-acct',
  disputed_at: new Date('2026-09-01T00:00:00Z'),
  deadlock_at: new Date('2026-09-15T00:00:00Z'),
  delivery_tracking: null,
  return_tracking: null,
  returned_at: null,
  return_received_at: null,
  refund_minor: null,
  release_minor: null,
  split_proposed_by: null,
  split_buyer_approved_at: null,
  split_seller_approved_at: null,
  stripe_refund_id: null,
  refund_leg_at: null,
  release_leg_at: null,
  ...over,
});

// ---------------------------------------------------------------------------
describe('the split arithmetic: what is held is all there is', () => {
  it('accepts two figures that add up to the agreed amount, either of them zero', () => {
    expect(() => settlements.validateSplit(AGREED_MINOR, 2000, 6765)).not.toThrow();
    expect(() => settlements.validateSplit(AGREED_MINOR, 0, AGREED_MINOR)).not.toThrow();
    expect(() => settlements.validateSplit(AGREED_MINOR, AGREED_MINOR, 0)).not.toThrow();
  });

  it('refuses anything that does not add up, in either direction', () => {
    // A cent over is the whole point: the fee lines are gone to the processor,
    // so there is no slack anywhere in this sum.
    expect(() => settlements.validateSplit(AGREED_MINOR, 2000, 6766)).toThrow(/add up to exactly/);
    expect(() => settlements.validateSplit(AGREED_MINOR, 2000, 6764)).toThrow(/add up to exactly/);
    // And nobody can be paid the fee lines by writing a bigger number.
    expect(() => settlements.validateSplit(AGREED_MINOR, 9049, 0)).toThrow(/add up to exactly/);
    expect(() => settlements.validateSplit(AGREED_MINOR, 0, 9049)).toThrow(/add up to exactly/);
  });

  it('refuses a figure that is not a whole amount of money, or is below nothing', () => {
    expect(() => settlements.validateSplit(AGREED_MINOR, -1, 8766)).toThrow(/less than nothing/);
    expect(() => settlements.validateSplit(AGREED_MINOR, 20.5, 8744.5)).toThrow(/whole amounts/);
    expect(() => settlements.validateSplit(AGREED_MINOR, Number.NaN, 0)).toThrow(/whole amounts/);
  });
});

// ---------------------------------------------------------------------------
describe('the default rule: it follows the parcel, and judges nothing', () => {
  // The truth table the terms print, as three lines. Nobody pleads a case;
  // this is the whole of the decision.
  it('releases to a seller who can show delivery with nothing sent back', () => {
    expect(settlements.deadlockOutcome({ returned_at: null, delivery_tracking: 'AP 1' })).toBe(
      'release',
    );
  });

  it('refunds when the buyer sent it back tracked, delivery tracking or not', () => {
    const at = new Date();
    expect(settlements.deadlockOutcome({ returned_at: at, delivery_tracking: 'AP 1' })).toBe(
      'refund',
    );
    expect(settlements.deadlockOutcome({ returned_at: at, delivery_tracking: null })).toBe('refund');
  });

  it('refunds when neither side has tracking, because posting tracked is the seller\'s job', () => {
    expect(settlements.deadlockOutcome({ returned_at: null, delivery_tracking: null })).toBe(
      'refund',
    );
  });
});

// ---------------------------------------------------------------------------
describe('what a frozen settlement says on the wire', () => {
  it('serializes to a schema-valid message in every new state', () => {
    for (const state of ['disputed', 'resolution-proposed', 'resolved', 'settled-split']) {
      const out = settlements.serializeSettlement(row({ state }));
      expect(validateOutbound('settlement', out).valid, state).toBe(true);
      expect((out as any).state).toBe(state);
    }
  });

  it('carries the ground, the rule\'s date, the tracking and the split', () => {
    const out: any = settlements.serializeSettlement(
      row({
        state: 'resolution-proposed',
        dispute_ground: 'not_arrived',
        delivery_tracking: 'AUPOST 7XY4410092',
        return_tracking: 'AUPOST 9ZZ1',
        refund_minor: 2000,
        release_minor: 6765,
        split_proposed_by: 'buyer-acct',
        split_buyer_approved_at: new Date(),
      }),
    );
    expect(validateOutbound('settlement', out).valid).toBe(true);
    expect(out.dispute_ground).toBe('not_arrived');
    expect(out.deadlock_at).toBe('2026-09-15T00:00:00.000Z');
    // Tracking is the other human's typing, so it crosses labelled as what it
    // is: text to show a person, never an instruction to follow.
    expect(out.delivery_tracking).toEqual({
      text: 'AUPOST 7XY4410092',
      provenance: 'counterparty-untrusted',
    });
    expect(out.return_tracking.provenance).toBe('counterparty-untrusted');
    // The split goes out in whole currency, beside `amount`, never in minor
    // units — an agent reading 2000 as dollars would be a bad afternoon.
    expect(out.resolution).toEqual({
      refund_to_buyer: 20,
      release_to_seller: 67.65,
      approved_by_buyer: true,
      approved_by_seller: false,
    });
    expect(out.resolution.refund_to_buyer + out.resolution.release_to_seller).toBe(AGREED);
  });

  it('calls it a resolution only when a human proposed one', () => {
    // The sweep's rules write the same two columns when they decide a
    // settlement. "The rule sent it back" is not something the two of them
    // agreed, so it does not go out wearing that word.
    const byRule: any = settlements.serializeSettlement(
      row({ state: 'refunded', refund_minor: AGREED_MINOR, release_minor: 0 }),
    );
    expect('resolution' in byRule).toBe(false);
    expect(validateOutbound('settlement', byRule).valid).toBe(true);
  });

  it('says nothing about a dispute on a settlement that is not in one', () => {
    const out: any = settlements.serializeSettlement(
      row({ state: 'funded', dispute_ground: null, deadlock_at: null }),
    );
    expect('dispute_ground' in out).toBe(false);
    expect('deadlock_at' in out).toBe(false);
    expect('resolution' in out).toBe(false);
    expect(validateOutbound('settlement', out).valid).toBe(true);
  });

  it('never carries Stripe identifiers, whichever road it took', () => {
    const flat = JSON.stringify(
      settlements.serializeSettlement(
        row({ state: 'settled-split', stripe_refund_id: 're_x', stripe_transfer_id: 'tr_x' }),
      ),
    );
    expect(flat).not.toContain('re_x');
    expect(flat).not.toContain('tr_x');
    expect(flat).not.toContain('pi_x');
  });
});

// ---------------------------------------------------------------------------
describe('the sentence an agent relays', () => {
  const link = 'https://my.test/settlements/7a2e5c1d-9f4b-4c8a-b3e6-2d1f0a9b8c7d';

  it('tells the buyer what is frozen and where their human acts', () => {
    const note = settlements.disputeNote(row(), 'buyer', link)!;
    expect(note).toContain('The payment is frozen');
    expect(note).toContain('Your human can propose');
    expect(note).toContain(link);
    expect(note).toContain('Tuesday 15 September'); // deadlock_at, in plain words
  });

  it('puts a waiting split in front of the side that has not agreed', () => {
    const waiting = settlements.disputeNote(
      row({
        state: 'resolution-proposed',
        refund_minor: 2000,
        release_minor: 6765,
        split_proposed_by: 'seller-acct',
        split_seller_approved_at: new Date(),
      }),
      'buyer',
      link,
    )!;
    expect(waiting).toContain('20.00 AUD back to the buyer');
    expect(waiting).toContain('67.65 AUD to the seller');
    expect(waiting).toContain('Only your human can accept it');
    // And tells the side that has already agreed that it is not their move.
    const theirs = settlements.disputeNote(
      row({
        state: 'resolution-proposed',
        refund_minor: 2000,
        release_minor: 6765,
        split_proposed_by: 'seller-acct',
        split_seller_approved_at: new Date(),
      }),
      'seller',
      link,
    )!;
    expect(theirs).toContain('Your human has agreed');
    expect(theirs).toContain('until the other side agrees');
  });

  it('asks the seller for tracking when the buyer says nothing arrived', () => {
    const note = settlements.disputeNote(
      row({ dispute_ground: 'not_arrived' }),
      'seller',
      link,
    )!;
    expect(note).toContain('never arrived');
    expect(note).toContain('seven days');
    expect(note).toContain(link);
  });

  it('never suggests the agent does any of it, in any of its shapes', () => {
    const shapes = [
      row(),
      row({ dispute_ground: 'not_arrived' }),
      row({ returned_at: new Date(), return_tracking: 'AP 1' }),
      row({ state: 'resolution-proposed', refund_minor: 2000, release_minor: 6765, split_proposed_by: 'seller-acct' }),
    ];
    for (const side of ['buyer', 'seller'] as const) {
      for (const s of shapes) {
        const note = settlements.disputeNote(s, side, link);
        if (!note) continue;
        // Never in the second person as an instruction to the agent, and never
        // a promise the agent can act: every road ends at the human's page.
        expect(note, JSON.stringify({ side, state: s.state })).not.toMatch(/\byou can (?:accept|approve|agree|propose|confirm)\b/i);
      }
    }
  });

  it('says nothing at all about a settlement that is not frozen', () => {
    expect(settlements.disputeNote(row({ state: 'funded' }), 'buyer', link)).toBeUndefined();
    expect(settlements.disputeNote(row({ state: 'released' }), 'seller', link)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The sweep, against a fake pool and fake clocks.
//
// Each rule gets a world holding exactly the settlements its query would find,
// and the assertions are about what MOVED: which Stripe call, for how much,
// and which state the row was left in.
// ---------------------------------------------------------------------------
describe('the sweep: three rules, and a refund that is never a fee', () => {
  let world: any[];
  let transitions: { to: string; from: string[] }[];

  function fakePool() {
    return {
      query: async (sql: string, params: any[] = []) => {
        const rows = (r: any[]) => ({ rows: r, rowCount: r.length });
        // Each due-query is recognised by the condition that makes it itself.
        if (/state = 'confirmed' AND auto_released = true/.test(sql)) return rows([]);
        if (/state = 'evidence-locked'/.test(sql)) return rows([]);
        if (/returned_at \+ make_interval/.test(sql)) {
          return rows(world.filter((s) => s.due === 'return'));
        }
        if (/dispute_ground = 'not_arrived'/.test(sql)) {
          return rows(world.filter((s) => s.due === 'never-arrived'));
        }
        if (/deadlock_at <= now\(\)/.test(sql)) {
          return rows(world.filter((s) => s.due === 'deadlock'));
        }
        if (/^SELECT \* FROM settlements WHERE id/.test(sql.trim())) {
          return rows(world.filter((s) => s.id === params[0]));
        }
        // The state writer. Recorded rather than executed, so the test can say
        // what the sweep tried to move and out of what.
        if (/UPDATE settlements SET state/.test(sql)) {
          transitions.push({ to: params[1], from: params[2] });
          const found = world.find((s) => s.id === params[0]);
          return rows(found ? [{ ...found, state: params[1] }] : []);
        }
        // Any other write (the figures a rule notes before it moves money)
        // hands the row back so the caller can carry on with it.
        const found = world.find((s) => s.id === params[0]);
        if (found && /refund_minor = \$2/.test(sql)) {
          // A rule about to refund: the buyer's whole agreed amount.
          found.refund_minor = params[1];
          found.release_minor = 0;
        } else if (found && /release_minor = \$2/.test(sql)) {
          // The default rule about to release: the seller's whole agreed amount.
          found.refund_minor = 0;
          found.release_minor = params[1];
        }
        return rows(found ? [found] : []);
      },
    } as any;
  }

  beforeEach(() => {
    world = [];
    moved.length = 0;
    transitions = [];
    vi.spyOn(db, 'getPool').mockReturnValue(fakePool());
    vi.spyOn(crypto, 'writeConsentEvent').mockResolvedValue('consent-key');
  });
  afterEach(() => vi.restoreAllMocks());

  const log = () => {};

  it('a return the seller never acknowledged sends the AGREED amount back', async () => {
    world = [
      row({
        id: 'aaaaaaaa-0000-4000-8000-000000000001',
        due: 'return',
        returned_at: new Date('2026-09-01T00:00:00Z'),
        return_tracking: 'AP 1',
      }),
    ];
    const r = await runAutoReleaseSweep(cfg, log);
    expect(r.returnRefunded).toBe(1);
    expect(moved).toEqual([
      { fn: 'refund', settlementId: 'aaaaaaaa-0000-4000-8000-000000000001', minor: AGREED_MINOR },
    ]);
    // Never the buyer total: the two fee lines stay paid, in every outcome.
    expect(moved[0].minor).not.toBe(9049);
    // And no state was moved by the sweep — 'refunded' lands from the
    // verified charge event, the same as on a human's own road.
    expect(transitions).toEqual([]);
  });

  it('a never-arrived dispute with no tracking sends the AGREED amount back', async () => {
    world = [
      row({
        id: 'aaaaaaaa-0000-4000-8000-000000000002',
        due: 'never-arrived',
        dispute_ground: 'not_arrived',
      }),
    ];
    const r = await runAutoReleaseSweep(cfg, log);
    expect(r.neverArrivedRefunded).toBe(1);
    expect(moved).toEqual([
      { fn: 'refund', settlementId: 'aaaaaaaa-0000-4000-8000-000000000002', minor: AGREED_MINOR },
    ]);
    expect(transitions).toEqual([]);
  });

  it('the default rule releases to a seller who can show delivery', async () => {
    world = [
      row({
        id: 'aaaaaaaa-0000-4000-8000-000000000003',
        due: 'deadlock',
        delivery_tracking: 'AP 7XY441',
      }),
    ];
    const r = await runAutoReleaseSweep(cfg, log);
    expect(r.deadlockReleased).toBe(1);
    expect(r.deadlockRefunded).toBe(0);
    // A release needs a state move first, because 'confirmed' is the state a
    // transfer goes out of. That is the whole reason a scheduled context
    // exists, and it is the only state the sweep writes.
    expect(transitions).toEqual([
      { to: 'confirmed', from: ['disputed', 'resolution-proposed'] },
    ]);
    expect(moved).toEqual([
      { fn: 'transfer', settlementId: 'aaaaaaaa-0000-4000-8000-000000000003', minor: AGREED_MINOR },
    ]);
  });

  it('the default rule refunds when the buyer sent it back, or when neither can show anything', async () => {
    world = [
      row({
        id: 'aaaaaaaa-0000-4000-8000-000000000004',
        due: 'deadlock',
        delivery_tracking: 'AP 7XY441',
        returned_at: new Date('2026-09-10T00:00:00Z'),
      }),
      row({ id: 'aaaaaaaa-0000-4000-8000-000000000005', due: 'deadlock' }),
    ];
    const r = await runAutoReleaseSweep(cfg, log);
    expect(r.deadlockRefunded).toBe(2);
    expect(r.deadlockReleased).toBe(0);
    expect(moved.map((m) => m.fn)).toEqual(['refund', 'refund']);
    for (const m of moved) expect(m.minor).toBe(AGREED_MINOR);
    expect(transitions).toEqual([]);
  });

  it('a sweep over a board with nothing due moves nothing at all', async () => {
    const r = await runAutoReleaseSweep(cfg, log);
    expect(moved).toEqual([]);
    expect(transitions).toEqual([]);
    expect(r.returnRefunded + r.neverArrivedRefunded + r.deadlockReleased + r.deadlockRefunded).toBe(0);
  });

  it('a deployment with payments switched off runs no clock at all', async () => {
    world = [row({ id: 'aaaaaaaa-0000-4000-8000-000000000006', due: 'deadlock' })];
    const off = { ...cfg, stripeSecretArn: undefined } as Config;
    const r = await runAutoReleaseSweep(off, log);
    expect(moved).toEqual([]);
    expect(r.deadlockRefunded).toBe(0);
  });

  it('the day counts are whole numbers in a sane range, checked before the database', async () => {
    for (const bad of [0, -1, 7.5, 91, Number.NaN]) {
      await expect(settlements.settlementsDueForReturnRefund(bad)).rejects.toThrow(
        /bad return silence window/,
      );
      await expect(settlements.settlementsDueForNeverArrivedRefund(bad)).rejects.toThrow(
        /bad tracking grace window/,
      );
    }
  });
});

// ---------------------------------------------------------------------------
describe('the dispute itself', () => {
  beforeEach(() => {
    vi.spyOn(crypto, 'writeConsentEvent').mockResolvedValue('consent-key');
  });
  afterEach(() => vi.restoreAllMocks());

  it('demands a ground the terms know about, before any row is read', async () => {
    const ctx = settlements.counterAction('00000000-0000-0000-0000-000000000000');
    for (const bad of ['', 'because', 'not_arrived_yet', 'NOT_ARRIVED']) {
      await expect(settlements.openDispute(ctx, 'sid', bad as any, 14)).rejects.toThrow(
        /which of the two things went wrong/,
      );
    }
  });

  it('demands a whole number of days for its clock, before any row is read', async () => {
    const ctx = settlements.counterAction('00000000-0000-0000-0000-000000000000');
    for (const bad of [0, -1, 14.5, 91, Number.NaN]) {
      await expect(
        settlements.openDispute(ctx, 'sid', 'not_as_described', bad),
      ).rejects.toThrow(/bad dispute window/);
    }
    // A good one gets through to the database instead.
    await expect(
      settlements.openDispute(ctx, 'sid', 'not_as_described', 14),
    ).rejects.toThrow(/db not initialised/);
  });

  it('a tracking reference has to be something, and is capped', async () => {
    const ctx = settlements.counterAction('00000000-0000-0000-0000-000000000000');
    for (const fn of [settlements.addDeliveryTracking, settlements.markReturned]) {
      await expect(fn(ctx, 'sid', '   ')).rejects.toThrow(/tracking reference is needed/);
    }
  });
});

// ---------------------------------------------------------------------------
describe('a finished protected payment closes the door on the introduction', () => {
  it('bars a fresh one after released, refunded and settled-split alike', () => {
    // The terms: "After a protected payment has been released or refunded, no
    // further protected payment can be opened on the same introduction." Read
    // off the guard itself, because this is a claim about one SQL predicate.
    const src = require('node:fs').readFileSync(
      require('node:path').join(__dirname, '..', '..', 'src', 'domain', 'settlements.ts'),
      'utf8',
    );
    const start = src.indexOf('One FINISHED protected payment');
    const guard = src.slice(start, src.indexOf('}', src.indexOf('if (finished.rowCount)', start)));
    expect(guard).toContain("state IN ('released','refunded','settled-split')");
    // A declined settlement leaves the door open: nothing was ever paid, and
    // the two of them may simply want to try again.
    expect(guard).toContain('DECLINED one leaves');
    // And the terminal set the "one live settlement" check uses agrees.
    expect(settlements.TERMINAL_STATES).toEqual([
      'released',
      'refunded',
      'settled-split',
      'declined',
    ]);
  });
});
