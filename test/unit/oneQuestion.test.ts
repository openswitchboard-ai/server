/**
 * One question, two buttons, and the link that reaches it.
 *
 * The principle (Lachlan, 2026-09-11): the assistant does the talking and the
 * carrying; the switchboard's own page does the confirming; and whenever a
 * formality is needed the assistant asks the switchboard for its human's link
 * and hands it over in the chat. The link opens one page that asks one thing.
 *
 * What is asserted here:
 *  - each of the four pages mints, renders its one sentence, and its press does
 *    the thing — a figure goes out, a figure is taken, a window closes, a want
 *    or have moves to Auto-negotiate;
 *  - a link is single-use and figure-bound: pressing it twice fails plainly,
 *    and a tampered token is not a link at all;
 *  - the press, never the page view, is what burns a one-question link, so a
 *    person can re-read the question before answering it;
 *  - a mistyped PIN costs no link;
 *  - every respond(request_*) action MINTS AND RETURNS and changes nothing;
 *  - auto-negotiate needs BOTH halves — the account hearing through an
 *    always-on assistant AND the agent having said it runs on its own — and
 *    names whichever is missing;
 *  - a first-time person passes the onboarding question exactly once, and an
 *    account that existed before the step never sees it.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/crypto.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  encryptField: vi.fn(async (_a: string, _k: Buffer, plaintext: string) =>
    Buffer.from(`enc:${plaintext}`),
  ),
  decryptFields: vi.fn(async (_a: string, _k: Buffer, fields: Record<string, Buffer>) =>
    Object.fromEntries(
      Object.entries(fields).map(([k, v]) => [k, (v ?? Buffer.alloc(0)).toString('utf8').replace(/^enc:/, '')]),
    ),
  ),
  writeConsentEvent: vi.fn(async () => 'consent-events/x'),
  writeDecryptAudit: vi.fn(async () => 'decrypt-audit/x'),
  generateAccountDataKey: vi.fn(async () => Buffer.from('wrapped')),
}));

import { createHash } from 'node:crypto';
import { buildApp } from '../../src/app.js';
import * as db from '../../src/db.js';
import * as humanLinks from '../../src/domain/humanLinks.js';
import { dispatchTool } from '../../src/mcp/tools.js';
import { hashPin } from '../../src/counter/pin.js';
import { initCounterKeys } from '../../src/counter/keys.js';
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
  opsQueueUrl: '',
  consentLogBucket: 'x',
  identityKeyArn: 'x',
  bedrockModelId: 'x',
  registrationMode: 'dev-bootstrap',
  region: 'us-east-1',
  quotas: { maxOpenCards: 5, maxPublishesPerDay: 10, maxOffersPerHour: 6 },
  docsBase: 'https://openswitchboard.ai/docs',
  settlementFeePercent: 0,
  settlementFeeFlatMinor: 100,
} as unknown as Config;

const MATCH = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const ANA = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'; // the WANT side, signed in
const BEPPE = 'cccccccc-3333-4333-8333-cccccccccccc'; // the HAVE side
const CARD_W = 'dddddddd-4444-4444-8444-dddddddddddd';
const CARD_H = 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee';
const OFFER = '0f0f0f0f-0000-4000-8000-000000000001';
const SID = 'osb_cs_testsessionvaluetestsessionvalue';
const PIN = '241083';
const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex');

let pinHash: string;
let linkSeq = 0;
const linkId = (n: number) => `11111111-0000-4000-8000-${String(n).padStart(12, '0')}`;

interface LinkRow {
  id: string;
  token_hash: string;
  account_id: string;
  action: string;
  ref_id: string;
  amount: string | null;
  ccy: string | null;
  counterparty_account: string;
  payload: string | null;
  created_at: Date;
  expires_at: Date;
  used_at: Date | null;
  decision: string | null;
}

interface World {
  links: LinkRow[];
  offers: any[];
  offerState: string;
  stage: number;
  matchState: string;
  /** Set for a sweep test: nothing on the board, so check_in has only the
   *  account-level facts to hand back. */
  boardEmpty: boolean;
  hearsVia: string;
  runsOnItsOwn: boolean | undefined;
  mode: 'relay' | 'mandate';
  cardType: 'WANT' | 'HAVE';
  mandateWrites: { cardId: string; mode: string; mandate: any }[];
  collectUntil: Date | null;
  collectClosedAt: Date | null;
  onboardedAt: Date | null;
  firstName: string;
  locality: string;
  savedHearsVia: string[];
  elevatedUntil: Date | null;
  /** The humans whose names-step press has been recorded, and how each one
   *  was recorded. Only a press on their own page ever puts one here. */
  optins: Map<string, string>;
}
let world: World;

const theMatch = () => ({
  id: MATCH,
  card_want: CARD_W,
  card_have: CARD_H,
  account_want: ANA,
  account_have: BEPPE,
  score: 0.8,
  category: 'goods.bicycle.mountain',
  stage: world.stage,
  interest_want: true,
  interest_have: true,
  state: world.matchState,
  channel_id: null,
  opened_at: null,
});

/** The figure the other side has on the table, in whatever state it is in. */
const theOffer = () => ({
  id: OFFER,
  match_id: MATCH,
  proposer_account: BEPPE,
  amount: '430',
  ccy: 'AUD',
  state: world.offerState,
  expiry: new Date(Date.now() + 86_400_000),
  message: null,
});

function fakePool() {
  return {
    query: async (sql: string, params: any[] = []) => {
      const rows = (r: any[]) => ({ rows: r, rowCount: r.length });

      // ---- approval_links ----
      if (/INSERT INTO approval_links/.test(sql)) {
        const id = linkId(++linkSeq);
        world.links.push({
          id,
          token_hash: 'pending',
          account_id: params[0],
          action: params[1],
          ref_id: params[2],
          amount: params[3] === null ? null : String(params[3]),
          ccy: params[4],
          counterparty_account: params[5],
          payload: params[6] ?? null,
          created_at: new Date(),
          expires_at: new Date(Date.now() + 15 * 60_000),
          used_at: null,
          decision: null,
        });
        return rows([{ id }]);
      }
      if (/UPDATE approval_links SET token_hash/.test(sql)) {
        const row = world.links.find((l) => l.id === params[0]);
        if (row) row.token_hash = params[1];
        return rows([]);
      }
      if (/SELECT \* FROM approval_links WHERE id/.test(sql)) {
        const row = world.links.find((l) => l.id === params[0]);
        return rows(row ? [row] : []);
      }
      if (/SELECT \* FROM approval_links\s*\n?\s*WHERE account_id/.test(sql)) {
        return rows(
          world.links.filter(
            (l) => l.account_id === params[0] && l.action === 'stage3-disclosure' && l.ref_id === params[1] && !l.used_at,
          ),
        );
      }
      if (/UPDATE approval_links SET used_at/.test(sql)) {
        const row = world.links.find((l) => l.id === params[0] && !l.used_at);
        if (!row) return rows([]);
        row.used_at = new Date();
        return rows([{ id: row.id }]);
      }
      if (/UPDATE approval_links SET decision/.test(sql)) {
        const row = world.links.find((l) => l.id === params[0]);
        if (row) row.decision = params[1];
        return rows([]);
      }

      // ---- sessions ----
      if (/FROM counter_sessions/.test(sql) && /SELECT id, account_id/.test(sql)) {
        return params[0] === sha256hex(SID)
          ? rows([
              {
                id: 'sess-1',
                account_id: ANA,
                pin_ok_until: world.elevatedUntil,
                oauth_ctx: null,
              },
            ])
          : rows([]);
      }
      if (/UPDATE counter_sessions SET pin_ok_until/.test(sql)) {
        world.elevatedUntil = new Date(Date.now() + 5 * 60_000);
        return rows([]);
      }

      // ---- accounts ----
      if (/SELECT pin_hash, pin_failed_attempts, pin_locked_until FROM accounts/.test(sql)) {
        return rows([{ pin_hash: pinHash, pin_failed_attempts: 0, pin_locked_until: null }]);
      }
      if (/SELECT hears_via FROM accounts/.test(sql)) return rows([{ hears_via: world.hearsVia }]);
      if (/SELECT arrangement FROM accounts/.test(sql)) {
        return rows([
          {
            arrangement:
              world.runsOnItsOwn === undefined ? null : { runs_on_its_own: world.runsOnItsOwn },
          },
        ]);
      }
      if (/UPDATE accounts SET hears_via/.test(sql)) {
        world.hearsVia = params[1];
        world.savedHearsVia.push(params[1]);
        return rows([]);
      }
      if (/UPDATE accounts SET onboarded_at/.test(sql)) {
        world.onboardedAt = world.onboardedAt ?? new Date();
        return rows([]);
      }
      if (/UPDATE accounts SET first_name_enc/.test(sql)) {
        world.firstName = String(params[1]).replace(/^enc:/, '');
        world.locality = String(params[2]).replace(/^enc:/, '');
        return rows([]);
      }
      if (/^\s*SELECT \* FROM accounts WHERE id/.test(sql)) {
        return rows([
          {
            id: params[0],
            data_key_enc: Buffer.from('wrapped'),
            status: 'active',
            pin_hash: pinHash,
            hears_via: world.hearsVia,
            onboarded_at: world.onboardedAt,
            first_name_enc: Buffer.from(`enc:${params[0] === BEPPE ? 'Sam' : world.firstName}`),
            locality_enc: Buffer.from(`enc:${params[0] === BEPPE ? 'Ainslie' : world.locality}`),
          },
        ]);
      }

      // ---- cards ----
      if (/SELECT id, type, category, account_id FROM cards/.test(sql)) {
        if (params[0] !== CARD_W) return rows([]);
        return rows([
          { id: CARD_W, type: world.cardType, category: 'goods.bicycle.mountain', account_id: ANA },
        ]);
      }
      if (/SELECT collect_until FROM cards/.test(sql)) {
        const open =
          world.collectUntil && world.collectUntil > new Date() && !world.collectClosedAt;
        return rows(open ? [{ collect_until: world.collectUntil }] : []);
      }
      if (/SELECT category, collect_until, collect_closed_at FROM cards/.test(sql)) {
        return params[0] === CARD_W
          ? rows([
              {
                category: 'goods.bicycle.mountain',
                collect_until: world.collectUntil,
                collect_closed_at: world.collectClosedAt,
              },
            ])
          : rows([]);
      }
      if (/SELECT category, type FROM cards/.test(sql) || /SELECT type FROM cards/.test(sql)) {
        return params[0] === CARD_W
          ? rows([{ category: 'goods.bicycle.mountain', type: world.cardType }])
          : rows([]);
      }
      if (/SELECT category FROM cards/.test(sql)) {
        return rows([{ category: 'goods.bicycle.mountain' }]);
      }
      if (/SELECT account_id, type, negotiation_mode, mandate_enc FROM cards/.test(sql)) {
        return rows([
          { account_id: ANA, type: 'WANT', negotiation_mode: world.mode, mandate_enc: null },
        ]);
      }
      if (/UPDATE cards SET negotiation_mode/.test(sql)) {
        world.mandateWrites.push({
          cardId: params[0],
          mode: params[2],
          mandate: params[3] ? JSON.parse(String(params[3]).replace(/^enc:/, '')) : null,
        });
        return rows([{ id: params[0] }]);
      }
      if (/SELECT \* FROM cards WHERE id/.test(sql)) {
        return params[0] === CARD_W
          ? rows([
              {
                id: CARD_W,
                account_id: ANA,
                type: 'WANT',
                category: 'goods.bicycle.mountain',
                lifecycle_state: 'PUBLISHED',
                collect_until: world.collectUntil,
                collect_closed_at: world.collectClosedAt,
              },
            ])
          : rows([]);
      }
      if (/UPDATE cards SET collect_closed_at/.test(sql)) {
        if (world.collectUntil && world.collectUntil > new Date() && !world.collectClosedAt) {
          world.collectClosedAt = new Date();
          return rows([{ id: params[0] }]);
        }
        return rows([]);
      }

      // ---- matches & offers ----
      if (/SELECT c\.collect_until/.test(sql)) {
        const open =
          world.collectUntil && world.collectUntil > new Date() && !world.collectClosedAt;
        return rows(open ? [{ collect_until: world.collectUntil, n: 2 }] : []);
      }
      if (/FROM offers o\s*\n?\s*JOIN matches m/.test(sql)) {
        const m = theMatch();
        return rows([
          {
            ...theOffer(),
            category: m.category,
            stage: m.stage,
            account_want: ANA,
            account_have: BEPPE,
          },
        ]);
      }
      if (/SELECT \* FROM offers WHERE id/.test(sql)) {
        return params[0] === OFFER ? rows([theOffer()]) : rows([]);
      }
      if (/UPDATE offers SET state='accepted-by-human'/.test(sql)) {
        world.offerState = 'accepted-by-human';
        return rows([theOffer()]);
      }
      if (/FROM matches/.test(sql) && /^\s*SELECT (\*|m\.\*)/.test(sql)) {
        return rows(world.boardEmpty ? [] : [theMatch()]);
      }
      // ---- the names step ----
      if (/INSERT INTO consent_tokens/.test(sql)) {
        world.optins.set(params[1], params[2]);
        return rows([]);
      }
      if (/count\(DISTINCT account_id\)/.test(sql)) return rows([{ n: world.optins.size }]);
      if (/UPDATE matches SET stage = 3/.test(sql)) {
        world.stage = 3;
        return rows([]);
      }
      if (/read_calls/.test(sql)) return rows([{ n: 0, oldest: null }]);
      if (/SELECT count\(\*\)::int AS n FROM offers/.test(sql)) return rows([{ n: 0 }]);
      if (/SELECT count\(\*\)::int AS n,\s*min\(created_at\)/.test(sql)) {
        return rows([{ n: 0, oldest: new Date() }]);
      }
      if (/SELECT amount FROM offers/.test(sql)) return rows([]);
      if (/INSERT INTO offers/.test(sql)) {
        const row = {
          id: OFFER,
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
      return rows([]);
    },
  } as any;
}

let app: FastifyInstance;

beforeAll(async () => {
  pinHash = await hashPin(PIN);
});

beforeEach(async () => {
  world = {
    links: [],
    offers: [],
    offerState: 'proposed',
    stage: 3,
    matchState: 'open',
    boardEmpty: false,
    hearsVia: 'assistant',
    runsOnItsOwn: true,
    mode: 'relay',
    cardType: 'WANT',
    mandateWrites: [],
    collectUntil: new Date(Date.now() + 3_600_000),
    collectClosedAt: null,
    onboardedAt: new Date('2026-01-01'),
    firstName: 'Lachlan',
    locality: 'Franklin',
    savedHearsVia: [],
    elevatedUntil: null,
    optins: new Map(),
  };
  linkSeq = 0;
  vi.spyOn(db, 'getPool').mockReturnValue(fakePool());
  process.env.COUNTER_LINK_HMAC_KEY = 'a'.repeat(64);
  process.env.COUNTER_COOKIE_KEY = 'b'.repeat(64);
  await initCounterKeys(cfg);
  if (!app) {
    app = buildApp(cfg);
    await app.ready();
  }
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

/** The token out of a minted link URL. */
const tokenOf = (link: string) => decodeURIComponent(link.split('/a/')[1]);

const respond = (args: Record<string, unknown>) => dispatchTool(cfg, ANA, 'respond', args);
const body = (r: any) => r.structuredContent ?? JSON.parse(r.content[0].text);

// ---------------------------------------------------------------------------
// (a) Share your name. From 2026-09-12 this is one of the three that go to the
// human EVERY time: respond(opt_in) records nothing at all and answers with the
// link, and the press on that page is the only thing that writes an opt-in.
describe('(a) share your name', () => {
  beforeEach(() => {
    world.stage = 2; // both sides keen, neither has pressed yet
  });

  /** The link an agent is handed, whichever of the two ways it asks for it. */
  const linkFrom = (r: any): string => {
    const said = String(body(r).human_action ?? body(r).link ?? '');
    const url = said.match(/https?:\/\/\S+\/a\/\S+/)?.[0];
    expect(url, said).toBeTruthy();
    return encodeURIComponent(tokenOf(url!));
  };

  it('an agent that opts in is refused and handed the link, with a profile on file', async () => {
    const r: any = await respond({ intro_id: MATCH, action: 'opt_in' });
    expect(r.isError).toBe(true);
    expect(body(r).code).toBe('CONSENT_REQUIRED');
    expect(body(r).human_action).toContain(
      'Sharing their first name and area is theirs to press. Hand them this link',
    );
    expect(body(r).human_action).toContain('https://my.test/a/');
    // Nothing was recorded, and the step is exactly where it was.
    expect(world.optins.size).toBe(0);
    expect(world.stage).toBe(2);
    expect(world.links).toHaveLength(1);
    expect(world.links[0].action).toBe('stage3-disclosure');
  });

  it('hands back the same link request_share_name mints', async () => {
    const refused: any = await respond({ intro_id: MATCH, action: 'opt_in' });
    const asked: any = await respond({ intro_id: MATCH, action: 'request_share_name' });
    expect(body(asked).link).toBe(
      String(body(refused).human_action).match(/https?:\/\/\S+\/a\/\S+/)?.[0],
    );
    expect(world.links).toHaveLength(1); // one live link, re-used
  });

  it('asks one question, and the press is what records the go-ahead', async () => {
    const t = linkFrom(await respond({ intro_id: MATCH, action: 'opt_in' }));
    const page = await inject('GET', `/a/${t}`);
    expect(page.body).toContain('Share your first name and area with the other side?');
    expect(page.body).toContain('Confirm with your PIN');
    // Reading the question does not answer it.
    expect(world.optins.size).toBe(0);

    const pressed = await inject('POST', `/a/${t}`, { decision: 'yes', pin: PIN });
    expect(pressed.statusCode).toBe(200);
    expect(pressed.body).toContain('Shared');
    expect([...world.optins]).toEqual([[ANA, 'counter']]);
  });

  it('two presses, one from each human, open the names step', async () => {
    const t = linkFrom(await respond({ intro_id: MATCH, action: 'opt_in' }));
    await inject('POST', `/a/${t}`, { decision: 'yes', pin: PIN });
    expect(world.stage).toBe(2); // one alone changes nothing for either side

    // The other human presses their own, which the fake world stands in for.
    world.optins.set(BEPPE, 'counter');
    world.stage = 2;
    const again = await humanLinks.shareNameLink(cfg, ANA, MATCH);
    const t2 = encodeURIComponent(tokenOf(again.link));
    const pressed = await inject('POST', `/a/${t2}`, { decision: 'yes', pin: PIN });
    expect(pressed.body).toContain('Both of you have said yes');
    expect(world.stage).toBe(3);
  });

  it('asks for the two fields when nothing is on file, and stores them on the press', async () => {
    world.firstName = '';
    world.locality = '';
    const t = linkFrom(await respond({ intro_id: MATCH, action: 'opt_in' }));
    const page = await inject('GET', `/a/${t}`);
    expect(page.body).toContain('What should we share?');
    expect(page.body).toContain('name="first_name"');
    expect(page.body).toContain('name="locality"');

    const pressed = await inject('POST', `/a/${t}`, {
      decision: 'yes',
      pin: PIN,
      first_name: 'Ana',
      locality: 'Fremantle',
    });
    expect(pressed.statusCode).toBe(200);
    expect(world.firstName).toBe('Ana');
    expect(world.locality).toBe('Fremantle');
    expect([...world.optins]).toEqual([[ANA, 'counter']]);
  });

  it('a suburb that looks like a way to reach someone costs neither the link nor a PIN attempt', async () => {
    world.firstName = '';
    world.locality = '';
    const t = linkFrom(await respond({ intro_id: MATCH, action: 'opt_in' }));
    const bad = await inject('POST', `/a/${t}`, {
      decision: 'yes',
      pin: PIN,
      first_name: 'Ana',
      locality: 'ana@example.com',
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.body).toContain('no email, phone or web address');
    expect(world.optins.size).toBe(0);
    expect(world.links[0].used_at).toBeNull();

    // And the same link still works with a real suburb.
    const good = await inject('POST', `/a/${t}`, {
      decision: 'yes',
      pin: PIN,
      first_name: 'Ana',
      locality: 'Fremantle',
    });
    expect(good.statusCode).toBe(200);
    expect([...world.optins]).toEqual([[ANA, 'counter']]);
  });

  it('"Not now" shares nothing and carries no reason', async () => {
    const t = linkFrom(await respond({ intro_id: MATCH, action: 'opt_in' }));
    const pressed = await inject('POST', `/a/${t}`, { decision: 'no' });
    expect(pressed.body).toContain('Not now');
    expect(pressed.body).toContain('no reason was sent');
    expect(world.optins.size).toBe(0);
  });

  it('a second press fails plainly, and records nothing twice', async () => {
    const t = linkFrom(await respond({ intro_id: MATCH, action: 'opt_in' }));
    await inject('POST', `/a/${t}`, { decision: 'yes', pin: PIN });
    world.optins.clear();
    const again = await inject('POST', `/a/${t}`, { decision: 'yes', pin: PIN });
    expect(again.body).toContain('already been used');
    expect(world.optins.size).toBe(0);
  });

  it('says the earlier step first while the other side has yet to warm up', async () => {
    world.stage = 1;
    const r: any = await respond({ intro_id: MATCH, action: 'opt_in' });
    expect(r.isError).toBe(true);
    expect(body(r).code).toBe('NOT_UNLOCKED_YET');
    expect(world.links).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe('(b) send a number', () => {
  const mint = () =>
    humanLinks.sendNumberLink(cfg, ANA, MATCH, {
      amount: 440,
      ccy: 'AUD',
      message: 'Can collect Saturday.',
    });

  it('asks one question, names the figure and the person, and sends on the press', async () => {
    const { link, expires_in_minutes, what_it_does } = await mint();
    expect(expires_in_minutes).toBe(15);
    expect(what_it_does).toContain('$440 AUD');

    const page = await inject('GET', `/a/${encodeURIComponent(tokenOf(link))}`);
    expect(page.statusCode).toBe(200);
    // Stage 3, so the other person has a name to use.
    // Ana is the buyer, so it is the bike she is after, never 'your' bike.
    expect(page.body).toContain('Send $440 AUD to Sam for the mountain bike you are after?');
    expect(page.body).toContain('>Send<');
    expect(page.body).toContain('>Not now<');
    expect(page.body).toContain('Confirm with your PIN');
    expect(page.body).toContain('Can collect Saturday.');
    // Nothing has happened, and the link is not spent by reading it.
    expect(world.offers).toHaveLength(0);
    expect(world.links[0].used_at).toBeNull();

    const pressed = await inject('POST', `/a/${encodeURIComponent(tokenOf(link))}`, {
      decision: 'yes',
      pin: PIN,
    });
    expect(pressed.statusCode).toBe(200);
    expect(pressed.body).toContain('Your number is on the table for the other side.');
    // The end of a pressed link: nothing to go back to, the assistant has it.
    expect(pressed.body).toContain('Done. Close this tab and carry on with your assistant.');
    expect(pressed.body).not.toContain('Back to your approval page');
    expect(world.offers).toHaveLength(1);
    expect(world.offers[0]).toMatchObject({ amount: 440, ccy: 'AUD', authored_by: 'human' });
    expect(world.links[0].decision).toBe('approved');
  });

  it('before the names step it says "the other side" rather than inventing one', async () => {
    world.stage = 2;
    const { link } = await mint();
    const page = await inject('GET', `/a/${encodeURIComponent(tokenOf(link))}`);
    expect(page.body).toContain('Send $440 AUD to the other side for the mountain bike you are after?');
  });

  it('"Not now" sends nothing and carries no reason', async () => {
    const { link } = await mint();
    const r = await inject('POST', `/a/${encodeURIComponent(tokenOf(link))}`, { decision: 'no' });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('Nothing changed, and no reason was sent.');
    expect(world.offers).toHaveLength(0);
    expect(world.links[0].decision).toBe('declined');
  });

  it('a second press fails plainly, and sends nothing twice', async () => {
    const { link } = await mint();
    const t = encodeURIComponent(tokenOf(link));
    await inject('POST', `/a/${t}`, { decision: 'yes', pin: PIN });
    expect(world.offers).toHaveLength(1);
    const again = await inject('POST', `/a/${t}`, { decision: 'yes', pin: PIN });
    expect(again.body).toContain('Already used');
    expect(world.offers).toHaveLength(1);
  });

  it('a tampered link is not a link', async () => {
    const { link } = await mint();
    const tok = tokenOf(link);
    const [id, mac] = tok.split('.');
    for (const bad of [`${id}.${'A'.repeat(mac.length)}`, `${linkId(99)}.${mac}`]) {
      const r = await inject('POST', `/a/${encodeURIComponent(bad)}`, {
        decision: 'yes',
        pin: PIN,
      });
      expect(r.body).toMatch(/Not a valid link|Already used/);
    }
    expect(world.offers).toHaveLength(0);
  });

  it('a wrong PIN costs the attempt and not the link', async () => {
    const { link } = await mint();
    const t = encodeURIComponent(tokenOf(link));
    const wrong = await inject('POST', `/a/${t}`, { decision: 'yes', pin: '000000' });
    expect(wrong.statusCode).toBe(401);
    expect(world.links[0].used_at).toBeNull();
    const right = await inject('POST', `/a/${t}`, { decision: 'yes', pin: PIN });
    expect(right.statusCode).toBe(200);
    expect(world.offers).toHaveLength(1);
  });

  it('the figures are bound: the page reads them from the row, never the form', async () => {
    const { link } = await mint();
    await inject('POST', `/a/${encodeURIComponent(tokenOf(link))}`, {
      decision: 'yes',
      pin: PIN,
      // A person editing the form cannot move the figure: nothing here is read.
      amount: '5',
      ccy: 'USD',
    });
    expect(world.offers[0]).toMatchObject({ amount: 440, ccy: 'AUD' });
  });
});

// ---------------------------------------------------------------------------
describe('(c) accept a number', () => {
  beforeEach(() => {
    // A figure there to take means nothing of this person's is still
    // collecting: an open window of their own locks acceptance elsewhere.
    world.collectUntil = null;
  });

  const mint = () => humanLinks.acceptNumberLink(cfg, ANA, OFFER);

  it('states the figure, offers Accept and Not now, and agrees it on the press', async () => {
    world.offerState = 'proposed';
    const { link, expires_in_minutes, what_it_does } = await mint();
    expect(expires_in_minutes).toBe(15);
    expect(what_it_does).toContain('$430 AUD');

    const t = encodeURIComponent(tokenOf(link));
    const page = await inject('GET', `/a/${t}`);
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('Sam wants $430 AUD for the mountain bike you are after.');
    expect(page.body).toContain('>Accept<');
    expect(page.body).toContain('>Not now<');
    expect(page.body).toContain('Confirm with your PIN');
    // Nothing else is on the page: no link away, no second decision. A number
    // of their own goes through the assistant ("tell me a number and I'll
    // carry it"). Reading the question does not burn the link.
    expect(page.body).not.toContain('href="/matches/');
    expect(page.body).not.toContain('different number');
    expect(world.links[0].used_at).toBeNull();
    expect(world.offerState).toBe('proposed');

    const pressed = await inject('POST', `/a/${t}`, { decision: 'yes', pin: PIN });
    expect(pressed.statusCode).toBe(200);
    expect(pressed.body).toContain('The number is agreed.');
    expect(world.offerState).toBe('accepted-by-human');
    expect(world.links[0].decision).toBe('approved');
  });

  it('before the names step it says "the other side" rather than inventing one', async () => {
    world.stage = 2;
    const { link } = await mint();
    const page = await inject('GET', `/a/${encodeURIComponent(tokenOf(link))}`);
    expect(page.body).toContain('The other side wants $430 AUD for the mountain bike you are after.');
  });

  it('"Not now" agrees nothing and carries no reason', async () => {
    const { link } = await mint();
    const r = await inject('POST', `/a/${encodeURIComponent(tokenOf(link))}`, { decision: 'no' });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('Nothing changed, and no reason was sent.');
    expect(world.offerState).toBe('proposed');
    expect(world.links[0].decision).toBe('declined');
  });

  it('a second press fails plainly, and agrees nothing twice', async () => {
    const { link } = await mint();
    const t = encodeURIComponent(tokenOf(link));
    await inject('POST', `/a/${t}`, { decision: 'yes', pin: PIN });
    expect(world.offerState).toBe('accepted-by-human');
    world.offerState = 'proposed'; // whatever the board says, the link is spent
    const again = await inject('POST', `/a/${t}`, { decision: 'yes', pin: PIN });
    expect(again.body).toContain('Already used');
    expect(world.offerState).toBe('proposed');
  });

  it('a wrong PIN costs the attempt and not the link', async () => {
    const { link } = await mint();
    const t = encodeURIComponent(tokenOf(link));
    const wrong = await inject('POST', `/a/${t}`, { decision: 'yes', pin: '000000' });
    expect(wrong.statusCode).toBe(401);
    expect(world.links[0].used_at).toBeNull();
    expect(world.offerState).toBe('proposed');
    const right = await inject('POST', `/a/${t}`, { decision: 'yes', pin: PIN });
    expect(right.statusCode).toBe(200);
    expect(world.offerState).toBe('accepted-by-human');
  });

  it('the figure is bound: the page reads it from the row, never the form', async () => {
    const { link } = await mint();
    const page = await inject('GET', `/a/${encodeURIComponent(tokenOf(link))}`);
    expect(page.body).toContain('$430 AUD');
    expect(page.body).not.toContain('$5 AUD');
  });

  it('mints for one already parked for them', async () => {
    world.offerState = 'awaiting-human';
    const r = await mint();
    expect(r.link).toContain('/a/');
    const page = await inject('GET', `/a/${encodeURIComponent(tokenOf(r.link))}`);
    expect(page.body).toContain('Sam wants $430 AUD for the mountain bike you are after.');
  });

  it('says nothing is left to accept once the figure has moved on', async () => {
    const { link } = await mint();
    world.offerState = 'declined';
    const page = await inject('GET', `/a/${encodeURIComponent(tokenOf(link))}`);
    expect(page.body).toContain('there is nothing left to accept');
  });

  it('refuses a figure that is no longer live, in plain words', async () => {
    world.offerState = 'declined';
    await expect(mint()).rejects.toMatchObject({
      payload: { code: 'NOT_UNLOCKED_YET' },
    });
  });
});

// ---------------------------------------------------------------------------
// (d) There was a fourth link here, for closing the short window on a want or
// have of the holder's own. The window is gone (migration 030): nothing blocks
// a holder, so there is nothing to close and no link to mint. What is asserted
// instead is that an agent still reaching for it is told so plainly, rather
// than being handed "unknown action".
describe('(d) the window that is gone', () => {
  it('answers both retired actions with a plain refusal, and mints nothing', async () => {
    for (const args of [
      { intent_id: CARD_W, action: 'request_close_window' },
      { intro_id: MATCH, action: 'close_collection' },
    ]) {
      const r: any = await respond(args);
      expect(r.isError).toBe(true);
      expect(JSON.stringify(r.content[0].text)).toContain('the window is gone');
      expect(JSON.stringify(r.content[0].text)).toContain('one at a time');
    }
    expect(world.links).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe('(e) auto-negotiate', () => {
  const numbers = { open: 450, limit: 400, step: 10, ccy: 'AUD' };
  beforeEach(() => {
    // Something they are offering: the limit is the least they will take, so
    // the opening figure sits above it.
    world.cardType = 'HAVE';
  });

  it('asks the whole box in one sentence, and writes it on the press', async () => {
    const r = await humanLinks.autoNegotiateLink(cfg, ANA, CARD_W, numbers);
    const t = encodeURIComponent(tokenOf(r.link));
    const page = await inject('GET', `/a/${t}`);
    expect(page.body).toContain(
      'Let your assistant negotiate the mountain bike: open at $450 AUD, take no less than $400 AUD, move in steps of $10 AUD?',
    );
    expect(page.body).toContain('Confirm with your PIN');

    const pressed = await inject('POST', `/a/${t}`, { decision: 'yes', pin: PIN });
    expect(pressed.statusCode).toBe(200);
    expect(world.mandateWrites).toHaveLength(1);
    expect(world.mandateWrites[0]).toMatchObject({
      cardId: CARD_W,
      mode: 'mandate',
      mandate: { open: 450, limit: 400, step: 10, ccy: 'AUD' },
    });
  });

  // The three combinations. Handing an agent the wheel only makes sense when
  // there is an agent there to hold it, and that is two facts rather than one.
  it('is refused when the account hears by email', async () => {
    world.hearsVia = 'email';
    world.runsOnItsOwn = true;
    await expect(humanLinks.autoNegotiateLink(cfg, ANA, CARD_W, numbers)).rejects.toMatchObject({
      payload: {
        code: 'CONSENT_REQUIRED',
        human_action: humanLinks.AUTO_NEGOTIATE_NEEDS_ASSISTANT,
      },
    });
    expect(world.links).toHaveLength(0);
  });

  it('is refused when the agent has not said it runs on its own', async () => {
    world.hearsVia = 'assistant';
    world.runsOnItsOwn = false;
    await expect(humanLinks.autoNegotiateLink(cfg, ANA, CARD_W, numbers)).rejects.toMatchObject({
      payload: {
        code: 'CONSENT_REQUIRED',
        human_action: humanLinks.AUTO_NEGOTIATE_NEEDS_RUNS_ON_ITS_OWN,
      },
    });
    expect(world.links).toHaveLength(0);
  });

  it('is allowed only when both are true', async () => {
    world.hearsVia = 'assistant';
    world.runsOnItsOwn = true;
    await expect(humanLinks.autoNegotiateLink(cfg, ANA, CARD_W, numbers)).resolves.toMatchObject({
      expires_in_minutes: 15,
    });
  });

  it('refuses numbers the human could not have meant, before any link exists', async () => {
    // On something they are offering, opening below the floor is the wrong
    // way round.
    await expect(
      humanLinks.autoNegotiateLink(cfg, ANA, CARD_W, { open: 300, limit: 400, ccy: 'AUD' }),
    ).rejects.toThrow(/opening figure sits at or above it/);
    expect(world.links).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe('the assistant fetches the links and never acts', () => {
  it('every request_* answers link, expiry and a sentence, and changes nothing', async () => {
    const calls: Record<string, unknown>[] = [
      { intro_id: MATCH, action: 'request_share_name' },
      { intro_id: MATCH, action: 'request_accept', offer_id: OFFER },
      {
        intent_id: CARD_W,
        action: 'request_auto_negotiate',
        numbers: { limit: 400, ccy: 'AUD' },
      },
    ];
    for (const args of calls) {
      const r: any = await respond(args);
      expect(r.isError, JSON.stringify(r.content?.[0]?.text)).toBeUndefined();
      const out = body(r);
      expect(out.link, String(args.action)).toContain('https://my.test/a/');
      expect(out.expires_in_minutes).toBe(15);
      expect(String(out.what_it_does).length).toBeGreaterThan(20);
    }
    // Three links minted, and not one of them acted on.
    expect(world.links).toHaveLength(3);
    expect(world.offers).toHaveLength(0);
    expect(world.mandateWrites).toHaveLength(0);
  });

  it('relays the auto-negotiate refusal to the agent that asked', async () => {
    world.hearsVia = 'email';
    const r: any = await respond({
      intent_id: CARD_W,
      action: 'request_auto_negotiate',
      numbers: { limit: 400, ccy: 'AUD' },
    });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content[0].text)).toContain('this account hears by email');
  });

  it('says which field is missing rather than failing obscurely', async () => {
    for (const [args, want] of [
      [{ intro_id: MATCH, action: 'request_accept' }, 'requires offer_id'],
      [{ action: 'request_auto_negotiate', intent_id: CARD_W }, 'requires the numbers'],
      [{ action: 'express_interest' }, 'requires intro_id'],
    ] as const) {
      const r: any = await respond(args as Record<string, unknown>);
      expect(r.isError).toBe(true);
      expect(JSON.stringify(r.content[0].text)).toContain(want);
    }
  });

  it('a sweep tells an agent both facts it needs before it offers to negotiate', async () => {
    world.boardEmpty = true;
    world.hearsVia = 'assistant';
    world.runsOnItsOwn = true;
    const r: any = await dispatchTool(cfg, ANA, 'check_in', {});
    const out = body(r);
    expect(out.hears_via).toBe('assistant');
    expect(out.runs_on_its_own).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('the onboarding question, once', () => {
  it('a first-time person is sent to it after the PIN and before anything else', async () => {
    world.onboardedAt = null;
    const home = await inject('GET', '/');
    expect(home.statusCode).toBe(303);
    expect(home.headers.location).toBe('/hello');
    const page = await inject('GET', '/hello');
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('Which kind of assistant do you use?');
    expect(page.body).toContain('An always-on agent.');
    expect(page.body).toContain('First name');
  });

  it('saves the answer and the shared profile, then gets out of the way', async () => {
    world.onboardedAt = null;
    world.firstName = '';
    world.locality = '';
    const r = await inject('POST', '/hello', {
      hears_via: 'assistant',
      first_name: 'Lachlan',
      locality: 'Franklin',
    });
    expect(r.statusCode).toBe(303);
    expect(r.headers.location).toBe('/');
    expect(world.savedHearsVia).toEqual(['assistant']);
    expect(world.firstName).toBe('Lachlan');
    expect(world.locality).toBe('Franklin');
    expect(world.onboardedAt).not.toBeNull();
    // And it never asks again.
    expect((await inject('GET', '/hello')).statusCode).toBe(303);
  });

  it('skipping leaves them on email, which is the safe answer', async () => {
    world.onboardedAt = null;
    world.firstName = '';
    world.locality = '';
    const r = await inject('POST', '/hello', { skip: 'yes', hears_via: 'assistant' });
    expect(r.statusCode).toBe(303);
    expect(world.savedHearsVia).toEqual([]);
    expect(world.hearsVia).toBe('assistant'); // the world's own starting value
    expect(world.firstName).toBe('');
    expect(world.onboardedAt).not.toBeNull();
  });

  it('half a shared profile is refused, with the page still asking', async () => {
    world.onboardedAt = null;
    const r = await inject('POST', '/hello', { hears_via: 'email', first_name: 'Lachlan' });
    expect(r.statusCode).toBe(400);
    expect(r.body).toContain('Add the suburb or area you are in.');
    expect(world.onboardedAt).toBeNull();
  });

  it('an account that existed before the step never sees it', async () => {
    world.onboardedAt = new Date('2026-01-01');
    expect((await inject('GET', '/hello')).statusCode).toBe(303);
  });
});

// ---------------------------------------------------------------------------
describe('a figure an agent carried comes back as its own question', () => {
  it('the Pass-on refusal hands over the send-number link, bound to that figure', async () => {
    const r: any = await respond({
      intro_id: MATCH,
      action: 'propose_offer',
      offer: {
        amount: 440,
        ccy: 'AUD',
        expiry: new Date(Date.now() + 86_400_000).toISOString(),
      },
    });
    expect(r.isError).toBe(true);
    const text = String(r.content[0].text);
    expect(text).toContain('one press and it goes');
    expect(text).toContain('https://my.test/a/');
    const minted = world.links.find((l) => l.action === 'offer-send');
    expect(minted).toBeDefined();
    expect(JSON.parse(minted!.payload!)).toMatchObject({ amount: 440, ccy: 'AUD' });
    // Refused means refused: no offer row exists.
    expect(world.offers).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe('a link belongs to one person', () => {
  it('an unsigned-in visitor is asked to sign in, and the link survives', async () => {
    const { link } = await humanLinks.sendNumberLink(cfg, ANA, MATCH, { amount: 440, ccy: 'AUD' });
    const r = await app.inject({
      method: 'GET',
      url: `/a/${encodeURIComponent(tokenOf(link))}`,
      headers: { host: 'my.test' },
    });
    expect(r.statusCode).toBe(401);
    expect(r.body).toContain('Sign in');
    expect(world.links[0].used_at).toBeNull();
  });

  it('a link for a want or have that is not yours is not minted at all', async () => {
    await expect(humanLinks.autoNegotiateLink(cfg, ANA, CARD_H, { limit: 400, ccy: 'AUD' }))
      .rejects.toMatchObject({ notFound: true });
    expect(world.links).toHaveLength(0);
  });

  it('the refusals carry the protocol shape an agent can act on', async () => {
    world.hearsVia = 'email';
    await expect(
      humanLinks.autoNegotiateLink(cfg, ANA, CARD_W, { limit: 400, ccy: 'AUD' }),
    ).rejects.toBeInstanceOf(OsbError);
  });
});
