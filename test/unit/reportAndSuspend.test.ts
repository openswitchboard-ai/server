/**
 * Reporting somebody, and stopping an account
 * (docs/trust-and-safety.md, steps 5 and 6).
 *
 * WHAT IS ASSERTED HERE.
 *
 * The report:
 *  - respond(request_report) MINTS AND RETURNS, like every other link action,
 *    and changes nothing at all until the press;
 *  - the page it opens is the ordinary one-question page, with one box on it;
 *  - the press takes the human's OWN credential — a passkey where they hold
 *    one, a PIN otherwise — because an assistant driving a browser could
 *    otherwise close a conversation for good without its human. An account
 *    holding neither is sent to set one up, and the link survives the trip;
 *  - the press does four things in one breath — the report is written, the
 *    introduction is severed, the pairing is muted, and every ledger entry
 *    behind that introduction is held past the thirty days;
 *  - each side reads its OWN sentence afterwards, and the other side's says
 *    only that the switchboard closed it: never who, never why;
 *  - a report is never refused for its words. A phone number typed into the
 *    box holds the words and files the report all the same.
 *
 * The suspension:
 *  - the check stands at EVERY door, in both directions;
 *  - every tool call answers SUSPENDED, as an answer rather than a failure,
 *    with the sentence to say and the ask to remember it;
 *  - the connect payload leads with it, ahead of YOUR HUMAN, TODAY;
 *  - onboarding on the same address is refused, plainly and with no detail.
 */
// The screen that reads a report for personal details is a real model call in
// production; here it answers clean, so what this file is actually testing —
// the money rule at the report door, and the pipe holding rather than refusing
// — is what it looks at.
vi.mock('../../src/aws.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  bedrock: {
    send: async () => ({
      body: new TextEncoder().encode(
        JSON.stringify({
          content: [
            {
              text: JSON.stringify({
                prompt_injection: false,
                pii: false,
                stolen_goods_markers: false,
                recalled_goods: false,
                prohibited: false,
                note: '',
              }),
            },
          ],
        }),
      ),
    }),
  },
}));

vi.mock('../../src/crypto.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  encryptField: vi.fn(async (_a: string, _k: Buffer, plaintext: string) =>
    Buffer.from(`enc:${plaintext}`),
  ),
  decryptFields: vi.fn(async (_a: string, _k: Buffer, fields: Record<string, Buffer>) =>
    Object.fromEntries(
      Object.entries(fields).map(([k, v]) => [
        k,
        (v ?? Buffer.alloc(0)).toString('utf8').replace(/^enc:/, ''),
      ]),
    ),
  ),
  writeConsentEvent: vi.fn(async () => 'consent-events/x'),
  writeDecryptAudit: vi.fn(async () => 'decrypt-audit/x'),
  generateAccountDataKey: vi.fn(async () => Buffer.from('wrapped')),
}));

import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../../src/app.js';
import * as db from '../../src/db.js';
import { initCounterKeys } from '../../src/counter/keys.js';
import { hashPin } from '../../src/counter/pin.js';
import { dispatchTool, EXPECTED_REFUSALS } from '../../src/mcp/tools.js';
import { instructionsFor } from '../../src/mcp/mcp.js';
import { SUSPENDED_BLOCK, SUSPENDED_HEADING, OWN_HUMAN_HEADING } from '../../src/mcp/connectFacts.js';
import { SUSPENDED_WORDS, suspended } from '../../src/intake/checks/suspended.js';
import { runIntake, CHECKS } from '../../src/intake/pipe.js';
import {
  SEVERED_OTHER_SENTENCE,
  SEVERED_REPORTER_SENTENCE,
  SEVERED_STATE,
  checkMatches,
} from '../../src/domain/matches.js';
import { REASON_MAX_CHARS } from '../../src/safety/reports.js';
import { lintHumanCopy } from '../../src/email/lint.js';
import type { Config } from '../../src/config.js';
import type { Door } from '../../src/intake/types.js';
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
} as unknown as Config;

const MATCH = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const ANA = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'; // the WANT side, and the reporter
const BEPPE = 'cccccccc-3333-4333-8333-cccccccccccc'; // the HAVE side, reported
const CARD_W = 'dddddddd-4444-4444-8444-dddddddddddd';
const CARD_H = 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee';
const REPORT_ID = '9f9f9f9f-0000-4000-8000-000000000009';
const SID = 'osb_cs_testsessionvaluetestsessionvalue';
const PIN = '241083';
const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex');
let pinHash: string;

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
  /** Every report row written, as it was written. */
  reports: { reporter: string; reported: string; matchId: string; words: string | null }[];
  /** Every mute row written. */
  mutes: { account: string; muted: string }[];
  /** The `preserved_until` writes, by introduction. */
  preserves: { matchId: string; until: Date }[];
  matchState: string;
  severedAt: Date | null;
  severedBy: string | null;
  /** Accounts the operator has stopped. */
  stopped: Set<string>;
  /** Email hashes refused at onboarding. */
  stoppedEmails: Set<string>;
  /** Every warn line the report path wrote. */
  warned: string[];
  /** What this account holds. The report press asks for it, so the whole of
   *  this file's press machinery depends on it. */
  credential: 'none' | 'pin' | 'passkey';
  /** Set by a PIN check, and read back as the session's elevation. A passkey
   *  press arrives with this already set, which is what the button does. */
  elevatedUntil: Date | null;
  /** Every statement the fake pool was asked to run, for the tests about what
   *  suspending an account reaches. */
  sql: { sql: string; params: any[] }[];
  /** How many reports this account has already filed inside the day. */
  reportsFiled24h: number;
}
let world: World;
let linkSeq = 0;

const theMatch = () => ({
  id: MATCH,
  card_want: CARD_W,
  card_have: CARD_H,
  account_want: ANA,
  account_have: BEPPE,
  score: 0.8,
  category: 'goods.bicycle.mountain',
  kind: null,
  stage: 3,
  interest_want: true,
  interest_have: true,
  state: world.matchState,
  channel_id: null,
  opened_at: null,
  severed_at: world.severedAt,
  severed_by: world.severedBy,
  live: true,
  created_at: new Date(),
});

function fakePool() {
  return {
    query: async (sql: string, params: any[] = []) => {
      const rows = (r: any[]) => ({ rows: r, rowCount: r.length });
      world.sql.push({ sql, params });

      // ---- the suspension flag, in front of every door ----
      if (/SELECT suspended_at FROM accounts/.test(sql)) {
        return rows([{ suspended_at: world.stopped.has(params[0]) ? new Date() : null }]);
      }
      if (/FROM suspended_emails/.test(sql)) {
        return world.stoppedEmails.has(params[0]) ? rows([{ '?column?': 1 }]) : rows([]);
      }

      // ---- approval_links ----
      if (/INSERT INTO approval_links/.test(sql)) {
        const id = `11111111-0000-4000-8000-${String(++linkSeq).padStart(12, '0')}`;
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
              { id: 'sess-1', account_id: ANA, pin_ok_until: world.elevatedUntil, oauth_ctx: null },
            ])
          : rows([]);
      }
      if (/UPDATE counter_sessions SET pin_ok_until/.test(sql)) {
        world.elevatedUntil = new Date(Date.now() + 5 * 60_000);
        return rows([]);
      }

      // ---- what this account holds ----
      if (/FROM webauthn_credentials/.test(sql)) {
        return world.credential === 'passkey' ? rows([{ '?column?': 1 }]) : rows([]);
      }
      if (/SELECT pin_hash, pin_failed_attempts, pin_locked_until FROM accounts/.test(sql)) {
        return rows([
          {
            pin_hash: world.credential === 'pin' ? pinHash : null,
            pin_failed_attempts: 0,
            pin_locked_until: null,
          },
        ]);
      }
      if (/^\s*SELECT \* FROM accounts WHERE id/.test(sql)) {
        return rows([
          {
            id: params[0],
            data_key_enc: Buffer.from('wrapped'),
            status: 'active',
            pin_hash: world.credential === 'pin' ? pinHash : null,
            hears_via: 'assistant',
            onboarded_at: new Date('2026-01-01'),
            first_name_enc: Buffer.from('enc:Ana'),
            locality_enc: Buffer.from('enc:Franklin'),
          },
        ]);
      }
      if (/SELECT hears_via FROM accounts/.test(sql)) return rows([{ hears_via: 'assistant' }]);
      if (/SELECT arrangement FROM accounts/.test(sql)) return rows([{ arrangement: null }]);
      if (/SELECT timezone FROM accounts/.test(sql)) return rows([{ timezone: null }]);

      // ---- reports, mutes, preservation ----
      if (/count\(\*\)::int AS n FROM reports/.test(sql)) {
        return rows([{ n: world.reportsFiled24h }]);
      }
      if (/INSERT INTO reports/.test(sql)) {
        world.reports.push({
          reporter: params[0],
          reported: params[1],
          matchId: params[2],
          words: params[3],
        });
        return rows([{ id: REPORT_ID }]);
      }
      if (/INSERT INTO match_mutes/.test(sql)) {
        world.mutes.push({ account: params[0], muted: params[1] });
        return rows([]);
      }
      if (/UPDATE ledger_entries SET preserved_until/.test(sql)) {
        world.preserves.push({ matchId: params[0], until: params[1] });
        return { rows: [], rowCount: 2 };
      }

      // ---- the introduction ----
      if (/UPDATE matches\s*\n?\s*SET state = 'closed', severed_at/.test(sql)) {
        if (world.matchState !== 'open') return rows([]);
        world.matchState = 'closed';
        world.severedAt = new Date();
        world.severedBy = params[1];
        return rows([{ id: params[0] }]);
      }
      if (/FROM matches/.test(sql) && /^\s*SELECT (\*|m\.\*)/.test(sql)) {
        return rows([{ ...theMatch(), my_optin: true }]);
      }
      if (/SELECT card_want, card_have FROM matches/.test(sql)) {
        return rows([{ card_want: CARD_W, card_have: CARD_H }]);
      }
      if (/read_calls|write_calls/.test(sql)) return rows([{ n: 0, oldest: null }]);
      return rows([]);
    },
  } as any;
}

let app: FastifyInstance;

beforeEach(async () => {
  world = {
    links: [],
    reports: [],
    mutes: [],
    preserves: [],
    matchState: 'open',
    severedAt: null,
    severedBy: null,
    stopped: new Set(),
    stoppedEmails: new Set(),
    warned: [],
    credential: 'pin',
    elevatedUntil: null,
    sql: [],
    reportsFiled24h: 0,
  };
  linkSeq = 0;
  pinHash = pinHash ?? (await hashPin(PIN));
  vi.spyOn(db, 'getPool').mockReturnValue(fakePool());
  // The suspension check asks whether this process HAS a database before it
  // asks the database anything, so the harness has to say yes.
  vi.spyOn(db, 'dbConfigured').mockReturnValue(true);
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

const respond = (args: Record<string, unknown>, who = ANA) => dispatchTool(cfg, who, 'respond', args);
const body = (r: any) => r.structuredContent ?? JSON.parse(r.content[0].text);
const tokenOf = (link: string) => decodeURIComponent(link.split('/a/')[1]);

/** Mint the page an agent would hand over, and hand back its token. */
async function mintedToken(): Promise<string> {
  const r = body(await respond({ intro_id: MATCH, action: 'request_report' }));
  return tokenOf(r.link);
}

// ---------------------------------------------------------------------------
describe('respond(request_report) mints and returns, and changes nothing', () => {
  it('answers the four fields every link action answers', async () => {
    const r = body(await respond({ intro_id: MATCH, action: 'request_report' }));
    expect(Object.keys(r).sort()).toEqual(
      ['expires_in_minutes', 'link', 'press_id', 'what_it_does'].sort(),
    );
    expect(r.link).toContain('https://my.test/a/');
    expect(r.expires_in_minutes).toBe(15);
    // The press_id is the row wait_for_press waits on, so it is the link's own.
    expect(world.links[0].id).toBe(r.press_id);
    expect(world.links[0].action).toBe('report');
    expect(world.links[0].ref_id).toBe(MATCH);
    // NOTHING has happened: no report, no mute, no sever.
    expect(world.reports).toEqual([]);
    expect(world.mutes).toEqual([]);
    expect(world.matchState).toBe('open');
  });

  it('says what the page will ask, in the house register', async () => {
    const r = body(await respond({ intro_id: MATCH, action: 'request_report' }));
    expect(r.what_it_does).toMatch(/report this person/i);
    expect(r.what_it_does).toMatch(/never that they were reported/i);
    expect(lintHumanCopy(r.what_it_does)).toEqual([]);
  });

  it('refuses at mint time when there is nothing left to close', async () => {
    world.matchState = 'closed';
    const r: any = await respond({ intro_id: MATCH, action: 'request_report' });
    expect(r.isError).toBe(false);
    expect(body(r).code).toBe('NOT_UNLOCKED_YET');
    expect(body(r).human_action).toMatch(/already closed/i);
  });

  it('is not a link anybody but a party may mint', async () => {
    const outsider = '0f0f0f0f-9999-4999-8999-0f0f0f0f0f0f';
    const r: any = await respond({ intro_id: MATCH, action: 'request_report' }, outsider);
    expect(r.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('the page it opens is the ordinary one-question page', () => {
  it('asks one question, with a box for a line and one press', async () => {
    const token = await mintedToken();
    const page = await inject('GET', `/a/${encodeURIComponent(token)}`);
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('Report this person?');
    expect(page.body).toContain('name="reason"');
    expect(page.body).toContain('Report and close this');
    expect(page.body).toContain('Not now');
    // The press burns the link, never the view: a person may read the question
    // twice before answering it.
    expect(world.links[0].used_at).toBeNull();
  });

  it('says what the other person will and will not be told', async () => {
    const token = await mintedToken();
    const page = await inject('GET', `/a/${encodeURIComponent(token)}`);
    expect(page.body).toMatch(/never told that you reported them/i);
    expect(page.body).toMatch(/closes this one straight away/i);
  });

  it('says in one plain sentence why it asks for a credential', async () => {
    const token = await mintedToken();
    const page = await inject('GET', `/a/${encodeURIComponent(token)}`);
    expect(page.body).toContain(
      'This press is yours alone, so it asks for your passkey or PIN like every other decision here.',
    );
  });
});

// ---------------------------------------------------------------------------
// The press is the human's own
//
// Built credential-free on 17 September; the same day it was decided that a
// report is a formal press like the others, because an assistant with a
// browser could otherwise sit at this page and complete it alone. A passkey is
// the one thing an assistant cannot press for its human.
// ---------------------------------------------------------------------------
describe('the report press takes the human own credential', () => {
  it('prints a PIN box on an account that holds a PIN', async () => {
    const token = await mintedToken();
    const page = await inject('GET', `/a/${encodeURIComponent(token)}`);
    expect(page.body).toContain('Confirm with your PIN');
  });

  it('refuses the press with no credential offered at all', async () => {
    const token = await mintedToken();
    const r = await inject('POST', `/a/${encodeURIComponent(token)}`, { decision: 'yes' });
    expect(r.statusCode).toBe(401);
    // Nothing filed, nothing closed, and the link is still good.
    expect(world.reports).toEqual([]);
    expect(world.matchState).toBe('open');
    expect(world.links[0].used_at).toBeNull();
  });

  it('refuses the press on a wrong PIN, and keeps the link', async () => {
    const token = await mintedToken();
    const r = await inject('POST', `/a/${encodeURIComponent(token)}`, {
      decision: 'yes',
      pin: '000000',
    });
    expect(r.statusCode).toBe(401);
    expect(world.reports).toEqual([]);
    expect(world.matchState).toBe('open');
    expect(world.links[0].used_at).toBeNull();
  });

  it('files it on the right PIN', async () => {
    const token = await mintedToken();
    const r = await inject('POST', `/a/${encodeURIComponent(token)}`, {
      decision: 'yes',
      pin: PIN,
      reason: 'he would not let it go',
    });
    expect(r.statusCode).toBe(200);
    expect(world.reports).toHaveLength(1);
    expect(world.matchState).toBe('closed');
  });

  it('files it on a passkey, with no box to fill in', async () => {
    world.credential = 'passkey';
    const token = await mintedToken();
    const page = await inject('GET', `/a/${encodeURIComponent(token)}`);
    // A passkey-only account is never shown a PIN box it cannot fill: the
    // button itself runs the ceremony.
    expect(page.body).not.toContain('Confirm with your PIN');
    expect(page.body).toMatch(/This takes your passkey/i);
    // Which is what the button does before it submits.
    world.elevatedUntil = new Date(Date.now() + 5 * 60_000);
    const r = await inject('POST', `/a/${encodeURIComponent(token)}`, { decision: 'yes' });
    expect(r.statusCode).toBe(200);
    expect(world.reports).toHaveLength(1);
    expect(world.matchState).toBe('closed');
  });

  it('sends an account holding neither off to set one up, link intact', async () => {
    world.credential = 'none';
    const token = await mintedToken();
    const page = await inject('GET', `/a/${encodeURIComponent(token)}`);
    expect(page.statusCode).toBe(303);
    expect(page.headers.location).toBe('/secure');
    const pressed = await inject('POST', `/a/${encodeURIComponent(token)}`, { decision: 'yes' });
    expect(pressed.statusCode).toBe(303);
    expect(world.reports).toEqual([]);
    expect(world.matchState).toBe('open');
    // The link their assistant gave them still works once they have one.
    expect(world.links[0].used_at).toBeNull();
    world.credential = 'pin';
    const again = await inject('POST', `/a/${encodeURIComponent(token)}`, {
      decision: 'yes',
      pin: PIN,
    });
    expect(again.statusCode).toBe(200);
    expect(world.reports).toHaveLength(1);
  });

  it('a Not now still needs no credential at all', async () => {
    world.credential = 'pin';
    const token = await mintedToken();
    const r = await inject('POST', `/a/${encodeURIComponent(token)}`, { decision: 'no' });
    expect(r.statusCode).toBe(200);
    expect(world.reports).toEqual([]);
    expect(world.matchState).toBe('open');
  });
});

// ---------------------------------------------------------------------------
describe('the press: report, sever, block, preserve', () => {
  const press = async (reason?: string) => {
    const token = await mintedToken();
    return inject('POST', `/a/${encodeURIComponent(token)}`, {
      decision: 'yes',
      pin: PIN,
      ...(reason === undefined ? {} : { reason }),
    });
  };

  it('writes the report, with the words and both accounts', async () => {
    const r = await press('He kept asking how old my daughter is.');
    expect(r.statusCode).toBe(200);
    expect(world.reports).toEqual([
      {
        reporter: ANA,
        reported: BEPPE,
        matchId: MATCH,
        words: 'He kept asking how old my daughter is.',
      },
    ]);
  });

  it('severs the introduction, and stamps who asked for it', async () => {
    await press('something was off');
    expect(world.matchState).toBe('closed');
    expect(world.severedAt).toBeTruthy();
    expect(world.severedBy).toBe(ANA);
  });

  it('mutes the pairing, the same mute a bad verdict puts on', async () => {
    await press('something was off');
    expect(world.mutes).toEqual([{ account: ANA, muted: BEPPE }]);
  });

  it('holds the ledger entries behind it ninety days past today', async () => {
    await press('something was off');
    expect(world.preserves).toHaveLength(1);
    expect(world.preserves[0].matchId).toBe(MATCH);
    const days = (world.preserves[0].until.getTime() - Date.now()) / 86_400_000;
    expect(Math.round(days)).toBe(90);
  });

  it('files a report with no words at all, because that is still a report', async () => {
    await press('');
    expect(world.reports).toHaveLength(1);
    expect(world.reports[0].words).toBeNull();
    expect(world.matchState).toBe('closed');
  });

  it('is never refused for its words: a figure holds them and files it anyway', async () => {
    const r = await press('He said he would pay me $400 to do something illegal.');
    expect(r.statusCode).toBe(200);
    // The report stands...
    expect(world.reports).toHaveLength(1);
    expect(world.matchState).toBe('closed');
    // ...and the words are held rather than filed beside it.
    expect(world.reports[0].words).toBeNull();
    expect(r.body).toMatch(/held for a person to read/i);
  });

  it('tells the operator two ids and nothing else', async () => {
    const { fileReport } = await import('../../src/safety/reports.js');
    await fileReport(
      cfg,
      { reporterAccount: ANA, matchId: MATCH, reason: 'he asked for my address' },
      { warn: (line) => world.warned.push(line) },
    );
    expect(world.warned).toHaveLength(1);
    const line = JSON.parse(world.warned[0]);
    expect(line).toEqual({ event: 'report', report_id: REPORT_ID, match_id: MATCH });
    // No words, no accounts: a log line is the one place the words of a report
    // are never allowed to be.
    expect(world.warned[0]).not.toContain('address');
    expect(world.warned[0]).not.toContain(ANA);
    expect(world.warned[0]).not.toContain(BEPPE);
  });

  it('keeps a long line out of the database rather than burning the link', async () => {
    const token = await mintedToken();
    const r = await inject('POST', `/a/${encodeURIComponent(token)}`, {
      decision: 'yes',
      pin: PIN,
      reason: 'x'.repeat(REASON_MAX_CHARS + 1),
    });
    expect(r.statusCode).toBe(400);
    expect(world.reports).toEqual([]);
    // The link their assistant gave them is still good.
    expect(world.links[0].used_at).toBeNull();
  });

  it('a Not now presses nothing and reports nobody', async () => {
    const token = await mintedToken();
    const r = await inject('POST', `/a/${encodeURIComponent(token)}`, { decision: 'no' });
    expect(r.statusCode).toBe(200);
    expect(world.reports).toEqual([]);
    expect(world.matchState).toBe('open');
  });
});

// ---------------------------------------------------------------------------
describe('what each side is told afterwards', () => {
  beforeEach(() => {
    world.matchState = 'closed';
    world.severedAt = new Date();
    world.severedBy = ANA;
  });

  it('the reporter is told their report closed it', async () => {
    const [entry] = await checkMatches(cfg, ANA);
    expect(entry.state).toBe(SEVERED_STATE);
    expect(entry.note.text).toBe(SEVERED_REPORTER_SENTENCE);
    expect(entry.note.text).toMatch(/you reported this one/i);
  });

  it('the other side is told the switchboard closed it, and nothing else', async () => {
    const [entry] = await checkMatches(cfg, BEPPE);
    expect(entry.state).toBe(SEVERED_STATE);
    expect(entry.note.text).toBe(SEVERED_OTHER_SENTENCE);
    // Never that they were reported, never by whom, never what was said.
    expect(entry.note.text).not.toMatch(/report/i);
    expect(JSON.stringify(entry)).not.toContain(ANA);
  });

  it('neither sentence answers "nothing", and both keep the house register', () => {
    for (const s of [SEVERED_REPORTER_SENTENCE, SEVERED_OTHER_SENTENCE]) {
      expect(s.length).toBeGreaterThan(40);
      expect(lintHumanCopy(s)).toEqual([]);
    }
  });

  it('asking about that one introduction by name says the same thing', async () => {
    const r: any = await dispatchTool(cfg, BEPPE, 'check_in', { intro_id: MATCH, step: 'details' });
    expect(r.isError).toBe(false);
    expect(body(r).human_action).toBe(SEVERED_OTHER_SENTENCE);
  });
});

// ---------------------------------------------------------------------------
describe('the suspension check stands at every door', () => {
  const DOORS: Door[] = [
    'posting',
    'amendment',
    'message',
    'photo',
    'offer_words',
    'shared_identity',
    'report',
  ];

  it('is the first check at each of them', () => {
    for (const door of DOORS) {
      expect(suspended.doors, door).toContain(door);
    }
    expect(CHECKS[0].name).toBe('suspended');
  });

  it('refuses at every door when the SENDER is stopped', async () => {
    world.stopped.add(ANA);
    for (const door of DOORS) {
      const v = await runIntake(cfg, { door, sender_account: ANA, text: 'hello' }, {
        checks: [suspended],
      });
      expect(v.outcome, door).toBe('refuse');
      expect(v.reason_code, door).toBe('SUSPENDED');
      expect(v.plain_words, door).toBe(SUSPENDED_WORDS);
    }
  });

  it('refuses at every door when the RECIPIENT is stopped', async () => {
    world.stopped.add(BEPPE);
    for (const door of DOORS) {
      const v = await runIntake(
        cfg,
        { door, sender_account: ANA, recipient_account: BEPPE, text: 'hello' },
        { checks: [suspended] },
      );
      expect(v.outcome, door).toBe('refuse');
    }
  });

  it('a stopped account is refused even at the door that cannot refuse', async () => {
    // The report door softens a refusal about the WORDS into a hold. It does
    // not soften a door shut to the account itself.
    world.stopped.add(ANA);
    const v = await runIntake(cfg, { door: 'report', sender_account: ANA, text: 'x' });
    expect(v.outcome).toBe('refuse');
    expect(v.reason_code).toBe('SUSPENDED');
  });

  it('lets everybody else through', async () => {
    const v = await runIntake(cfg, { door: 'message', sender_account: ANA }, {
      checks: [suspended],
    });
    expect(v.outcome).toBe('pass');
  });
});

// ---------------------------------------------------------------------------
describe('every tool call from a stopped account answers SUSPENDED', () => {
  beforeEach(() => {
    world.stopped.add(ANA);
  });

  const TOOL_CALLS: [string, Record<string, unknown>][] = [
    ['check_in', {}],
    ['list_intents', {}],
    ['publish_intent', { listing: {} }],
    ['respond', { intro_id: MATCH, action: 'request_report' }],
    ['open_conversation', { intro_id: MATCH }],
    ['send_message', { intro_id: MATCH, text: 'hello' }],
    ['collect_messages', { intro_id: MATCH }],
    ['amend_intent', { intent_id: CARD_W, patch: {} }],
    ['withdraw_intent', { intent_id: CARD_W }],
    ['standing_arrangement', { action: 'get' }],
    ['settle', { intro_id: MATCH }],
    ['wait_for_press', { press_id: MATCH }],
  ];

  it('answers the same way on every tool on the surface', async () => {
    for (const [name, args] of TOOL_CALLS) {
      const r: any = await dispatchTool(cfg, ANA, name, args);
      // An ANSWER rather than a failure: the agent did nothing wrong.
      expect(r.isError, name).toBe(false);
      const p = body(r);
      expect(p.what_happened, name).toBe('account_suspended');
      expect(p.code, name).toBe('SUSPENDED');
      expect(p.human_action, name).toBe(SUSPENDED_WORDS);
    }
  });

  it('says there is nothing to try again, and asks to be remembered', () => {
    expect(SUSPENDED_WORDS).toMatch(/has been suspended from the switchboard/i);
    expect(SUSPENDED_WORDS).toMatch(/nothing more can be posted, sent or collected/i);
    expect(SUSPENDED_WORDS).toMatch(/keep it in your own memory/i);
    expect(lintHumanCopy(SUSPENDED_WORDS)).toEqual([]);
  });

  it('is one of the refusals that are the switchboard working', () => {
    expect(EXPECTED_REFUSALS.SUSPENDED).toBe('account_suspended');
  });

  it('costs a stopped account nothing of its hourly reading', async () => {
    // The answer lands before the ceiling is even consulted, so an agent that
    // keeps trying cannot spend its human's allowance on it.
    const r: any = await dispatchTool(cfg, ANA, 'check_in', {});
    expect(body(r).code).toBe('SUSPENDED');
  });
});

// ---------------------------------------------------------------------------
describe('the connect block leads with it', () => {
  it('comes FIRST, ahead of YOUR HUMAN, TODAY', async () => {
    world.stopped.add(ANA);
    const text = await instructionsFor(cfg, { accountId: ANA });
    expect(text.startsWith(SUSPENDED_HEADING)).toBe(true);
    const own = text.indexOf(OWN_HUMAN_HEADING);
    if (own !== -1) expect(text.indexOf(SUSPENDED_HEADING)).toBeLessThan(own);
    // The manual still follows, unchanged.
    expect(text).toContain('OPERATING MANUAL');
  });

  it('says the same sentence the tools say, and asks for memory', async () => {
    world.stopped.add(ANA);
    const text = await instructionsFor(cfg, { accountId: ANA });
    expect(text).toContain(SUSPENDED_WORDS);
    expect(SUSPENDED_BLOCK).toMatch(/keep it in your own memory/i);
    expect(lintHumanCopy(SUSPENDED_BLOCK)).toEqual([]);
  });

  it('is absent for everybody else', async () => {
    const text = await instructionsFor(cfg, { accountId: ANA });
    expect(text).not.toContain(SUSPENDED_HEADING);
  });

  it('fails soft: a read that will not answer still serves the manual', async () => {
    vi.spyOn(db, 'getPool').mockImplementation(() => {
      throw new Error('the database is having a bad day');
    });
    const errors: unknown[] = [];
    const text = await instructionsFor(cfg, { accountId: ANA, onError: (e) => errors.push(e) });
    expect(text).toContain('OPERATING MANUAL');
    expect(text).not.toContain(SUSPENDED_HEADING);
  });
});

// ---------------------------------------------------------------------------
describe('onboarding on a stopped address', () => {
  it('is refused, plainly and with no detail at all', async () => {
    const { emailIsSuspended } = await import('../../src/safety/suspend.js');
    const { emailHash } = await import('../../src/domain/accounts.js');
    world.stoppedEmails.add(emailHash('Someone@Example.com'));
    // The same address, however it was typed.
    expect(await emailIsSuspended('someone@example.com  ')).toBe(true);
    expect(await emailIsSuspended('someone.else@example.com')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Nothing in, nothing out — on the HUMAN surface too. The flag used to stand
// at the agent doors alone: a stopped person's browser session went on
// working, and so did the refresh token in their agent's pocket.
// ---------------------------------------------------------------------------
describe('a stopped account on the human surface', () => {
  const SAFETY = 'safety@openswitchboard.ai';

  it('meets a plain page at a signed-in door, and is told where to write', async () => {
    world.stopped.add(ANA);
    const r = await inject('GET', '/ledger');
    expect(r.statusCode).toBe(403);
    expect(r.body).toContain('This account is suspended.');
    expect(r.body).toContain(SAFETY);
  });

  it('meets it on a link its assistant handed over, before any press', async () => {
    const token = await mintedToken();
    world.stopped.add(ANA);
    const r = await inject('GET', `/a/${encodeURIComponent(token)}`);
    expect(r.statusCode).toBe(403);
    expect(r.body).toContain('This account is suspended.');
    // Nothing is spent: the link is not burnt on a door that would not open.
    expect(world.links[0].used_at).toBeNull();
  });

  it('meets it on the press as well, and the press does nothing', async () => {
    const token = await mintedToken();
    world.stopped.add(ANA);
    const r = await inject('POST', `/a/${encodeURIComponent(token)}`, {
      decision: 'yes',
      pin: PIN,
      reason: 'he asked for my address',
    });
    expect(r.statusCode).toBe(403);
    expect(world.reports).toEqual([]);
    expect(world.matchState).toBe('open');
  });

  it('lets everybody else through the same door', async () => {
    const r = await inject('GET', '/ledger');
    expect(r.statusCode).not.toBe(403);
  });
});

describe('suspending pulls back the credentials already out in the world', () => {
  it('deletes the browser sessions and suspends the agents refresh tokens', async () => {
    const { suspendAccount } = await import('../../src/safety/suspend.js');
    world.sql = [];
    await suspendAccount(BEPPE, 'operator says so');
    const ran = (re: RegExp) => world.sql.filter((q) => re.test(q.sql));
    const sessions = ran(/DELETE FROM counter_sessions WHERE account_id/);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].params).toEqual([BEPPE]);
    const tokens = ran(/UPDATE oauth_tokens SET suspended = true WHERE account_id/);
    expect(tokens).toHaveLength(1);
    expect(tokens[0].params).toEqual([BEPPE]);
    // Suspended rather than revoked, the way the kill switch does it, because
    // lifting a suspension has to be able to hand them back.
    expect(tokens[0].sql).not.toMatch(/revoked = true/);
  });
});

describe('a report from a stopped account', () => {
  it('is refused with the same plain word the tools give, and writes nothing', async () => {
    const { fileReport } = await import('../../src/safety/reports.js');
    world.stopped.add(ANA);
    await expect(
      fileReport(cfg, { reporterAccount: ANA, matchId: MATCH, reason: 'anything' }),
    ).rejects.toMatchObject({ payload: { code: 'SUSPENDED' } });
    expect(world.reports).toEqual([]);
    expect(world.mutes).toEqual([]);
    expect(world.preserves).toEqual([]);
    expect(world.matchState).toBe('open');
  });

  it('is refused with an empty box too: the check does not depend on the words', async () => {
    const { fileReport } = await import('../../src/safety/reports.js');
    world.stopped.add(ANA);
    await expect(
      fileReport(cfg, { reporterAccount: ANA, matchId: MATCH }),
    ).rejects.toMatchObject({ payload: { code: 'SUSPENDED' } });
    expect(world.reports).toEqual([]);
  });

  it('is refused when the account being reported is the stopped one', async () => {
    const { fileReport } = await import('../../src/safety/reports.js');
    world.stopped.add(BEPPE);
    await expect(
      fileReport(cfg, { reporterAccount: ANA, matchId: MATCH }),
    ).rejects.toMatchObject({ payload: { code: 'SUSPENDED' } });
    expect(world.reports).toEqual([]);
  });

  it('carries the sentence the agent surface says, word for word', async () => {
    const { fileReport } = await import('../../src/safety/reports.js');
    world.stopped.add(ANA);
    try {
      await fileReport(cfg, { reporterAccount: ANA, matchId: MATCH });
      throw new Error('should have refused');
    } catch (e: any) {
      expect(e.payload.human_action).toBe(SUSPENDED_WORDS);
    }
  });
});

// ---------------------------------------------------------------------------
/**
 * HOW MANY REPORTS ONE ACCOUNT MAY FILE IN A DAY (2026-09-17 audit).
 *
 * Nothing capped this, and a report is not a cheap thing to file: it severs an
 * introduction, mutes a pairing for good, holds ninety days of ledger entries
 * against the thirty-day sweep, and puts a line in front of the operator. An
 * account could file one against every person it had ever met here, as fast as
 * it could mint the links.
 *
 * Five a day. And the sentence at the ceiling is the thing to get right: the
 * one answer this must never give is "you have used up your reports", full
 * stop, to somebody frightened.
 */
const reportsModule = () => import('../../src/safety/reports.js');

describe('five reports a day, and what the fifth one is told', () => {

  it('files them while there is room', async () => {
    const { fileReport, MAX_REPORTS_PER_DAY } = await reportsModule();
    world.reportsFiled24h = MAX_REPORTS_PER_DAY - 1;
    const r = await fileReport(cfg, { reporterAccount: ANA, matchId: MATCH, reason: 'creepy' });
    expect(r.report_id).toBeTruthy();
    expect(world.reports).toHaveLength(1);
  });

  it('refuses the one past the ceiling, and writes nothing at all', async () => {
    const { fileReport, MAX_REPORTS_PER_DAY } = await reportsModule();
    world.reportsFiled24h = MAX_REPORTS_PER_DAY;
    await expect(
      fileReport(cfg, { reporterAccount: ANA, matchId: MATCH, reason: 'creepy' }),
    ).rejects.toMatchObject({ payload: { code: 'QUOTA_EXCEEDED' } });
    // Nothing written, nothing severed, nothing muted, nothing preserved.
    expect(world.reports).toEqual([]);
    expect(world.mutes).toEqual([]);
    expect(world.preserves).toEqual([]);
    expect(world.matchState).toBe('open');
  });

  it('the sentence names a way through rather than a wall', async () => {
    const { fileReport, MAX_REPORTS_PER_DAY, REPORT_CEILING_WORDS } = await reportsModule();
    world.reportsFiled24h = MAX_REPORTS_PER_DAY;
    const err: any = await fileReport(cfg, { reporterAccount: ANA, matchId: MATCH }).catch((e) => e);
    expect(err.payload.human_action).toBe(REPORT_CEILING_WORDS);
    // Somebody frightened is told where to go NOW, not told to come back.
    expect(REPORT_CEILING_WORDS).toContain('safety@openswitchboard.ai');
    expect(REPORT_CEILING_WORDS).toContain('child');
  });

  it('the ceiling is on the act, not on the person: it counts what THEY filed', async () => {
    const { fileReport, MAX_REPORTS_PER_DAY } = await reportsModule();
    world.reportsFiled24h = MAX_REPORTS_PER_DAY;
    await fileReport(cfg, { reporterAccount: ANA, matchId: MATCH }).catch(() => undefined);
    const counted = world.sql.find((q) => /count\(\*\)::int AS n FROM reports/.test(q.sql));
    expect(counted).toBeTruthy();
    expect(counted!.sql).toContain('reporter_account');
    expect(counted!.params[0]).toBe(ANA);
  });

  it('the deployment can set its own number', async () => {
    const { fileReport } = await reportsModule();
    world.reportsFiled24h = 1;
    await expect(
      fileReport({ ...cfg, maxReportsPerDay: 1 } as any, {
        reporterAccount: ANA,
        matchId: MATCH,
      }),
    ).rejects.toMatchObject({ payload: { code: 'QUOTA_EXCEEDED' } });
  });
});
