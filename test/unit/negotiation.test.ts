/**
 * Who authors the numbers.
 *
 * The defect this suite exists to hold shut: an agent could invent a figure and
 * haggle with another agent, and the only thing waiting for a human was the
 * final acceptance. By then the price had already been argued out by two
 * machines on behalf of two people who never said a number. The agent is the
 * estate agent — it presents and it advises — and the figures belong to its
 * human.
 *
 * The rules asserted here:
 *  - every card is on "Pass on" unless its human said otherwise, and on a card
 *    set that way respond(propose_offer) is REFUSED with CONSENT_REQUIRED and
 *    that human's own link, before any offer row exists;
 *  - the human's own page is where their side's figure comes from, through the
 *    ordinary offer machinery — validated, rate-limited, and with anything
 *    shaped like a way to reach someone turned away;
 *  - "Auto-negotiate" is a per-card switch only a human can throw, and inside
 *    it the server enforces the opening figure, the limit and the step;
 *  - the numbers a human wrote never appear in anything a counterparty can
 *    read, in the same way and for the same reason as the private price band;
 *  - the operating manual says all of this in the first person.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/crypto.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  // A stand-in envelope: 'enc:' + plaintext. The real AES-GCM path is proved
  // against live KMS in the integration suite.
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
import { writeConsentEvent } from '../../src/crypto.js';
import * as db from '../../src/db.js';
import * as neg from '../../src/domain/negotiation.js';
import * as offers from '../../src/domain/offers.js';
import * as chome from '../../src/counter/pagesHome.js';
import * as cpages from '../../src/counter/pages.js';
import { COUNTER_ROUTE_TABLE } from '../../src/counter/routes.js';
import { TOOLS, dispatchTool } from '../../src/mcp/tools.js';
import { SERVER_INSTRUCTIONS } from '../../src/mcp/instructions.js';
import { OsbError } from '../../src/protocol.js';
import type { Config } from '../../src/config.js';
import type { FastifyInstance } from 'fastify';

const cfg: Config = {
  envName: 'dev',
  port: 0,
  publicOrigin: 'https://mcp.test',
  counterOrigin: 'https://counter.test',
  sesFrom: 'OpenSwitchboard <board@openswitchboard.ai>',
  sesReplyTo: 'info@openswitchboard.ai',
  sesConfigurationSet: 'unused',
  emailEventsQueueUrl: 'http://unused',
  dbSecretArn: 'unused',
  screeningQueueUrl: 'http://unused',
  matchingQueueUrl: 'http://unused',
  opsQueueUrl: 'http://unused',
  consentLogBucket: 'unused',
  identityKeyArn: 'unused',
  bedrockModelId: 'unused',
  registrationMode: 'dev-bootstrap',
  region: 'us-east-1',
  quotas: { maxOpenCards: 5, maxPublishesPerDay: 10, maxOffersPerHour: 6 },
  docsBase: 'https://openswitchboard.ai/docs',
  settlementFeePercent: 0,
} as unknown as Config;

const MATCH = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const ANA = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'; // the WANT side
const BEPPE = 'cccccccc-3333-4333-8333-cccccccccccc'; // the HAVE side
const CARD_W = 'dddddddd-4444-4444-8444-dddddddddddd';
const CARD_H = 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee';
const SID = 'osb_cs_testsessionvaluetestsessionvalue';
const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex');
/** Offer ids have to be real UUIDs: serializeOffer validates outbound. */
const offerId = (n: number) => `0f0f0f0f-0000-4000-8000-${String(n).padStart(12, '0')}`;

// Deliberately odd figures: anything that leaks them is unmistakable.
const HAVE_MANDATE: neg.Mandate = { open: 7654.25, limit: 4321.5, step: 137.75, ccy: 'AUD' };

interface CardState {
  id: string;
  account_id: string;
  type: 'WANT' | 'HAVE';
  negotiation_mode: 'relay' | 'mandate';
  mandate_enc: Buffer | null;
}

interface OfferState {
  id: string;
  match_id: string;
  proposer_account: string;
  amount: number;
  ccy: string;
  expiry: Date;
  state: string;
  message: any;
  authored_by: 'human' | 'agent';
  created_at: Date;
}

interface World {
  cards: Record<string, CardState>;
  offers: OfferState[];
  stage: number;
  matchState: 'open' | 'declined' | 'closed';
  writes: { sql: string; params: any[] }[];
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

function fakePool() {
  return {
    query: async (sql: string, params: any[] = []) => {
      const rows = (r: any[]) => ({ rows: r, rowCount: r.length });

      if (/FROM counter_sessions/.test(sql) && /SELECT id, account_id/.test(sql)) {
        return params[0] === sha256hex(SID)
          ? rows([{ id: 'sess-1', account_id: ANA, pin_ok_until: null, oauth_ctx: null }])
          : rows([]);
      }
      if (/SELECT account_id, type, negotiation_mode, mandate_enc FROM cards/.test(sql)) {
        const c = world.cards[params[0]];
        return c ? rows([c]) : rows([]);
      }
      if (/^\s*SELECT \* FROM accounts WHERE id/.test(sql)) {
        return rows([
          { id: params[0], data_key_enc: Buffer.from('wrapped'), status: 'active', pin_hash: 'x' },
        ]);
      }
      if (/UPDATE cards SET negotiation_mode/.test(sql)) {
        const c = world.cards[params[0]];
        if (!c || c.account_id !== params[1]) return rows([]);
        c.negotiation_mode = params[2];
        if (params.length > 3) c.mandate_enc = params[3];
        world.writes.push({ sql, params });
        return rows([{ id: c.id }]);
      }
      if (/FROM matches m/.test(sql) && /negotiation_mode/.test(sql)) {
        const m = theMatch();
        const card = world.cards[params[0] === ANA ? CARD_W : CARD_H];
        return rows([
          {
            match_id: m.id,
            category: m.category,
            stage: m.stage,
            state: m.state,
            card_id: card.id,
            card_type: card.type,
            negotiation_mode: card.negotiation_mode,
          },
        ]);
      }
      if (/FROM matches/.test(sql) && /^\s*SELECT (\*|m\.\*)/.test(sql)) return rows([theMatch()]);
      if (/FROM cards c/.test(sql) && /collect_until/.test(sql)) return rows([]);

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
      if (/^\s*SELECT \* FROM offers WHERE match_id/.test(sql)) {
        return rows(world.offers.filter((o) => o.match_id === params[0]));
      }
      if (/INSERT INTO offers/.test(sql)) {
        const row: OfferState = {
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
      if (/UPDATE reputation/.test(sql)) return rows([]);
      if (/SELECT c\.\*/.test(sql) && /FROM cards c WHERE c\.account_id/.test(sql)) {
        return rows(
          Object.values(world.cards)
            .filter((c) => c.account_id === params[0])
            .map((c) => ({
              ...c,
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
            })),
        );
      }
      world.writes.push({ sql, params });
      return rows([]);
    },
  } as any;
}

let app: FastifyInstance;

beforeEach(async () => {
  world = {
    cards: {
      [CARD_W]: { id: CARD_W, account_id: ANA, type: 'WANT', negotiation_mode: 'relay', mandate_enc: null },
      [CARD_H]: { id: CARD_H, account_id: BEPPE, type: 'HAVE', negotiation_mode: 'relay', mandate_enc: null },
    },
    offers: [],
    stage: 2,
    matchState: 'open',
    writes: [],
  };
  offerSeq = 0;
  vi.spyOn(db, 'getPool').mockReturnValue(fakePool());
  vi.mocked(writeConsentEvent).mockClear();
  if (!app) {
    app = buildApp(cfg);
    await app.ready();
  }
});

const inMandate = (mandate: neg.Mandate = HAVE_MANDATE) => {
  world.cards[CARD_H].negotiation_mode = 'mandate';
  world.cards[CARD_H].mandate_enc = Buffer.from(`enc:${JSON.stringify(mandate)}`);
};

const anOffer = (amount: number, extra: Partial<{ ccy: string; message: string }> = {}) => ({
  match_id: MATCH,
  amount,
  ccy: extra.ccy ?? 'AUD',
  expiry: new Date(Date.now() + 86_400_000).toISOString(),
  ...(extra.message ? { message: extra.message } : {}),
});

// ---------------------------------------------------------------------------
describe('the numbers a human writes down', () => {
  it('a HAVE opens high and walks down to its limit; the other order is refused', () => {
    const ok = neg.validateMandate({ open: '7654.25', limit: '4321.50', step: '137.75', ccy: 'aud' }, 'HAVE');
    expect(ok).toEqual({ ok: true, value: HAVE_MANDATE });
    const wrong = neg.validateMandate({ open: 100, limit: 400, ccy: 'AUD' }, 'HAVE');
    expect(wrong.ok).toBe(false);
    expect((wrong as any).error).toMatch(/least you will take/);
  });

  it('a WANT opens low and walks up to its limit; the other order is refused', () => {
    const ok = neg.validateMandate({ open: 300, limit: 400, ccy: 'AUD' }, 'WANT');
    expect(ok).toEqual({ ok: true, value: { open: 300, limit: 400, ccy: 'AUD' } });
    const wrong = neg.validateMandate({ open: 900, limit: 400, ccy: 'AUD' }, 'WANT');
    expect(wrong.ok).toBe(false);
    expect((wrong as any).error).toMatch(/most you will pay/);
  });

  it('a limit and a currency are the least of it', () => {
    expect(neg.validateMandate({ limit: 400 }, 'WANT').ok).toBe(false);
    expect(neg.validateMandate({ ccy: 'AUD' }, 'WANT').ok).toBe(false);
    expect(neg.validateMandate({ limit: 0, ccy: 'AUD' }, 'WANT').ok).toBe(false);
    expect(neg.validateMandate({ limit: -5, ccy: 'AUD' }, 'WANT').ok).toBe(false);
    expect(neg.validateMandate({ limit: 'lots', ccy: 'AUD' }, 'WANT').ok).toBe(false);
    expect(neg.validateMandate({ limit: 400, ccy: 'AUD' }, 'WANT')).toEqual({
      ok: true,
      value: { limit: 400, ccy: 'AUD' },
    });
  });

  it('a step bigger than the whole distance is refused, and so is a stray field', () => {
    const big = neg.validateMandate({ open: 300, limit: 400, step: 500, ccy: 'AUD' }, 'WANT');
    expect(big.ok).toBe(false);
    const stray = neg.validateMandate({ limit: 400, ccy: 'AUD', autopilot: true }, 'WANT');
    expect(stray.ok).toBe(false);
    expect((stray as any).error).toMatch(/autopilot/);
  });

  it('says the numbers back to their owner in their own words', () => {
    expect(neg.mandateInPlainWords(HAVE_MANDATE, 'HAVE')).toEqual([
      { k: 'Open at', v: '7654.25 AUD' },
      { k: 'Take no less than', v: '4321.5 AUD' },
      { k: 'Move in steps of at least', v: '137.75 AUD' },
    ]);
    expect(neg.mandateInPlainWords({ limit: 400, ccy: 'AUD' }, 'WANT')[0].k).toBe('Pay no more than');
  });
});

// ---------------------------------------------------------------------------
describe('the box, and its edges', () => {
  const check = (amount: number, prior: number[] = [], ccy = 'AUD') =>
    neg.checkAgainstMandate(HAVE_MANDATE, 'HAVE', {
      amount,
      ccy,
      priorAmounts: prior,
      isOpening: prior.length === 0,
    });

  it('opens exactly where the human said to open', () => {
    expect(check(7654.25)).toEqual({ ok: true });
    const early = check(6000);
    expect(early.ok).toBe(false);
    expect((early as any).reason).toContain('7654.25');
  });

  it('will not go under the limit, and names it', () => {
    const under = check(4000, [7654.25]);
    expect(under.ok).toBe(false);
    expect((under as any).reason).toContain('4321.5');
  });

  it('will not go above the opening figure', () => {
    const over = check(9000, [7654.25]);
    expect(over.ok).toBe(false);
    expect((over as any).reason).toContain('7654.25');
  });

  it('honours the step: big enough, and pointed at the limit', () => {
    expect(check(7000, [7654.25])).toEqual({ ok: true }); // 654.25 down
    const tiny = check(7600, [7654.25]);
    expect(tiny.ok).toBe(false);
    expect((tiny as any).reason).toContain('137.75');
    const backwards = check(7500, [7000]);
    expect(backwards.ok).toBe(false);
    expect((backwards as any).reason).toMatch(/come down/);
    const standstill = check(7000, [7000]);
    expect(standstill.ok).toBe(false);
  });

  it('a WANT walks the other way, and stops at its ceiling', () => {
    const m: neg.Mandate = { open: 300, limit: 400, step: 25, ccy: 'AUD' };
    const c = (amount: number, prior: number[] = []) =>
      neg.checkAgainstMandate(m, 'WANT', {
        amount,
        ccy: 'AUD',
        priorAmounts: prior,
        isOpening: prior.length === 0,
      });
    expect(c(300)).toEqual({ ok: true });
    expect(c(350, [300])).toEqual({ ok: true });
    expect(c(450, [300]).ok).toBe(false);
    expect(c(280, [300]).ok).toBe(false); // back down is not a move it may make
  });

  it('a figure in the wrong money is outside the box whatever its size', () => {
    const wrong = check(5000, [7654.25], 'EUR');
    expect(wrong.ok).toBe(false);
    expect((wrong as any).reason).toContain('AUD');
  });
});

// ---------------------------------------------------------------------------
describe('Pass on: an agent may not author a figure at all', () => {
  it('propose_offer is refused with the human\'s own link, and writes nothing', async () => {
    await expect(offers.proposeOffer(cfg, BEPPE, anOffer(5000))).rejects.toBeInstanceOf(OsbError);
    try {
      await offers.proposeOffer(cfg, BEPPE, anOffer(5000));
    } catch (e: any) {
      expect(e.payload.code).toBe('CONSENT_REQUIRED');
      expect(e.payload.human_action).toContain('Your numbers come from you');
      expect(e.payload.human_action).toContain(`https://counter.test/counter/matches/${MATCH}`);
      expect(e.payload.human_action.length).toBeLessThanOrEqual(300);
    }
    expect(world.offers).toHaveLength(0);
  });

  it('the refusal reaches the agent through the tool surface as a protocol error', async () => {
    const r = await dispatchTool(cfg, BEPPE, 'respond', {
      match_id: MATCH,
      action: 'propose_offer',
      offer: { amount: 5000, ccy: 'AUD', expiry: new Date(Date.now() + 86_400_000).toISOString() },
    });
    expect(r.isError).toBe(true);
    expect((r.structuredContent as any).code).toBe('CONSENT_REQUIRED');
    expect(world.offers).toHaveLength(0);
  });

  it('a card is on Pass on until its human says otherwise', async () => {
    expect(await neg.readNegotiationMode(BEPPE, CARD_H)).toBe('relay');
    const read = await neg.readNegotiation(BEPPE, CARD_H, { purpose: 'test' });
    expect(read).toEqual({ mode: 'relay', cardType: 'HAVE' });
  });

  it('the figure the human types goes out through the ordinary machinery', async () => {
    const sent = await offers.proposeOffer(
      cfg,
      BEPPE,
      anOffer(5000, { message: 'Cash on pickup this Saturday.' }),
      { author: 'human' },
    );
    expect(sent.state).toBe('proposed');
    expect(sent.amount).toBe(5000);
    expect(world.offers[0].authored_by).toBe('human');
    expect(world.offers[0].message.provenance).toBe('counterparty-untrusted');
  });

  it('a human figure still meets the stage gate and the per-match rate rail', async () => {
    world.stage = 1;
    await expect(
      offers.proposeOffer(cfg, BEPPE, anOffer(5000), { author: 'human' }),
    ).rejects.toMatchObject({ payload: { code: 'STAGE_LOCKED' } });
    world.stage = 2;
    for (let i = 0; i < 3; i++) {
      await offers.proposeOffer(cfg, BEPPE, anOffer(5000 + i), { author: 'human' });
    }
    await expect(
      offers.proposeOffer(cfg, BEPPE, anOffer(5100), { author: 'human' }),
    ).rejects.toMatchObject({ payload: { code: 'RATE_LIMITED_OFFERS' } });
  });
});

// ---------------------------------------------------------------------------
describe('Auto-negotiate: inside the box and nowhere else', () => {
  it('an in-range opening offer goes out, marked as the agent\'s own move', async () => {
    inMandate();
    const sent = await offers.proposeOffer(cfg, BEPPE, anOffer(7654.25));
    expect(sent.amount).toBe(7654.25);
    expect(world.offers[0].authored_by).toBe('agent');
  });

  it('an out-of-range offer is refused, and the refusal names the edge', async () => {
    inMandate();
    world.offers.push({
      id: offerId(99),
      match_id: MATCH,
      proposer_account: BEPPE,
      amount: 7654.25,
      ccy: 'AUD',
      expiry: new Date(Date.now() + 86_400_000),
      state: 'proposed',
      message: null,
      authored_by: 'agent',
      created_at: new Date(),
    });
    try {
      await offers.proposeOffer(cfg, BEPPE, anOffer(3000));
      throw new Error('should have refused');
    } catch (e: any) {
      expect(e.payload.code).toBe('CONSENT_REQUIRED');
      expect(e.payload.human_action).toContain('4321.5');
      expect(e.payload.human_action).toContain(`/counter/ledger/${CARD_H}/numbers`);
    }
    expect(world.offers).toHaveLength(1); // the seed only
  });

  it('the switch thrown with no numbers behind it refuses and points at the page', async () => {
    world.cards[CARD_H].negotiation_mode = 'mandate';
    try {
      await offers.proposeOffer(cfg, BEPPE, anOffer(5000));
      throw new Error('should have refused');
    } catch (e: any) {
      expect(e.payload.code).toBe('CONSENT_REQUIRED');
      expect(e.payload.human_action).toContain('Auto-negotiate');
      expect(e.payload.human_action).toContain(`/counter/ledger/${CARD_H}/numbers`);
    }
  });

  it('a human figure outside their own box still goes: they wrote it just now', async () => {
    inMandate();
    const sent = await offers.proposeOffer(cfg, BEPPE, anOffer(3000), { author: 'human' });
    expect(sent.amount).toBe(3000);
    expect(world.offers[0].authored_by).toBe('human');
  });

  it('saving the numbers records the change without recording the numbers', async () => {
    await neg.saveNegotiation(BEPPE, CARD_H, { mode: 'mandate', mandate: HAVE_MANDATE }, 'counter');
    expect(world.cards[CARD_H].negotiation_mode).toBe('mandate');
    const event = vi.mocked(writeConsentEvent).mock.calls[0][0] as any;
    expect(event.event).toBe('negotiation-mode-set');
    expect(event.mandate_fields).toEqual(['ccy', 'limit', 'open', 'step']);
    expect(JSON.stringify(event)).not.toContain('4321.5');
    expect(JSON.stringify(event)).not.toContain('7654.25');
    // Read back through the envelope, and usable again.
    expect((await neg.readNegotiation(BEPPE, CARD_H, { purpose: 'test' })).mandate).toEqual(
      HAVE_MANDATE,
    );
  });

  it('numbers survive a spell back on Pass on, and clearing takes them away', async () => {
    await neg.saveNegotiation(BEPPE, CARD_H, { mode: 'mandate', mandate: HAVE_MANDATE }, 'counter');
    await neg.saveNegotiation(BEPPE, CARD_H, { mode: 'relay' }, 'counter');
    const parked = await neg.readNegotiation(BEPPE, CARD_H, { purpose: 'test' });
    expect(parked.mode).toBe('relay');
    expect(parked.mandate).toEqual(HAVE_MANDATE);
    await expect(offers.proposeOffer(cfg, BEPPE, anOffer(7654.25))).rejects.toMatchObject({
      payload: { code: 'CONSENT_REQUIRED' },
    });
    await neg.saveNegotiation(BEPPE, CARD_H, { mode: 'relay', mandate: null }, 'counter');
    expect((await neg.readNegotiation(BEPPE, CARD_H, { purpose: 'test' })).mandate).toBeUndefined();
  });

  it('a card belonging to someone else is not there to read or write', async () => {
    await expect(neg.readNegotiationMode(ANA, CARD_H)).rejects.toMatchObject({ notFound: true });
    await expect(
      neg.saveNegotiation(ANA, CARD_H, { mode: 'mandate', mandate: HAVE_MANDATE }, 'counter'),
    ).rejects.toMatchObject({ notFound: true });
  });
});

// ---------------------------------------------------------------------------
// The same class of assertion as the price-band no-leak gates: the figures a
// human wrote are theirs, and nothing a counterparty can obtain carries them.
// ---------------------------------------------------------------------------
describe('a mandate never crosses to the other side', () => {
  const SECRETS = ['7654.25', '4321.5', '137.75', 'mandate', 'negotiation_mode', 'authored_by'];

  it('is absent from every payload the counterparty can fetch', async () => {
    inMandate();
    await offers.proposeOffer(cfg, BEPPE, anOffer(7654.25));
    const serialized = JSON.stringify(await offers.listOffers(ANA, MATCH));
    // The one figure that IS deliberate — the offer itself — is there, and
    // everything else the human wrote is not.
    expect(serialized).toContain('7654.25');
    for (const s of SECRETS.slice(1)) {
      expect(serialized, `counterparty payload leaked '${s}'`).not.toContain(s);
    }
    const tool = await dispatchTool(cfg, ANA, 'respond', { match_id: MATCH, action: 'list_offers' });
    const raw = JSON.stringify(tool);
    for (const s of SECRETS.slice(1)) {
      expect(raw, `list_offers leaked '${s}'`).not.toContain(s);
    }
    const cards = await dispatchTool(cfg, BEPPE, 'list_intents', {});
    for (const s of SECRETS) {
      expect(JSON.stringify(cards), `list_intents leaked '${s}'`).not.toContain(s);
    }
  });

  it('the refusal that names the boundary goes to its own agent only', async () => {
    inMandate();
    let refusal = '';
    try {
      await offers.proposeOffer(cfg, BEPPE, anOffer(100));
    } catch (e: any) {
      refusal = JSON.stringify(e.payload);
    }
    expect(refusal).toContain('4321.5'); // the owner's agent is told the edge
    const theirs = JSON.stringify(await offers.listOffers(ANA, MATCH));
    expect(theirs).not.toContain('4321.5');
  });
});

// ---------------------------------------------------------------------------
describe('the human page class owns both settings', () => {
  const inject = (method: 'GET' | 'POST', url: string, body?: Record<string, string>, cookie = true) =>
    app.inject({
      method,
      url,
      headers: {
        host: 'counter.test',
        ...(cookie ? { cookie: `osb_counter=${SID}` } : {}),
        ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      },
      ...(body ? { payload: new URLSearchParams(body).toString() } : {}),
    });

  it('the routes are in the enumerated human-only class', () => {
    const urls = COUNTER_ROUTE_TABLE.map((r) => `${r.method} ${r.url}`);
    for (const must of [
      'GET /counter/ledger/:id/numbers',
      'POST /counter/ledger/:id/numbers',
      'POST /counter/ledger/:id/numbers/clear',
      'GET /counter/matches/:id',
      'POST /counter/matches/:id/offer',
    ]) {
      expect(urls, `missing route ${must}`).toContain(must);
    }
  });

  it('an agent bearer token is turned away from every one of them', async () => {
    for (const [method, url] of [
      ['GET', `/counter/ledger/${CARD_W}/numbers`],
      ['POST', `/counter/ledger/${CARD_W}/numbers`],
      ['POST', `/counter/ledger/${CARD_W}/numbers/clear`],
      ['GET', `/counter/matches/${MATCH}`],
      ['POST', `/counter/matches/${MATCH}/offer`],
    ] as const) {
      const res = await app.inject({
        method: method as any,
        url,
        headers: { host: 'counter.test', authorization: 'Bearer whatever' },
      });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      expect(res.json().error).toBe('agent_credentials_rejected');
    }
  });

  it('a caller with no session gets nowhere', async () => {
    const res = await inject('POST', `/counter/matches/${MATCH}/offer`, { amount: '400', ccy: 'AUD' }, false);
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('not_signed_in');
  });

  it('a signed-in human sends their number, and it lands as their side\'s offer', async () => {
    const res = await inject('POST', `/counter/matches/${MATCH}/offer`, {
      amount: '412.50',
      ccy: 'aud',
      note: 'Can collect Saturday morning.',
      good_for: '7',
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Sent. Your number is on the table');
    expect(world.offers).toHaveLength(1);
    expect(world.offers[0]).toMatchObject({
      proposer_account: ANA,
      amount: 412.5,
      ccy: 'AUD',
      authored_by: 'human',
    });
    expect(world.offers[0].message.text).toBe('Can collect Saturday morning.');
  });

  it('turns away a figure that is not one, and a note shaped like a way to reach someone', async () => {
    for (const body of [
      { amount: '0', ccy: 'AUD' },
      { amount: 'four hundred', ccy: 'AUD' },
      { amount: '400.005', ccy: 'AUD' },
      { amount: '400', ccy: 'AU' },
    ]) {
      const res = await inject('POST', `/counter/matches/${MATCH}/offer`, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
    }
    for (const note of [
      'text me on 0412 345 678',
      'ana@example.com',
      'see www.example.com for photos',
      'x'.repeat(neg.MANDATE_NOTE_MAX + 1),
    ]) {
      const res = await inject('POST', `/counter/matches/${MATCH}/offer`, {
        amount: '400',
        ccy: 'AUD',
        note,
      });
      expect(res.statusCode, note).toBe(400);
    }
    expect(world.offers).toHaveLength(0);
  });

  it('the per-match rail is shown to the human rather than swallowed', async () => {
    for (let i = 0; i < 3; i++) {
      await inject('POST', `/counter/matches/${MATCH}/offer`, { amount: String(400 + i), ccy: 'AUD' });
    }
    const res = await inject('POST', `/counter/matches/${MATCH}/offer`, { amount: '500', ccy: 'AUD' });
    expect(res.statusCode).toBe(429);
    expect(world.offers).toHaveLength(3);
  });

  it('switching to Auto-negotiate with no numbers is refused; with them it saves', async () => {
    const bare = await inject('POST', `/counter/ledger/${CARD_W}/numbers`, { mode: 'mandate' });
    expect(bare.statusCode).toBe(400);
    expect(bare.body).toContain('Auto-negotiate needs your numbers');
    expect(world.cards[CARD_W].negotiation_mode).toBe('relay');

    const wrongWay = await inject('POST', `/counter/ledger/${CARD_W}/numbers`, {
      mode: 'mandate',
      open: '900',
      limit: '400',
      ccy: 'AUD',
    });
    expect(wrongWay.statusCode).toBe(400);
    expect(world.cards[CARD_W].negotiation_mode).toBe('relay');

    const good = await inject('POST', `/counter/ledger/${CARD_W}/numbers`, {
      mode: 'mandate',
      open: '300',
      limit: '400',
      step: '25',
      ccy: 'AUD',
    });
    expect(good.statusCode).toBe(200);
    expect(good.body).toContain('Auto-negotiate');
    expect(world.cards[CARD_W].negotiation_mode).toBe('mandate');

    const cleared = await inject('POST', `/counter/ledger/${CARD_W}/numbers/clear`, {});
    expect(cleared.statusCode).toBe(200);
    expect(world.cards[CARD_W].negotiation_mode).toBe('relay');
    expect(world.cards[CARD_W].mandate_enc).toBeNull();
  });

  it('the match page shows both sides\' figures and the box for the next one', async () => {
    world.offers.push({
      id: offerId(1),
      match_id: MATCH,
      proposer_account: BEPPE,
      amount: 5000,
      ccy: 'AUD',
      expiry: new Date(Date.now() + 86_400_000),
      state: 'proposed',
      message: { text: 'Firm on this one.', provenance: 'counterparty-untrusted' },
      authored_by: 'agent',
      created_at: new Date(),
    });
    const res = await inject('GET', `/counter/matches/${MATCH}`);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('THEIRS');
    expect(res.body).toContain('5000 AUD');
    expect(res.body).toContain('Firm on this one.');
    expect(res.body).toContain('Reply with your number');
    // The other side's mode and numbers are no part of this page.
    expect(res.body).not.toContain('authored_by');
  });

  it('a match at stage 1 says so instead of offering a box', async () => {
    world.stage = 1;
    const res = await inject('GET', `/counter/matches/${MATCH}`);
    expect(res.body).toContain('Offers open once both sides have shown interest');
    expect(res.body).not.toContain('Send this number');
  });
});

// ---------------------------------------------------------------------------
describe('the pages say it in plain words', () => {
  const rendered = [
    {
      name: 'numbers-empty',
      html: chome.cardNumbersPage({
        id: CARD_H,
        type: 'HAVE',
        category: 'Mountain bikes',
        mode: 'relay',
      }),
    },
    {
      name: 'numbers-set',
      html: chome.cardNumbersPage({
        id: CARD_H,
        type: 'HAVE',
        category: 'Mountain bikes',
        mode: 'mandate',
        mandate: HAVE_MANDATE,
      }),
    },
    {
      name: 'match-offers',
      html: chome.matchOffersPage({
        matchId: MATCH,
        cardId: CARD_H,
        category: 'Mountain bikes',
        type: 'HAVE',
        mode: 'relay',
        canOffer: true,
        offers: [],
      }),
    },
    {
      name: 'offer-approval',
      html: cpages.approvalPage({
        action: 'offer-accept',
        refId: offerId(1),
        facts: [{ k: 'You are agreeing to', v: '400 AUD' }],
        anomalies: [],
        hasPasskey: false,
        elevated: false,
        postPath: '/counter/approve',
        counterOffer: { matchId: MATCH, ccy: 'AUD' },
      }),
    },
  ];

  it('every page calls the two settings by their names', () => {
    for (const { name, html } of rendered) {
      if (name === 'offer-approval') continue;
      expect(html, name).toMatch(/Pass on|Auto-negotiate/);
    }
    expect(rendered[0].html).toContain(
      'Your agent brings every offer to you and sends back the numbers you give it.',
    );
    expect(rendered[0].html).toContain(
      'You set an opening figure and a walk-away limit; your agent can move between them without asking each time.',
    );
  });

  it('the offer approval page offers a third answer beside yes and no', () => {
    const html = rendered.find((r) => r.name === 'offer-approval')!.html;
    expect(html).toContain('Or reply with a number of your own');
    expect(html).toContain(`/counter/matches/${MATCH}/offer`);
    // Approving still asks for the PIN; replying with a figure does not.
    expect(html).toContain('Approve needs your PIN');
  });

  it('the dashboard reaches a negotiation whichever mode the card is on', () => {
    const html = chome.dashboardPage({
      killSwitchOn: false,
      cardCounts: { total: 1, published: 1, pending: 0 },
      pendingApprovals: [
        { href: `/counter/approvals/offer/${offerId(1)}`, label: 'Offer on your Mountain bikes match', amount: '400 AUD' },
      ],
      matches: [{ matchId: MATCH, category: 'Mountain bikes', score: 0.8 }],
      collectionWindows: [],
    });
    expect(html).toContain(`/counter/matches/${MATCH}`);
    expect(html).toContain('Offers &amp; your number');
    expect(html).toContain(`/counter/approvals/offer/${offerId(1)}`);
  });

  it('a set of numbers is shown back to the person who wrote it', () => {
    const html = rendered.find((r) => r.name === 'numbers-set')!.html;
    expect(html).toContain('Take no less than');
    expect(html).toContain('4321.5 AUD');
  });

  it('no page invites anyone to swap contact details beside a price', () => {
    for (const { name, html } of rendered) {
      expect(html, name).not.toMatch(/phone number|email address/i);
    }
  });
});

// ---------------------------------------------------------------------------
describe('the operating manual', () => {
  it('says whose the numbers are, in the first person', () => {
    expect(SERVER_INSTRUCTIONS).toContain('THE NUMBERS ARE THEIRS');
    expect(SERVER_INSTRUCTIONS).toContain('the money is my human');
    expect(SERVER_INSTRUCTIONS).toContain('I never invent a figure of my own');
    expect(SERVER_INSTRUCTIONS).toContain('Pass on');
    expect(SERVER_INSTRUCTIONS).toContain('Auto-negotiate');
    expect(SERVER_INSTRUCTIONS).toContain('approval page');
  });

  it('keeps the acceptance guidance it already had', () => {
    expect(SERVER_INSTRUCTIONS).toContain('send_to_human');
    expect(SERVER_INSTRUCTIONS).toContain('awaiting-human');
    expect(SERVER_INSTRUCTIONS).toContain('Declines carry no reason');
    expect(SERVER_INSTRUCTIONS).toContain('accepting an offer is still theirs');
  });

  it('never sends a human to something called the counter', () => {
    expect(SERVER_INSTRUCTIONS).not.toMatch(/\bthe counter\b/i);
  });

  it('the respond tool tells an agent the same thing before it tries', () => {
    const respond = TOOLS.find((t) => t.name === 'respond')!;
    expect(respond.description).toContain('Pass on');
    expect(respond.description).toContain('Auto-negotiate');
    expect(respond.description).toContain('CONSENT_REQUIRED');
  });
});
