/**
 * The number an agent brought back from a Pass-on refusal.
 *
 * The gap this closes: a card on "Pass on" refuses respond(propose_offer)
 * outright, and until now the figure the agent was carrying died with the
 * refusal. Its human followed the link, met an empty box, and had to be told
 * the number a second time by the agent that had just been refused for it.
 *
 * What is asserted here:
 *  - the refusal is unchanged, and the figure it turned away is parked as a
 *    short-lived draft against that match and that account;
 *  - nothing about the draft reaches the counterparty, and no offer row exists;
 *  - the human's own offer box opens prefilled with it, under one line saying
 *    where it came from — on the match page, on the card's numbers page, and
 *    on the offer approval page's third door;
 *  - sending a figure clears the draft;
 *  - a draft past its TTL is treated as absent;
 *  - a figure never travels in a URL.
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

import { createHash } from 'node:crypto';
import { buildApp } from '../../src/app.js';
import * as db from '../../src/db.js';
import * as drafts from '../../src/domain/offerDrafts.js';
import * as offers from '../../src/domain/offers.js';
import * as cpages from '../../src/counter/pages.js';
import * as chome from '../../src/counter/pagesHome.js';
import { lintEmailCopy } from '../../src/email/lint.js';
import { OsbError } from '../../src/protocol.js';
import type { Config } from '../../src/config.js';
import type { FastifyInstance } from 'fastify';

const cfg = {
  envName: 'dev',
  port: 0,
  publicOrigin: 'https://mcp.test',
  counterOrigin: 'https://my.test',
  legacyCounterHosts: ['counter.test'],
  sesFrom: 'x',
  sesReplyTo: 'x',
  sesConfigurationSet: 'x',
  emailEventsQueueUrl: 'x',
  dbSecretArn: 'x',
  screeningQueueUrl: 'x',
  matchingQueueUrl: 'x',
  opsQueueUrl: 'x',
  consentLogBucket: 'x',
  identityKeyArn: 'x',
  bedrockModelId: 'x',
  registrationMode: 'dev-bootstrap',
  region: 'us-east-1',
  quotas: { maxOpenCards: 5, maxPublishesPerDay: 10, maxOffersPerHour: 6 },
  docsBase: 'https://openswitchboard.ai/docs',
  settlementFeePercent: 0,
} as unknown as Config;

const MATCH = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const ANA = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'; // the WANT side, signed in
const BEPPE = 'cccccccc-3333-4333-8333-cccccccccccc'; // the HAVE side
const CARD_W = 'dddddddd-4444-4444-8444-dddddddddddd';
const CARD_H = 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee';
const SID = 'osb_cs_testsessionvaluetestsessionvalue';
const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex');
const offerId = (n: number) => `0f0f0f0f-0000-4000-8000-${String(n).padStart(12, '0')}`;

interface DraftRow {
  account_id: string;
  match_id: string;
  amount: number;
  ccy: string;
  note: string | null;
  created_at: Date;
  expires_at: Date;
}

interface World {
  draftRows: DraftRow[];
  offers: any[];
  stage: number;
  matchState: 'open' | 'closed';
  mode: 'relay' | 'mandate';
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
  category: 'goods.bicycles.mountain-bike',
  stage: world.stage,
  interest_want: true,
  interest_have: true,
  state: world.matchState,
  channel_id: null,
  opened_at: null,
});

/** A pool that stores drafts for real, expiry included. */
function fakePool() {
  return {
    query: async (sql: string, params: any[] = []) => {
      const rows = (r: any[]) => ({ rows: r, rowCount: r.length });
      const live = () => world.draftRows.filter((d) => d.expires_at > new Date());

      // ---- offer_drafts ----
      if (/INSERT INTO offer_drafts/.test(sql)) {
        world.draftRows.push({
          account_id: params[0],
          match_id: params[1],
          amount: Number(params[2]),
          ccy: params[3],
          note: params[4],
          created_at: new Date(),
          expires_at: new Date(Date.now() + Number(params[5]) * 3_600_000),
        });
        return rows([]);
      }
      if (/FROM offer_drafts\s*$|FROM offer_drafts\b/.test(sql) && /^\s*SELECT amount, ccy, note/.test(sql)) {
        const found = live()
          .filter((d) => d.account_id === params[0] && d.match_id === params[1])
          .sort((a, b) => +b.created_at - +a.created_at);
        return rows(found.slice(0, 1));
      }
      if (/FROM offer_drafts d/.test(sql)) {
        const m = theMatch();
        const found = live()
          .filter(
            (d) =>
              d.account_id === params[0] &&
              d.match_id === m.id &&
              (m.card_want === params[1] || m.card_have === params[1]),
          )
          .sort((a, b) => +b.created_at - +a.created_at);
        return rows(found.slice(0, 1));
      }
      if (/DELETE FROM offer_drafts/.test(sql)) {
        world.draftRows = world.draftRows.filter(
          (d) => !(d.account_id === params[0] && d.match_id === params[1]),
        );
        return rows([]);
      }

      // ---- everything the offer path and the pages need ----
      if (/FROM counter_sessions/.test(sql) && /SELECT id, account_id/.test(sql)) {
        return params[0] === sha256hex(SID)
          ? rows([{ id: 'sess-1', account_id: ANA, pin_ok_until: null, oauth_ctx: null }])
          : rows([]);
      }
      if (/SELECT account_id, type, negotiation_mode, mandate_enc FROM cards/.test(sql)) {
        const own = params[0] === CARD_W;
        return rows([
          {
            account_id: own ? ANA : BEPPE,
            type: own ? 'WANT' : 'HAVE',
            negotiation_mode: world.mode,
            mandate_enc: null,
          },
        ]);
      }
      if (/^\s*SELECT \* FROM accounts WHERE id/.test(sql)) {
        return rows([
          { id: params[0], data_key_enc: Buffer.from('wrapped'), status: 'active', pin_hash: 'x' },
        ]);
      }
      if (/FROM matches m/.test(sql) && /negotiation_mode/.test(sql)) {
        const m = theMatch();
        return rows([
          {
            match_id: m.id,
            category: m.category,
            stage: m.stage,
            state: m.state,
            card_id: CARD_W,
            card_type: 'WANT',
            negotiation_mode: world.mode,
          },
        ]);
      }
      if (/FROM matches/.test(sql) && /^\s*SELECT (\*|m\.\*)/.test(sql)) return rows([theMatch()]);
      if (/SELECT count\(\*\)::int AS n FROM offers/.test(sql)) {
        return rows([{ n: world.offers.filter((o) => o.proposer_account === params[0]).length }]);
      }
      if (/SELECT count\(\*\)::int AS n,\s*min\(created_at\)/.test(sql)) {
        const mine = world.offers.filter(
          (o) => o.proposer_account === params[0] && o.match_id === params[1],
        );
        return rows([{ n: mine.length, oldest: mine[0]?.created_at ?? new Date() }]);
      }
      if (/SELECT amount FROM offers/.test(sql)) {
        return rows(
          world.offers
            .filter((o) => o.match_id === params[0] && o.proposer_account === params[1])
            .map((o) => ({ amount: String(o.amount) })),
        );
      }
      if (/SELECT id, amount, ccy, state, expiry, proposer_account, authored_by/.test(sql)) {
        return rows(world.offers.filter((o) => o.match_id === params[0]));
      }
      if (/INSERT INTO offers/.test(sql)) {
        const row = {
          id: offerId(++offerSeq),
          match_id: params[0],
          proposer_account: params[1],
          amount: params[2],
          ccy: params[3],
          expiry: new Date(params[4]),
          state: 'proposed',
          message: params[5] ? JSON.parse(params[5]) : null,
          authored_by: params[6],
          created_at: new Date(),
        };
        world.offers.push(row);
        return rows([row]);
      }
      if (/SELECT c\.\*/.test(sql) && /FROM cards c WHERE c\.account_id/.test(sql)) {
        return rows([
          {
            id: CARD_W,
            account_id: ANA,
            type: 'WANT',
            category: 'goods.bicycles.mountain-bike',
            lifecycle_state: 'PUBLISHED',
            protocol_status: 'active',
            attributes: {},
            ask: null,
            urgency: 'none',
            ttl_days: 60,
            expires_at: new Date('2026-12-01'),
            price_enc: null,
            match_count: 1,
            collect_window_minutes: null,
            screening: null,
            negotiation_mode: world.mode,
          },
        ]);
      }
      return rows([]);
    },
  } as any;
}

let app: FastifyInstance;

beforeEach(async () => {
  world = { draftRows: [], offers: [], stage: 2, matchState: 'open', mode: 'relay' };
  offerSeq = 0;
  vi.spyOn(db, 'getPool').mockReturnValue(fakePool());
  if (!app) {
    app = buildApp(cfg);
    await app.ready();
  }
});

const agentOffer = (amount: number, message?: string) =>
  offers.proposeOffer(cfg, ANA, {
    match_id: MATCH,
    amount,
    ccy: 'AUD',
    expiry: new Date(Date.now() + 86_400_000).toISOString(),
    ...(message ? { message } : {}),
  });

const inject = (method: 'GET' | 'POST', url: string, body?: Record<string, string>) =>
  app.inject({
    method,
    url,
    headers: {
      host: 'my.test',
      cookie: `osb_counter=${SID}`,
      ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
    },
    ...(body ? { payload: new URLSearchParams(body).toString() } : {}),
  });

// ---------------------------------------------------------------------------
describe('a refused figure is kept for the human it belongs to', () => {
  it('the Pass-on refusal stands, and the figure it turned away is parked', async () => {
    await expect(agentOffer(505, 'Cash, and I can collect this weekend.')).rejects.toBeInstanceOf(
      OsbError,
    );
    // Nothing was published: the refusal still lands before any offer row.
    expect(world.offers).toHaveLength(0);
    expect(world.draftRows).toHaveLength(1);
    expect(world.draftRows[0]).toMatchObject({
      account_id: ANA,
      match_id: MATCH,
      amount: 505,
      ccy: 'AUD',
      note: 'Cash, and I can collect this weekend.',
    });
    const live = await drafts.newestOfferDraft(ANA, MATCH);
    expect(live).toMatchObject({ amount: 505, ccy: 'AUD' });
  });

  it('a card on Auto-negotiate parks nothing: its agent may send the figure itself', async () => {
    world.mode = 'mandate';
    // No numbers written, so this is still refused — and no draft is kept,
    // because the refusal is about the empty box rather than about consent to
    // the figure.
    await expect(agentOffer(505)).rejects.toBeInstanceOf(OsbError);
    expect(world.draftRows).toHaveLength(0);
  });

  it('the newest of several is the one that is kept', async () => {
    await expect(agentOffer(500)).rejects.toBeInstanceOf(OsbError);
    await new Promise((r) => setTimeout(r, 2));
    await expect(agentOffer(520)).rejects.toBeInstanceOf(OsbError);
    expect((await drafts.newestOfferDraft(ANA, MATCH))?.amount).toBe(520);
  });

  it('a draft past its day is treated as absent', async () => {
    await expect(agentOffer(505)).rejects.toBeInstanceOf(OsbError);
    expect(await drafts.newestOfferDraft(ANA, MATCH)).toBeTruthy();
    // Age it out the way the clock would.
    world.draftRows[0].expires_at = new Date(Date.now() - 1000);
    expect(await drafts.newestOfferDraft(ANA, MATCH)).toBeUndefined();
    expect(await drafts.newestOfferDraftForCard(ANA, CARD_W)).toBeUndefined();
    const page = await inject('GET', `/matches/${MATCH}`);
    expect(page.body).not.toContain(cpages.DRAFT_LINE);
    expect(page.body).not.toContain('505');
  });

  it('the TTL is a day, and the statement itself refuses a stale row', () => {
    expect(drafts.OFFER_DRAFT_TTL_HOURS).toBe(24);
  });

  it('a figure that is not money is dropped rather than stored', async () => {
    await drafts.saveOfferDraft(ANA, MATCH, { amount: 0, ccy: 'AUD' });
    await drafts.saveOfferDraft(ANA, MATCH, { amount: Number.NaN, ccy: 'AUD' });
    await drafts.saveOfferDraft(ANA, MATCH, { amount: 100, ccy: 'AU' });
    expect(world.draftRows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe('the box opens on the number the agent carried', () => {
  it('the match page prefills it, and says where it came from', async () => {
    await expect(agentOffer(505, 'Cash, and I can collect this weekend.')).rejects.toBeInstanceOf(
      OsbError,
    );
    const res = await inject('GET', `/matches/${MATCH}`);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(cpages.DRAFT_LINE);
    expect(res.body).toContain('id="amount" name="amount" type="number" step="0.01" min="0" required value="505"');
    expect(res.body).toContain('name="note" type="text" maxlength="200" value="Cash, and I can collect this weekend."');
    // The figure is read back by match id: it is in no URL on the page.
    expect(res.body).not.toMatch(/(href|action)="[^"]*505/);
  });

  it('the card\'s own numbers page carries it too, pointed at the match', async () => {
    await expect(agentOffer(505)).rejects.toBeInstanceOf(OsbError);
    const res = await inject('GET', `/ledger/${CARD_W}/numbers`);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(cpages.DRAFT_LINE);
    expect(res.body).toContain('505 AUD');
    expect(res.body).toContain(`href="/matches/${MATCH}"`);
    expect(res.body).not.toMatch(/href="[^"]*505/);
  });

  it('sending a figure clears it', async () => {
    await expect(agentOffer(505)).rejects.toBeInstanceOf(OsbError);
    expect(world.draftRows).toHaveLength(1);
    const sent = await inject('POST', `/matches/${MATCH}/offer`, {
      amount: '505',
      ccy: 'AUD',
      good_for: '7',
    });
    expect(sent.statusCode).toBe(200);
    expect(world.offers).toHaveLength(1);
    expect(world.draftRows).toHaveLength(0);
    expect(sent.body).not.toContain(cpages.DRAFT_LINE);
  });

  it('a rejected submission keeps what the person typed over what the agent left', async () => {
    await expect(agentOffer(505)).rejects.toBeInstanceOf(OsbError);
    const bad = await inject('POST', `/matches/${MATCH}/offer`, { amount: '600', ccy: 'AU' });
    expect(bad.statusCode).toBe(400);
    expect(bad.body).toContain('value="600"');
    expect(bad.body).not.toContain(cpages.DRAFT_LINE);
    // The draft is still there for next time: nothing was sent.
    expect(world.draftRows).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
describe('the pages that show a carried figure', () => {
  const withDraft = {
    matchId: MATCH,
    cardId: CARD_W,
    category: 'Mountain bikes',
    type: 'WANT' as const,
    mode: 'relay' as const,
    canOffer: true,
    offers: [],
    draft: { amount: '505', ccy: 'AUD', note: 'Cash this weekend.' },
  };

  it('the line is the agreed one, and it passes the banned-phrase lint', () => {
    expect(cpages.DRAFT_LINE).toBe('Your agent brought this number from you — check it and send.');
    for (const html of [
      chome.matchOffersPage(withDraft),
      chome.cardNumbersPage({
        id: CARD_W,
        type: 'WANT',
        category: 'Mountain bikes',
        mode: 'relay',
        draft: { matchId: MATCH, amount: '505', ccy: 'AUD' },
      }),
      cpages.approvalPage({
        action: 'offer-accept',
        refId: offerId(1),
        facts: [{ k: 'You are agreeing to', v: '400 AUD' }],
        anomalies: [],
        hasPasskey: false,
        elevated: false,
        postPath: '/approve',
        counterOffer: { matchId: MATCH, ccy: 'AUD' },
        draft: { amount: '505', ccy: 'AUD' },
      }),
    ]) {
      expect(html).toContain(cpages.DRAFT_LINE);
      expect(lintEmailCopy(html)).toEqual([]);
    }
  });

  it('the offer approval page opens its third door on the carried figure', () => {
    const html = cpages.approvalPage({
      action: 'offer-accept',
      refId: offerId(1),
      facts: [{ k: 'You are agreeing to', v: '400 AUD' }],
      anomalies: [],
      hasPasskey: false,
      elevated: false,
      postPath: '/approve',
      counterOffer: { matchId: MATCH, ccy: 'AUD' },
      draft: { amount: '505', ccy: 'AUD' },
    });
    // Folded away when there is nothing carried; open when there is.
    expect(html).toContain('<details class="more" open>');
    expect(html).toContain('value="505"');
    const bare = cpages.approvalPage({
      action: 'offer-accept',
      refId: offerId(1),
      facts: [{ k: 'You are agreeing to', v: '400 AUD' }],
      anomalies: [],
      hasPasskey: false,
      elevated: false,
      postPath: '/approve',
      counterOffer: { matchId: MATCH, ccy: 'AUD' },
    });
    expect(bare).not.toContain('<details class="more" open>');
    expect(bare).not.toContain(cpages.DRAFT_LINE);
  });
});
