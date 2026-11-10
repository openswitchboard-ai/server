/**
 * THREE HOLES AROUND A FIGURE, closed together (10 November 2026).
 *
 *  1. A sealed best offer was emailed to the seller early. A buyer who typed
 *     their one number on their own page set off the "an offer is on the
 *     table" email, figure and all, to a seller who hears by email, while the
 *     gathering window that is meant to keep every number from them was still
 *     open. A sealed number now sends no email.
 *
 *  2. The seller's private floor could be found by trying numbers. A number
 *     under it was refused and one over it was answered another way, so an
 *     assistant could walk to the floor in about twenty calls. Now no number
 *     is refused for being low: every one goes in and reaches the seller, and
 *     the floor is not read at all while a number is put in, so the answer is
 *     the same over or under. (The seller's side weighs the numbers against
 *     the floor once the window has closed; fitSequencer.test.ts holds that.)
 *
 *  3. An offer could be accepted after its introduction had ended. Most ways
 *     an introduction ends never touch its offers, so a figure stayed open for
 *     the rest of its month and the accept never looked at the introduction.
 *     Every accept path now does.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/crypto.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  encryptField: vi.fn(async (_a: string, _k: Buffer, plaintext: string) =>
    Buffer.from(`enc:${plaintext}`),
  ),
  decryptFields: vi.fn(async (_a: string, _k: Buffer, fields: Record<string, Buffer>) =>
    Object.fromEntries(
      Object.entries(fields).map(([k, v]) => [k, v.toString('utf8').replace(/^enc:/, '')]),
    ),
  ),
  writeConsentEvent: vi.fn(async () => 'consent-events/x'),
  writeDecryptAudit: vi.fn(async () => 'decrypt-audit/x'),
}));

vi.mock('../../src/counter/email.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  sendApprovalEmail: vi.fn(async () => ({ status: 'sent' })),
  sendOfferOnTheTableEmail: vi.fn(async () => ({ status: 'sent' })),
  sendDealAgreedEmail: vi.fn(async () => ({ status: 'sent' })),
  sendReceiptEmail: vi.fn(async () => ({ status: 'sent' })),
}));

import { decryptFields, writeConsentEvent } from '../../src/crypto.js';
import { sendOfferOnTheTableEmail } from '../../src/counter/email.js';
import * as db from '../../src/db.js';
import * as receiptModule from '../../src/domain/receipt.js';
import * as offers from '../../src/domain/offers.js';
import { acceptNumberLink } from '../../src/domain/humanLinks.js';
import { lintHumanCopy } from '../../src/email/lint.js';
import { OsbError } from '../../src/protocol.js';
import type { Config } from '../../src/config.js';

const cfg = {
  envName: 'dev',
  counterOrigin: 'https://my.test',
  publicOrigin: 'https://mcp.test',
  opsQueueUrl: 'https://ops.test/queue',
  quotas: { maxOpenCards: 5, maxPublishesPerDay: 10, maxOffersPerHour: 60 },
} as unknown as Config;

const MATCH = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const ANA = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'; // the WANT side (buyer)
const BEPPE = 'cccccccc-3333-4333-8333-cccccccccccc'; // the HAVE side (seller)
const CARD_W = 'dddddddd-4444-4444-8444-dddddddddddd';
const CARD_H = 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee';
const OFFER = '0f0f0f0f-0000-4000-8000-000000000001';

interface World {
  sale: 'straight' | 'best-offer';
  /** The asking price on the have, for a best offer posted before the rule. */
  ask: { amount: number; ccy: string } | null;
  /** The seller's private floor, inside the encrypted band. */
  floor: number | null;
  /** The buyer's mode on their want: Pass on, or numbers to work within. */
  mode: 'relay' | 'mandate';
  /** The introduction's state as getMatch reads it. */
  matchState: string;
  /** And as the locked read inside the accept sees it, when different. */
  lockedState?: string;
  offers: any[];
}
let world: World;
let offerSeq = 0;

const theMatch = () => ({
  id: MATCH,
  card_want: CARD_W,
  card_have: CARD_H,
  account_want: ANA,
  account_have: BEPPE,
  score: 0.8,
  category: 'goods.bicycle.mountain',
  stage: 4,
  state: world.matchState,
  live: true,
  opened_at: new Date('2026-11-01T00:00:00Z'),
});

const withConnect = (p: any) => ({
  ...p,
  connect: async () => ({ query: p.query, release: () => {} }),
});

function fakePool() {
  return {
    query: async (sql: string, params: any[] = []) => {
      const rows = (r: any[]) => ({ rows: r, rowCount: r.length });
      if (/SELECT hears_via FROM accounts/.test(sql)) return rows([{ hears_via: 'email' }]);
      if (/^\s*SELECT \* FROM accounts WHERE id/.test(sql)) {
        return rows([
          {
            id: params[0],
            status: 'active',
            data_key_enc: Buffer.from('wrapped'),
            email_enc: Buffer.from(`enc:${params[0]}@example.test`),
            hears_via: 'email',
          },
        ]);
      }
      // The best-offer reads: the sale behind the introduction, then the floor.
      if (/SELECT c\.id AS card_id, c\.sale/.test(sql)) {
        return rows([
          {
            card_id: CARD_H,
            sale: world.sale,
            ask: world.ask,
            gather_until: new Date(Date.now() + 3_600_000),
            gather_closed_at: null,
            open: true,
          },
        ]);
      }
      if (/SELECT c\.account_id, c\.price_enc, a\.data_key_enc/.test(sql)) {
        return rows([
          {
            account_id: BEPPE,
            data_key_enc: Buffer.from('k'),
            price_enc:
              world.floor === null
                ? null
                : Buffer.from(`enc:${JSON.stringify({ band: { min: world.floor }, ccy: 'AUD' })}`),
          },
        ]);
      }
      if (/SELECT state FROM matches WHERE id = \$1 FOR SHARE/.test(sql)) {
        return rows([{ state: world.lockedState ?? world.matchState }]);
      }
      // acceptNumberLink's read of the offer with its introduction.
      if (/FROM offers o\s+JOIN matches m ON m\.id = o\.match_id WHERE o\.id/.test(sql)) {
        const o = world.offers.find((x) => x.id === params[0]);
        return rows(
          o
            ? [{ ...o, ...theMatch(), id: o.id, state: o.state, match_state: world.matchState }]
            : [],
        );
      }
      if (/FROM matches/.test(sql) && /^\s*SELECT (\*|m\.\*)/.test(sql)) return rows([theMatch()]);
      if (/SELECT account_id, type, negotiation_mode, mandate_enc FROM cards/.test(sql)) {
        return rows([
          {
            account_id: params[0] === CARD_W ? ANA : BEPPE,
            type: params[0] === CARD_W ? 'WANT' : 'HAVE',
            negotiation_mode: params[0] === CARD_W ? world.mode : 'relay',
            mandate_enc:
              params[0] === CARD_W && world.mode === 'mandate'
                ? Buffer.from(`enc:${JSON.stringify({ limit: 1000, ccy: 'AUD' })}`)
                : null,
          },
        ]);
      }
      if (/SELECT count\(\*\)::int AS n FROM offers/.test(sql)) return rows([{ n: 0 }]);
      if (/SELECT count\(\*\)::int AS n,\s*min\(created_at\)/.test(sql)) {
        return rows([{ n: 0, oldest: new Date() }]);
      }
      if (/SELECT 1 FROM offers/.test(sql)) {
        return rows(world.offers.filter((o) => o.state !== 'withdrawn').map(() => ({ '?column?': 1 })));
      }
      if (/INSERT INTO offers/.test(sql)) {
        const row = {
          id: `0f0f0f0f-0000-4000-8000-00000000010${offerSeq++}`,
          match_id: params[0],
          proposer_account: params[1],
          amount: String(params[2]),
          ccy: params[3],
          expiry: new Date(params[4]),
          state: 'proposed',
          message: null,
          authored_by: params[6],
          best_offer: params[7],
          created_at: new Date(),
        };
        world.offers.push(row);
        return rows([row]);
      }
      if (/SELECT \* FROM offers WHERE id/.test(sql)) {
        return rows(world.offers.filter((o) => o.id === params[0]));
      }
      if (/UPDATE offers SET state='accepted-by-human'/.test(sql)) {
        const o = world.offers.find((x) => x.id === params[0]);
        if (o) o.state = 'accepted-by-human';
        return rows(o ? [o] : []);
      }
      if (/UPDATE offers SET state='awaiting-human'/.test(sql)) {
        const o = world.offers.find((x) => x.id === params[0]);
        if (o) o.state = 'awaiting-human';
        return rows(o ? [o] : []);
      }
      if (/SELECT \* FROM cards WHERE id/.test(sql)) {
        return rows([{ id: params[0], account_id: params[0] === CARD_W ? ANA : BEPPE }]);
      }
      return rows([]);
    },
  } as any;
}

beforeEach(() => {
  offerSeq = 0;
  world = {
    sale: 'best-offer',
    ask: null,
    floor: 100,
    mode: 'relay',
    matchState: 'open',
    offers: [],
  };
  vi.spyOn(db, 'getPool').mockReturnValue(withConnect(fakePool()));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.mocked(writeConsentEvent).mockClear();
  vi.mocked(decryptFields).mockClear();
  vi.mocked(sendOfferOnTheTableEmail).mockClear();
});

const propose = (amount: number, author: 'human' | 'agent' = 'human', ccy = 'AUD') =>
  offers.proposeOffer(
    cfg,
    ANA,
    {
      match_id: MATCH,
      amount,
      ccy,
      expiry: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    },
    { author },
  );

const refusal = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
    return undefined;
  } catch (e) {
    if (e instanceof OsbError) return e.payload as any;
    throw e;
  }
};

/** A plain open offer from the buyer, for the accept paths. */
const standingOffer = (state = 'proposed') => {
  const o = {
    id: OFFER,
    match_id: MATCH,
    proposer_account: ANA,
    amount: '415',
    ccy: 'AUD',
    expiry: new Date(Date.now() + 7 * 86_400_000),
    state,
    message: null,
    authored_by: 'human',
    created_at: new Date(),
  };
  world.offers.push(o);
  return o;
};

// ---------------------------------------------------------------------------
describe('a sealed best offer is never emailed to the seller', () => {
  it('sends no email for a number put in while the window is open', async () => {
    const o: any = await propose(150);
    expect(o.amount).toBe(150);
    expect(world.offers[0].best_offer).toBe(true);
    expect(vi.mocked(sendOfferOnTheTableEmail)).not.toHaveBeenCalled();
  });

  it('still emails the other human on a straight sale', async () => {
    world.sale = 'straight';
    await propose(150);
    expect(vi.mocked(sendOfferOnTheTableEmail)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendOfferOnTheTableEmail).mock.calls[0]![2]).toBe(BEPPE);
  });
});

// ---------------------------------------------------------------------------
describe('every number on a best offer goes in, under the floor or over it', () => {
  const floorReads = () =>
    vi.mocked(decryptFields).mock.calls.filter((c: any[]) => c[3]?.purpose === 'best-offer-floor');

  it('places a number under the floor that a human typed on their page', async () => {
    const o: any = await propose(40);
    expect(o.amount).toBe(40);
    expect(world.offers).toHaveLength(1);
  });


  it('gives an assistant on Pass on its link, the same over the floor as under it', async () => {
    const under = await refusal(() => propose(40, 'agent'));
    const over = await refusal(() => propose(500, 'agent'));
    expect(under.code).toBe('CONSENT_REQUIRED');
    expect(over.code).toBe(under.code);
    expect(Object.keys(over).sort()).toEqual(Object.keys(under).sort());
    expect(under.human_action).not.toMatch(/floor/i);
    expect(world.offers).toHaveLength(0);
  });

  it('answers a human the same shape over the floor as under it', async () => {
    const under: any = await propose(40);
    world.offers = [];
    const over: any = await propose(500);
    expect(Object.keys(over).sort()).toEqual(Object.keys(under).sort());
    expect(over.state).toBe(under.state);
  });

  it('never reads the floor while a number is put in', async () => {
    await propose(40);
    world.offers = [];
    world.mode = 'mandate';
    await refusal(() => propose(60, 'agent'));
    world.mode = 'relay';
    await refusal(() => propose(500, 'agent'));
    expect(floorReads()).toHaveLength(0);
  });

  it('takes a number in another currency as it was typed', async () => {
    const o: any = await propose(40, 'human', 'USD');
    expect(o.ccy).toBe('USD');
  });
});

// ---------------------------------------------------------------------------
describe("a number on a best offer is always the human's own press", () => {
  const purposes = () => vi.mocked(decryptFields).mock.calls.map((c: any[]) => c[3]?.purpose);
  beforeEach(() => {
    world.mode = 'mandate';
  });

  it('answers an assistant on Auto-negotiate with the human\'s link, as on Pass on', async () => {
    const auto = await refusal(() => propose(150, 'agent'));
    expect(world.offers).toHaveLength(0);
    world.mode = 'relay';
    const passOn = await refusal(() => propose(150, 'agent'));
    expect(auto.code).toBe('CONSENT_REQUIRED');
    expect(Object.keys(auto).sort()).toEqual(Object.keys(passOn).sort());
    expect(auto.human_action).toBe(passOn.human_action);
    expect(world.offers).toHaveLength(0);
  });

  it('never reads the numbers written for Auto-negotiate on that road', async () => {
    await refusal(() => propose(150, 'agent'));
    expect(purposes()).not.toContain('mandate-offer-check');
  });

  it('still hands over the link for a number past what those numbers allowed', async () => {
    const p = await refusal(() => propose(5000, 'agent'));
    expect(p.code).toBe('CONSENT_REQUIRED');
    expect(p.human_action).toBe(
      (await refusal(async () => {
        world.mode = 'relay';
        return propose(5000, 'agent');
      })).human_action,
    );
  });

  it.each([40, 150])('places %i when the human presses for it', async (amount) => {
    // The page's press puts the figure in as the human's own (counter/routes.ts
    // offer-send calls proposeOffer with author 'human').
    const o: any = await propose(amount, 'human');
    expect(o.amount).toBe(amount);
    expect(world.offers).toHaveLength(1);
  });

  it('leaves Auto-negotiate working on a straight sale, inside the numbers', async () => {
    world.sale = 'straight';
    const o: any = await propose(150, 'agent');
    expect(o.amount).toBe(150);
    expect(world.offers).toHaveLength(1);
    expect(purposes()).toContain('mandate-offer-check');
  });
});

// ---------------------------------------------------------------------------
describe('an offer cannot be taken once its introduction has ended', () => {
  beforeEach(() => {
    world.sale = 'straight';
    vi.spyOn(receiptModule, 'buildReceipt').mockRejectedValue(new Error('not needed here'));
  });

  it('accepts on an open introduction, as it always did', async () => {
    standingOffer();
    const o: any = await offers.acceptOfferByHuman(OFFER, BEPPE, 'counter', cfg);
    expect(o.state).toBe('accepted-by-human');
  });

  it.each(['declined', 'archived', 'closed'])(
    'refuses the press on one that is %s, and writes nothing',
    async (state) => {
      standingOffer();
      world.matchState = state;
      const p = await refusal(() => offers.acceptOfferByHuman(OFFER, BEPPE, 'counter', cfg));
      expect(p.code).toBe('NOT_UNLOCKED_YET');
      expect(p.human_action).toBe(offers.INTRODUCTION_ENDED_WORDS);
      expect(writeConsentEvent).not.toHaveBeenCalled();
      expect(world.offers[0].state).toBe('proposed');
    },
  );

  it('refuses under the lock where the introduction ended after the first read', async () => {
    standingOffer();
    world.lockedState = 'archived';
    const p = await refusal(() => offers.acceptOfferByHuman(OFFER, BEPPE, 'counter', cfg));
    expect(p.human_action).toBe(offers.INTRODUCTION_ENDED_WORDS);
    expect(writeConsentEvent).not.toHaveBeenCalled();
    expect(world.offers[0].state).toBe('proposed');
  });

  it('parks nothing for a human on one that has ended', async () => {
    standingOffer();
    world.matchState = 'archived';
    const p = await refusal(() => offers.agentOfferAction(cfg, BEPPE, OFFER, 'send_to_human'));
    expect(p.human_action).toBe(offers.INTRODUCTION_ENDED_WORDS);
    expect(world.offers[0].state).toBe('proposed');
  });

  it('mints no page to accept on one that has ended', async () => {
    standingOffer();
    world.matchState = 'declined';
    const p = await refusal(() => acceptNumberLink(cfg, BEPPE, OFFER));
    expect(p.human_action).toBe(offers.INTRODUCTION_ENDED_WORDS);
  });

  it('says it in words that pass the copy rules', () => {
    expect(lintHumanCopy(offers.INTRODUCTION_ENDED_WORDS)).toEqual([]);
  });

  it('leaves an offer already accepted exactly as it is', async () => {
    standingOffer('accepted-by-human');
    world.matchState = 'archived';
    await refusal(() => offers.acceptOfferByHuman(OFFER, BEPPE, 'counter', cfg));
    expect(world.offers[0].state).toBe('accepted-by-human');
  });
});
