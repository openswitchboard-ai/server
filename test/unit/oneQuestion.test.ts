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
import { dispatchTool, TOOLS } from '../../src/mcp/tools.js';
import { lintHumanCopy } from '../../src/email/lint.js';
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
  /** Set once the two of them are talking, which is what the renewal page
   *  asks about. */
  channelId: string | null;
  /** The conversation budget, one row per side of this introduction. */
  windows: Map<string, { started_at: Date; messages_sent: number; granted_via: string }>;
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
  channel_id: world.channelId,
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
      // ---- the conversation budget ----
      if (/INSERT INTO conversation_windows/.test(sql)) {
        const k = `${params[0]}|${params[1]}`;
        const renewal = /DO UPDATE SET started_at = now\(\)/.test(sql);
        if (renewal || !world.windows.has(k)) {
          world.windows.set(k, {
            started_at: new Date(),
            messages_sent: 0,
            granted_via: String(params[2]),
          });
        }
        return rows([]);
      }
      if (/FROM conversation_windows WHERE match_id/.test(sql)) {
        const w = world.windows.get(`${params[0]}|${params[1]}`);
        return rows(w ? [{ messages_sent: w.messages_sent, in_time: true }] : []);
      }
      if (/read_calls|write_calls/.test(sql)) return rows([{ n: 0, oldest: null }]);
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
    channelId: null,
    windows: new Map(),
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

  it('an agent that opts in is handed the link as an ordinary answer, with a profile on file', async () => {
    const r: any = await respond({ intro_id: MATCH, action: 'opt_in' });
    // Waiting on a press is the switchboard working, so nothing fails here:
    // the word, the sentence and the link all come back together.
    expect(r.isError).toBe(false);
    expect(body(r).what_happened).toBe('your_human_presses');
    expect(body(r).link).toContain('https://my.test/a/');
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
    expect(r.isError).toBe(false);
    expect(body(r).what_happened).toBe('not_open_yet');
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

  // -------------------------------------------------------------------------
  /**
   * THE SENTENCE THAT REACHES THE HUMAN.
   *
   * Dev, 20 September 2026: an assistant fetched a names link, its first wait
   * failed, it fetched a second link and waited several more times, and across
   * fifteen minutes it never put a link in front of its human at all — it
   * discussed a page he had never been given and asked him whether it was
   * loading. The three-step handover was already written out at length in
   * read_manual("links_and_presses") and said again on both tool descriptions.
   * More manual was plainly not the lever.
   *
   * So the lever this asserts: the answer the agent is reading at that moment
   * hands it a finished sentence with the link already inside it. Leading with
   * `say` IS the handover, and it cannot be led with while the link is still
   * sitting unsaid in the answer. `what_it_does` stays the agent-facing half.
   */
  describe('every link answer carries the sentence to say, with the link in it', () => {
    /** The nouns that belong to the machinery, as every human-facing test lists them. */
    const BANNED = [
      { label: 'card', re: /\b(index\s+)?cards?\b/i },
      { label: 'channel', re: /\bchannels?\b/i },
      { label: 'match', re: /\bmatch(es)?\b/i },
      { label: 'stage', re: /\bstages?\b/i },
      { label: 'connection', re: /\bconnections?\b/i },
      { label: 'score', re: /\bscores?\b/i },
    ];

    const everyLinkAction: [string, Record<string, unknown>][] = [
      ['request_share_name', { intro_id: MATCH, action: 'request_share_name' }],
      ['request_accept', { intro_id: MATCH, action: 'request_accept', offer_id: OFFER }],
      [
        'request_auto_negotiate',
        { intent_id: CARD_W, action: 'request_auto_negotiate', numbers: { limit: 400, ccy: 'AUD' } },
      ],
    ];

    for (const [name, args] of everyLinkAction) {
      it(`${name}: says what the page asks and ends on the very link it minted`, async () => {
        const out = body(await respond(args));
        expect(out.say, name).toBeTruthy();
        // The link is IN the sentence, so an agent that relays it has handed
        // the page over whether or not it thought about step two.
        expect(out.say, name).toContain(out.link);
        expect(out.say.trim().endsWith(out.link), name).toBe(true);
        // One lead-in, the same everywhere, so the shape is learned once.
        expect(out.say, name).toMatch(/^Here is your page — it asks /);
        // Said to the person who will press it, rather than about them.
        expect(out.say, name).not.toMatch(/\byour human\b/i);
        // And it is a sentence, rather than the agent-facing half again.
        expect(out.say, name).not.toBe(out.what_it_does);
        // The agent-facing half still talks ABOUT the human, in the third
        // person, which is the whole difference between the two fields.
        expect(out.what_it_does, name).toMatch(/\byour human\b|\bthey\b/i);
      });

      it(`${name}: is in the house register, like everything else a person hears`, async () => {
        const out = body(await respond(args));
        // Only the link may carry the machinery: a token is not prose.
        const prose = out.say.replace(out.link, '');
        expect(lintHumanCopy(prose), name).toEqual([]);
        for (const { label, re } of BANNED) {
          expect(re.test(prose), `${label} in ${name}: ${prose}`).toBe(false);
        }
        expect(prose, name).not.toMatch(/press_id|intro_id|offer_id|what_it_does/);
      });
    }

    it('says SUBURB on the names page, because that is the word the page uses', async () => {
      // Never invite something vaguer than the page asks for: the other person
      // is working out whether this is ten minutes away or two hours.
      const out = body(await respond({ intro_id: MATCH, action: 'request_share_name' }));
      expect(out.say).toContain('your first name and your suburb');
      expect(out.say).not.toMatch(/\barea\b/i);
      expect(out.say).toMatch(/nothing crosses until you press it/);
    });

    it('names the figure on the accept page, in the words money is said in', async () => {
      const out = body(await respond({ intro_id: MATCH, action: 'request_accept', offer_id: OFFER }));
      expect(out.say).toMatch(/whether to accept \$\d/);
      // A page that moves money asks for a credential, so the sentence says so
      // before they open it.
      expect(out.say).toMatch(/takes your passkey or PIN/);
    });

    it('names the edge on the auto-negotiate page, and the credential it asks for', async () => {
      const out = body(
        await respond({
          intent_id: CARD_W,
          action: 'request_auto_negotiate',
          numbers: { limit: 400, ccy: 'AUD' },
        }),
      );
      expect(out.say).toMatch(/pay no more than \$400 AUD|take no less than \$400 AUD/);
      expect(out.say).toMatch(/takes your passkey or PIN/);
    });

    it('is named on the tool an agent reads, inside the same budget as before', () => {
      // The inconsistency that left the hole: respond promised "every answer
      // carries the sentence to say", which was true of the other actions and
      // not of the link ones. It is true of all of them now, and the tool says
      // where the sentence is.
      const respondTool = TOOLS.find((t) => t.name === 'respond')!;
      expect(respondTool.description).toMatch(/lead with it; on a link action it is `say`/);
      expect(respondTool.description).toContain('{ say, link, press_id');
      expect(respondTool.description).toMatch(/THE LINK ORDER, one turn: lead with `say`, THEN wait_for_press/);
      // Hand it over FIRST, then wait: the order is unchanged, and `say` is
      // what makes step two trivial rather than what replaces it.
      expect(respondTool.description).toMatch(/is a sentence you never write/);
      // The cap did not move for this (test/unit/readManual.test.ts).
      expect(respondTool.description.length).toBeLessThanOrEqual(1400);
    });
  });

  it('relays the auto-negotiate refusal to the agent that asked', async () => {
    world.hearsVia = 'email';
    const r: any = await respond({
      intent_id: CARD_W,
      action: 'request_auto_negotiate',
      numbers: { limit: 400, ccy: 'AUD' },
    });
    expect(r.isError).toBe(false);
    expect(body(r).what_happened).toBe('your_human_presses');
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
    expect(r.isError).toBe(false);
    const text = String(r.content[0].text);
    // The link travels beside the sentence as well as inside it.
    expect(body(r).link).toContain('https://my.test/a/');
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
// Every link an agent is handed comes with the press it can wait on, so the
// agent never has to ask its human to come back and say "done".
// ---------------------------------------------------------------------------
describe('every link hands back the press to wait on', () => {
  it('each request_* answers a press_id that is the link it just minted', async () => {
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
      const out = body(await respond(args));
      expect(typeof out.press_id, String(args.action)).toBe('string');
      expect(world.links.some((l) => l.id === out.press_id), String(args.action)).toBe(true);
      // The press named is the one behind the link handed over, not some other.
      expect(tokenOf(String(out.link)).split('.')[0]).toBe(out.press_id);
    }
  });

  it('the names-step refusal carries the press_id beside the link', async () => {
    world.stage = 2;
    const refused = body(await respond({ intro_id: MATCH, action: 'opt_in' }));
    expect(refused.code).toBe('CONSENT_REQUIRED');
    expect(refused.press_id).toBe(world.links[0].id);
    // And it is the same press the deliberate ask hands back.
    const asked = body(await respond({ intro_id: MATCH, action: 'request_share_name' }));
    expect(asked.press_id).toBe(refused.press_id);
  });

  it('the Pass-on refusal carries the press_id of the send-number page', async () => {
    const refused = body(
      await respond({
        intro_id: MATCH,
        action: 'propose_offer',
        offer: {
          amount: 440,
          ccy: 'AUD',
          expiry: new Date(Date.now() + 86_400_000).toISOString(),
        },
      }),
    );
    expect(refused.code).toBe('CONSENT_REQUIRED');
    expect(refused.press_id).toBe(world.links.find((l) => l.action === 'offer-send')!.id);
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

// ---------------------------------------------------------------------------
// (h) Keep the conversation going. The renewal of one side's own window
// (domain/conversationWindow.ts): a human's go-ahead to talk runs out, and this
// is the page that gives it again.
describe('(h) keep the conversation going', () => {
  beforeEach(() => {
    world.stage = 4;
    world.channelId = 'ch_11111111-2222-4333-8444-555555555555';
    world.optins.set(ANA, 'counter');
    world.optins.set(BEPPE, 'counter');
    world.windows.set(`${MATCH}|${ANA}`, {
      started_at: new Date(Date.now() - 86_400_000),
      messages_sent: 12,
      granted_via: 'names-press',
    });
  });

  const keepTalkingToken = async (): Promise<string> => {
    const r: any = await respond({ intro_id: MATCH, action: 'request_keep_talking' });
    expect(r.isError).toBeFalsy();
    expect(body(r).link).toContain('https://my.test/a/');
    return encodeURIComponent(tokenOf(body(r).link));
  };

  it('mints and returns, and changes nothing at all', async () => {
    const r: any = await respond({ intro_id: MATCH, action: 'request_keep_talking' });
    expect(body(r).expires_in_minutes).toBe(15);
    expect(body(r).what_it_does).toContain('keep this conversation going');
    // And the half that is for the human: a finished sentence with the page
    // inside it, so relaying it is the whole of the handover.
    expect(body(r).say).toMatch(/^Here is your page — it asks whether to keep this conversation going/);
    expect(body(r).say).toContain(body(r).link);
    expect(lintHumanCopy(body(r).say.replace(body(r).link, ''))).toEqual([]);
    expect(world.links).toHaveLength(1);
    expect(world.links[0].action).toBe('conversation-renew');
    expect(body(r).press_id).toBe(world.links[0].id);
    // The window is exactly as it was: minting a page is not pressing it.
    expect(world.windows.get(`${MATCH}|${ANA}`)!.messages_sent).toBe(12);
  });

  it('asks one question, says how many have gone, and takes the PIN', async () => {
    const t = await keepTalkingToken();
    const page = await inject('GET', `/a/${t}`);
    expect(page.body).toContain('Keep the conversation going?');
    expect(page.body).toContain('12 messages have gone from your side so far.');
    expect(page.body).toContain('Keep going');
    expect(page.body).toContain('Confirm with your PIN');
    // Reading the question does not answer it.
    expect(world.windows.get(`${MATCH}|${ANA}`)!.messages_sent).toBe(12);
  });

  it('the press starts a fresh window, and only for the human who pressed', async () => {
    const t = await keepTalkingToken();
    const pressed = await inject('POST', `/a/${t}`, { decision: 'yes', pin: PIN });
    expect(pressed.statusCode).toBe(200);
    expect(pressed.body).toContain('Carry on');
    const mine = world.windows.get(`${MATCH}|${ANA}`)!;
    expect(mine.messages_sent).toBe(0);
    expect(mine.granted_via).toBe('renewal-press');
    // Nothing was granted to the other side, who hears none of this.
    expect(world.windows.has(`${MATCH}|${BEPPE}`)).toBe(false);
  });

  it('may be pressed EARLY, while there is still room in the window', async () => {
    world.windows.get(`${MATCH}|${ANA}`)!.messages_sent = 1;
    const t = await keepTalkingToken();
    await inject('POST', `/a/${t}`, { decision: 'yes', pin: PIN });
    expect(world.windows.get(`${MATCH}|${ANA}`)!.messages_sent).toBe(0);
  });

  it('Not now leaves it paused, and changes nothing', async () => {
    const t = await keepTalkingToken();
    const pressed = await inject('POST', `/a/${t}`, { decision: 'no' });
    expect(pressed.body).toContain('Not now');
    expect(world.windows.get(`${MATCH}|${ANA}`)!.messages_sent).toBe(12);
    expect(world.links[0].decision).toBe('declined');
  });

  it('is not minted at all where there is no open conversation', async () => {
    world.channelId = null;
    world.stage = 3;
    const r: any = await respond({ intro_id: MATCH, action: 'request_keep_talking' });
    expect(body(r).code).toBe('NOT_UNLOCKED_YET');
    expect(world.links).toHaveLength(0);
  });

  it('works once: a second press of the same page finds nothing left', async () => {
    const t = await keepTalkingToken();
    await inject('POST', `/a/${t}`, { decision: 'yes', pin: PIN });
    world.windows.get(`${MATCH}|${ANA}`)!.messages_sent = 7;
    const again = await inject('POST', `/a/${t}`, { decision: 'yes', pin: PIN });
    expect(again.body.toLowerCase()).toContain('used');
    expect(world.windows.get(`${MATCH}|${ANA}`)!.messages_sent).toBe(7);
  });
});
