/**
 * What an agent can see about the money, and what happens to an introduction
 * when the listing under it comes down.
 *
 * Three defects from the 2026-09-09 rehearsal live here.
 *
 *  1. A note read "[object Object]". An offer's message is stored as
 *     { text, provenance } and the sweep was dropping the whole object into a
 *     sentence written for a human.
 *  2. An agent could see only the OTHER side's figures. Its human had typed
 *     $420 on their own approval page, which no agent ever saw happen, so the
 *     agent told them their number "never went out" and described the other
 *     side's $415 as unprompted. Both sides of the table cross now.
 *  3. When the other side accepted, nothing said so. check_in now carries the
 *     word deal_agreed and a sentence saying the switchboard's part is done.
 *
 * And the fourth, from the same run: withdrawing a listing left every
 * introduction on it live, so a sold bike kept advancing with people who could
 * no longer have it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/crypto.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  decryptFields: vi.fn(async (_a: string, _k: Buffer, fields: Record<string, Buffer>) =>
    Object.fromEntries(
      Object.entries(fields).map(([k, v]) => [k, v.toString('utf8').replace(/^enc:/, '')]),
    ),
  ),
  writeConsentEvent: vi.fn(async () => 'consent-events/x'),
  writeDecryptAudit: vi.fn(async () => 'decrypt-audit/x'),
}));

import { writeConsentEvent } from '../../src/crypto.js';
import * as db from '../../src/db.js';
import * as cards from '../../src/domain/cards.js';
import * as offers from '../../src/domain/offers.js';
import { dispatchTool } from '../../src/mcp/tools.js';
import { SERVER_INSTRUCTIONS } from '../../src/mcp/instructions.js';
import type { Config } from '../../src/config.js';

const cfg = {
  envName: 'dev',
  counterOrigin: 'https://my.test',
  publicOrigin: 'https://mcp.test',
} as unknown as Config;

const MATCH = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const ANA = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'; // this agent's human
const BEPPE = 'cccccccc-3333-4333-8333-cccccccccccc'; // the other side
const CARD_W = 'dddddddd-4444-4444-8444-dddddddddddd';
const CARD_H = 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee';

/** The words no note may ever carry to a human. */
const BANNED = ['card', 'channel', 'match', 'stage', 'WANT', 'HAVE', 'connection', 'score'];

interface OfferRow {
  id: string;
  proposer_account: string;
  amount: string;
  ccy: string;
  state: string;
  message: any;
  authored_by: string;
  created_at: Date;
}

interface World {
  offers: OfferRow[];
  matchState: 'open' | 'archived';
  /** true = the two are already talking (stage 4, conversation open) */
  talking: boolean;
  cardState: string;
  archivedMatches: { id: string; by: string; via: string }[];
  expiredMessagesFor: string[][];
}
let world: World;

const offer = (over: Partial<OfferRow> & { at: number }): OfferRow => ({
  id: `0f0f0f0f-0000-4000-8000-${String(over.at).padStart(12, '0')}`,
  proposer_account: ANA,
  amount: '420',
  ccy: 'AUD',
  state: 'proposed',
  message: null,
  authored_by: 'human',
  created_at: new Date(Date.UTC(2026, 8, 9, 10, over.at)),
  ...over,
});

const theMatch = () => ({
  id: MATCH,
  card_want: CARD_W,
  card_have: CARD_H,
  account_want: ANA,
  account_have: BEPPE,
  score: 0.8,
  category: 'goods.bicycle.mountain',
  stage: world.talking ? 4 : 2,
  interest_want: true,
  interest_have: true,
  state: world.matchState,
  channel_id: world.talking ? 'ch_11111111-2222-4333-8444-555555555555' : null,
  opened_at: world.talking ? new Date('2026-09-11T06:00:00Z') : null,
});

function fakePool() {
  return {
    query: async (sql: string, params: any[] = []) => {
      const rows = (r: any[]) => ({ rows: r, rowCount: r.length });
      if (/read_calls/.test(sql)) return rows([{ n: 0, oldest: null }]);
      if (/SELECT arrangement FROM accounts/.test(sql)) return rows([{ arrangement: null }]);
      if (/SELECT hears_via FROM accounts/.test(sql)) return rows([{ hears_via: 'email' }]);
      if (/FROM matches m/.test(sql) && /SELECT m\.\*/.test(sql)) return rows([theMatch()]);
      if (/^\s*SELECT \* FROM matches WHERE id/.test(sql)) return rows([theMatch()]);
      // No collection window on anybody's listing here.
      if (/collect_until > now\(\)/.test(sql)) return rows([]);
      if (/^\s*SELECT \* FROM cards WHERE id/.test(sql)) {
        return rows([
          {
            id: params[0],
            account_id: params[0] === CARD_W ? ANA : BEPPE,
            type: params[0] === CARD_W ? 'WANT' : 'HAVE',
            category: 'goods.bicycle.mountain',
            attributes: { frame: 'medium' },
            ask: null,
            lifecycle_state: world.cardState,
          },
        ]);
      }
      if (/SELECT amount, ccy, message FROM offers/.test(sql)) {
        const live = world.offers
          .filter((o) => o.proposer_account !== params[1] && ['proposed', 'awaiting-human'].includes(o.state))
          .sort((a, b) => +b.created_at - +a.created_at);
        return rows(live.slice(0, 1));
      }
      if (/SELECT id, proposer_account, amount, ccy, state, message, authored_by/.test(sql)) {
        return rows(
          world.offers
            .filter((o) => ['proposed', 'awaiting-human', 'accepted-by-human'].includes(o.state))
            .sort((a, b) => +b.created_at - +a.created_at),
        );
      }
      if (/UPDATE cards SET lifecycle_state='WITHDRAWN'/.test(sql)) {
        world.cardState = 'WITHDRAWN';
        return rows([]);
      }
      if (/UPDATE matches\s+SET state = 'archived'/.test(sql)) {
        if (world.matchState !== 'open') return rows([]);
        // The SQL keeps an open conversation: mirror the WHERE clause.
        if (/channel_id IS NULL OR stage < 4/.test(sql) && world.talking) return rows([]);
        world.matchState = 'archived';
        world.archivedMatches.push({ id: MATCH, by: params[1], via: params[2] });
        return rows([{ id: MATCH }]);
      }
      if (/UPDATE channel_messages SET expires_at = now\(\)/.test(sql)) {
        world.expiredMessagesFor.push(params[0]);
        return rows([]);
      }
      return rows([]);
    },
  } as any;
}

beforeEach(() => {
  world = {
    offers: [],
    matchState: 'open',
    talking: false,
    cardState: 'PUBLISHED',
    archivedMatches: [],
    expiredMessagesFor: [],
  };
  vi.spyOn(db, 'getPool').mockReturnValue(fakePool());
  vi.mocked(writeConsentEvent).mockClear();
});

/** The one introduction, as this agent's sweep hands it back. */
async function sweep(): Promise<any> {
  const r: any = await dispatchTool(cfg, ANA, 'check_in', {});
  expect(r.isError, JSON.stringify(r.content?.[0]?.text)).toBeUndefined();
  return r.structuredContent.introductions[0];
}

// ---------------------------------------------------------------------------
describe('the words that rode with a figure', () => {
  it('reads back the message text rather than the object holding it', async () => {
    world.offers = [
      offer({
        at: 1,
        proposer_account: BEPPE,
        amount: '415',
        message: { text: 'can collect Saturday', provenance: 'counterparty-untrusted' },
      }),
    ];
    const entry = await sweep();
    expect(entry.offer.message).toBe('can collect Saturday');
    expect(entry.offer_note.text).toContain('can collect Saturday');
    expect(JSON.stringify(entry)).not.toContain('[object Object]');
  });

  it('leaves a bare figure without invented words', async () => {
    world.offers = [offer({ at: 1, proposer_account: BEPPE, amount: '415' })];
    const entry = await sweep();
    expect(entry.offer.message).toBeNull();
    expect(entry.offers[0].message).toBeNull();
  });

  it('the helper handles every shape a message row has taken', () => {
    expect(offers.offerMessageText(null)).toBeNull();
    expect(offers.offerMessageText({ text: 'hello', provenance: 'x' })).toBe('hello');
    expect(offers.offerMessageText({ provenance: 'x' })).toBeNull();
    expect(offers.offerMessageText({ text: '   ' })).toBeNull();
    expect(offers.offerMessageText('an older row')).toBe('an older row');
  });
});

// ---------------------------------------------------------------------------
describe('both sides of the table', () => {
  it('shows the agent its own human\'s page-placed figure alongside the answer', async () => {
    world.offers = [
      offer({ at: 1, proposer_account: ANA, amount: '420', authored_by: 'human' }),
      offer({ at: 5, proposer_account: BEPPE, amount: '415', authored_by: 'human' }),
    ];
    const entry = await sweep();
    // Most recent first.
    expect(entry.offers.map((o: any) => o.amount)).toEqual([415, 420]);
    expect(entry.offers.map((o: any) => o.side)).toEqual(['theirs', 'yours']);
    expect(entry.offers[1]).toMatchObject({ side: 'yours', authored_by: 'human', ccy: 'AUD' });
    expect(entry.offer_note.text).toBe(
      'Your human offered 420 AUD on their approval page; the other side has answered with 415 AUD. Nothing is agreed until one of the two humans says yes on their own page.',
    );
  });

  it('says whose the figure is when only this human has one out', async () => {
    world.offers = [offer({ at: 1, proposer_account: ANA, amount: '420', authored_by: 'human' })];
    const entry = await sweep();
    expect(entry.offer_note.text).toContain("Your human's 420 AUD");
    expect(entry.offer_note.text).toContain('typed on their approval page');
    // Never described as something that never went out.
    expect(entry.offer_note.text).toContain('is on the table');
  });

  it('carries nothing at all when no figure has been sent', async () => {
    const entry = await sweep();
    expect(entry.offers).toBeUndefined();
    expect(entry.offer_note).toBeUndefined();
  });

  it('drops a withdrawn or declined figure off the table', async () => {
    world.offers = [
      offer({ at: 1, proposer_account: ANA, amount: '420', state: 'withdrawn' }),
      offer({ at: 2, proposer_account: BEPPE, amount: '300', state: 'declined' }),
    ];
    const entry = await sweep();
    expect(entry.offers).toBeUndefined();
  });

  it('keeps the machinery out of every sentence it writes', async () => {
    world.offers = [
      offer({ at: 1, proposer_account: ANA, amount: '420' }),
      offer({ at: 5, proposer_account: BEPPE, amount: '415' }),
    ];
    const entry = await sweep();
    for (const word of BANNED) {
      expect(entry.offer_note.text, word).not.toContain(word);
    }
    expect(entry.offer_note.provenance).toBe('switchboard-system');
  });
});

// ---------------------------------------------------------------------------
describe('when the other side takes the figure', () => {
  beforeEach(() => {
    world.offers = [
      offer({ at: 1, proposer_account: ANA, amount: '415', state: 'accepted-by-human' }),
    ];
  });

  it('the sweep says the deal is agreed, in a word and in a sentence', async () => {
    const entry = await sweep();
    expect(entry.next).toBe('deal_agreed');
    expect(entry.offer_note.text).toBe(
      "The other side has accepted your human's 415 AUD for the mountain bike you are after. The switchboard's part is done: agree pickup or handover in the conversation.",
    );
    // The entry leads with it, so the agent relaying the note says the deal.
    expect(entry.note).toEqual(entry.offer_note);
  });

  it('says it the other way round when this human was the one who accepted', async () => {
    world.offers = [
      offer({ at: 1, proposer_account: BEPPE, amount: '415', state: 'accepted-by-human' }),
    ];
    const entry = await sweep();
    // Agreed is agreed from both chairs: the accepting side's agent must not
    // read 'ready_to_talk' and tell its human the accept is still pending.
    expect(entry.next).toBe('deal_agreed');
    expect(entry.offer_note.text).toContain('Your human has accepted 415 AUD');
    expect(entry.offer_note.text).toContain("switchboard's part is done");
    expect(entry.note).toEqual(entry.offer_note);
  });

  it('promises no money movement, because settlements are a separate thing', async () => {
    const entry = await sweep();
    for (const word of ['paid', 'payment', 'transfer', 'held']) {
      expect(entry.offer_note.text, word).not.toContain(word);
    }
  });

  it('the manual tells an agent what deal_agreed means', () => {
    expect(SERVER_INSTRUCTIONS).toContain('deal_agreed');
    expect(SERVER_INSTRUCTIONS).toMatch(/switchboard's part is finished/i);
  });
});

// ---------------------------------------------------------------------------
describe('taking a listing down takes its introductions with it', () => {
  it('files away every open introduction on the listing, marked as withdrawn', async () => {
    const r = await cards.withdrawIntent(ANA, CARD_W);
    expect(r).toMatchObject({ state: 'WITHDRAWN', introductions_archived: 1 });
    expect(world.archivedMatches).toEqual([{ id: MATCH, by: ANA, via: 'withdrawn' }]);
  });

  it('records who filed each one and why, in the WORM log', async () => {
    await cards.withdrawIntent(ANA, CARD_W);
    const event: any = vi
      .mocked(writeConsentEvent)
      .mock.calls.map((c) => c[0] as any)
      .find((e) => e.event === 'match-archived');
    expect(event).toMatchObject({
      event: 'match-archived',
      match_id: MATCH,
      account_id: ANA,
      recorded_via: 'withdrawn',
    });
  });

  it('expires anything left uncollected, so the ordinary sweep clears it', async () => {
    await cards.withdrawIntent(ANA, CARD_W);
    expect(world.expiredMessagesFor).toEqual([[MATCH]]);
  });

  it('stops the introduction surfacing as something to act on', async () => {
    await cards.withdrawIntent(ANA, CARD_W);
    const entry = await sweep();
    expect(entry.state).toBe('archived');
    expect(entry.next).toBeUndefined();
    expect(entry.signal).toBeUndefined();
  });

  it('takes down a listing with nothing running on it without complaint', async () => {
    world.matchState = 'archived';
    const r = await cards.withdrawIntent(ANA, CARD_W);
    expect(r.introductions_archived).toBe(0);
    expect(world.expiredMessagesFor).toEqual([]);
  });

  it('leaves a conversation that is already open exactly as it was', async () => {
    world.talking = true;
    const r = await cards.withdrawIntent(ANA, CARD_W);
    expect(r).toMatchObject({ state: 'WITHDRAWN', introductions_archived: 0 });
    expect(world.archivedMatches).toEqual([]);
    expect(world.expiredMessagesFor).toEqual([]);
    expect(world.matchState).toBe('open');
  });

  it('is not a way to reach somebody else\'s listing', async () => {
    await expect(cards.withdrawIntent(BEPPE, CARD_W)).rejects.toMatchObject({ notFound: true });
    expect(world.archivedMatches).toEqual([]);
  });
});
