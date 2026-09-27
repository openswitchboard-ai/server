/**
 * Every open request on the main page, and what a link says once it has run
 * out (27 September 2026).
 *
 * A photo page an assistant handed over was nowhere on the person's main page,
 * so once the chat it came in was gone they had nothing to press. What is
 * asserted here:
 *
 *  - every open, unexpired link of this account is listed once per question,
 *    in plain words that pass the copy lint, with a button through the session
 *    (GET /open/:id) and no token in the page;
 *  - /open/:id opens only this account's own live link, and sends it on to
 *    the page the link itself opens;
 *  - a link that has run out says so in one line, and offers the main page;
 *  - a collected photo's short link (/p/:token) redirects to the signed
 *    address, and says plainly when it has run out.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn(async (_client: unknown, command: any, opts: any) =>
    `https://bucket.test/${encodeURIComponent(command.input.Key)}?X-Amz-Expires=${opts?.expiresIn}`,
  ),
}));

import * as db from '../../src/db.js';
import { buildApp } from '../../src/app.js';
import { initCounterKeys } from '../../src/counter/keys.js';
import {
  OPENABLE_ACTIONS,
  openLinkFor,
  openLinksFor,
  signLink,
} from '../../src/counter/links.js';
import { OPEN_REQUEST_CTA, dashboardPage, openRequestLabel } from '../../src/counter/pagesHome.js';
import { FRESH_LINK_ON_MAIN_PAGE, linkDeadPage, photoLinkDeadPage } from '../../src/counter/pages.js';
import { lintHumanCopy } from '../../src/email/lint.js';
import type { Config } from '../../src/config.js';

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
  quotas: { maxOpenCards: 20, maxPublishesPerDay: 20, maxOffersPerHour: 6 },
  docsBase: 'https://openswitchboard.ai/docs',
  settlementFeePercent: 0,
  settlementFeeFlatMinor: 100,
  photoBucket: 'osb-dev-conversation-photos',
} as unknown as Config;

const ANA = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const BEPPE = 'cccccccc-3333-4333-8333-cccccccccccc';
const MATCH = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const SID = 'osb_cs_testsessionvaluetestsessionvalue';
const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex');

interface LinkRow {
  id: string;
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
  category: string | null;
}

let links: LinkRow[];
let photos: { view_token_hash: string; s3_key: string; collected_at: Date }[];

const link = (over: Partial<LinkRow> = {}): LinkRow => ({
  id: randomUUID(),
  account_id: ANA,
  action: 'conversation-photo',
  ref_id: MATCH,
  amount: null,
  ccy: null,
  counterparty_account: BEPPE,
  payload: null,
  created_at: new Date(),
  expires_at: new Date(Date.now() + 10 * 60_000),
  used_at: null,
  decision: null,
  category: 'goods.bicycle.mountain',
  ...over,
});

function fakePool() {
  const rows = (r: any[]) => ({ rows: r, rowCount: r.length });
  return {
    query: async (sql: string, params: any[] = []) => {
      if (/FROM counter_sessions/.test(sql) && /SELECT id, account_id/.test(sql)) {
        return params[0] === sha256hex(SID)
          ? rows([{ id: 'sess-1', account_id: ANA, pin_ok_until: null, oauth_ctx: null }])
          : rows([]);
      }
      if (/suspended_at|FROM suspensions|account_suspensions/.test(sql)) return rows([]);
      if (/FROM approval_links a/.test(sql)) {
        const live = links
          .filter(
            (l) =>
              l.account_id === params[0] &&
              !l.used_at &&
              l.expires_at.getTime() > Date.now() &&
              (params[1] as string[]).includes(l.action),
          )
          .sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
        return rows(live);
      }
      if (/SELECT \* FROM approval_links WHERE id = \$1 AND account_id = \$2/.test(sql)) {
        return rows(links.filter((l) => l.id === params[0] && l.account_id === params[1]));
      }
      if (/FROM conversation_photos\s+WHERE view_token_hash = \$1/.test(sql)) {
        const windowMs = Number(params[1]) * 1000;
        const p = photos.find(
          (x) => x.view_token_hash === params[0] && x.collected_at.getTime() > Date.now() - windowMs,
        );
        if (!p) return rows([]);
        return rows([
          {
            s3_key: p.s3_key,
            left_s: Math.ceil((p.collected_at.getTime() + windowMs - Date.now()) / 1000),
          },
        ]);
      }
      return rows([]);
    },
  } as any;
}

let app: FastifyInstance;

beforeAll(async () => {
  process.env.COUNTER_LINK_HMAC_KEY = 'a'.repeat(64);
  process.env.COUNTER_COOKIE_KEY = 'b'.repeat(64);
  await initCounterKeys(cfg);
  app = buildApp(cfg);
  await app.ready();
});

beforeEach(() => {
  links = [];
  photos = [];
  vi.spyOn(db, 'getPool').mockReturnValue(fakePool());
});

const get = (url: string, signedIn = true) =>
  app.inject({
    method: 'GET',
    url,
    headers: { host: 'my.test', ...(signedIn ? { cookie: `osb_counter=${SID}` } : {}) },
  });

// ---------------------------------------------------------------------------
describe('the words on the main page', () => {
  it('has one plain line for every kind of open request, with and without a shelf', () => {
    for (const action of OPENABLE_ACTIONS) {
      for (const thing of ['mountain bike', undefined]) {
        const line = openRequestLabel(action, thing);
        expect(line.length, action).toBeGreaterThan(5);
        expect(lintHumanCopy(line), `${action}: ${line}`).toEqual([]);
        expect(line).not.toMatch(/undefined|null/);
      }
    }
    expect(openRequestLabel('conversation-photo', 'mountain bike')).toBe(
      'Send a photo on your mountain bike match',
    );
    expect(lintHumanCopy(OPEN_REQUEST_CTA)).toEqual([]);
  });

  it('renders the request as a button through the session, with no token in it', () => {
    const row = link();
    const token = signLink(row);
    const page = dashboardPage({
      killSwitchOn: false,
      cardCounts: { total: 1, published: 1, pending: 0 },
      pendingApprovals: [
        {
          href: `/open/${row.id}`,
          label: openRequestLabel(row.action, 'mountain bike'),
          cta: OPEN_REQUEST_CTA,
        },
      ],
    });
    expect(page).toContain(`href="/open/${row.id}"`);
    expect(page).toContain('Send a photo on your mountain bike match');
    expect(page).not.toContain(token.split('.')[1]);
    expect(page).not.toContain('/a/');
  });
});

// ---------------------------------------------------------------------------
describe('which requests are open', () => {
  it('lists each open question once, newest first, and nothing spent or run out', async () => {
    const older = link({ created_at: new Date(Date.now() - 60_000) });
    const newer = link({ created_at: new Date() });
    const names = link({ action: 'stage3-disclosure', created_at: new Date(Date.now() - 30_000) });
    const spent = link({ action: 'conversation-renew', used_at: new Date() });
    const runOut = link({ action: 'report', expires_at: new Date(Date.now() - 1000) });
    const theirs = link({ account_id: BEPPE, action: 'offer-send' });
    links = [older, newer, names, spent, runOut, theirs];
    const open = await openLinksFor(ANA);
    expect(open.map((l) => l.id)).toEqual([newer.id, names.id]);
  });

  it('finds this account\'s own live link, and nobody else\'s', async () => {
    const mine = link();
    links = [mine];
    expect(await openLinkFor(ANA, mine.id)).toBe(signLink(mine));
    expect(await openLinkFor(BEPPE, mine.id)).toBeUndefined();
  });

  it('says why a link cannot be opened any more', async () => {
    const used = link({ used_at: new Date() });
    const runOut = link({ expires_at: new Date(Date.now() - 1000) });
    const settlement = link({ action: 'settlement-approve' });
    links = [used, runOut, settlement];
    expect(await openLinkFor(ANA, used.id)).toBe('used');
    expect(await openLinkFor(ANA, runOut.id)).toBe('expired');
    // A settlement approval has its own row on the main page already.
    expect(await openLinkFor(ANA, settlement.id)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
describe('opening one from the main page', () => {
  it('sends the signed-in owner on to the page the link opens', async () => {
    const mine = link();
    links = [mine];
    const r = await get(`/open/${mine.id}`);
    expect(r.statusCode).toBe(303);
    expect(r.headers.location).toBe(`/a/${encodeURIComponent(signLink(mine))}`);
    expect(String(r.headers['cache-control'])).toContain('no-store');
  });

  it('asks a person who is not signed in to sign in', async () => {
    const mine = link();
    links = [mine];
    const r = await get(`/open/${mine.id}`, false);
    expect(r.statusCode).toBe(303);
    expect(r.headers.location).toBe('/login');
  });

  it('finds nothing for somebody else\'s link', async () => {
    const theirs = link({ account_id: BEPPE });
    links = [theirs];
    const r = await get(`/open/${theirs.id}`);
    expect(r.statusCode).toBe(404);
    expect(r.headers.location).toBeUndefined();
  });

  it('says a link has run out, in one line, and offers the main page', async () => {
    const runOut = link({ expires_at: new Date(Date.now() - 1000) });
    links = [runOut];
    const r = await get(`/open/${runOut.id}`);
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('This link has run out.');
    expect(r.body).toContain('Ask your assistant for a fresh one.');
    expect(r.body).toContain('href="/"');
  });
});

// ---------------------------------------------------------------------------
describe('the page for a link that no longer opens', () => {
  it('says what to do, and points at the main page, for every reason', () => {
    for (const why of ['used', 'expired', 'invalid'] as const) {
      const page = linkDeadPage(why);
      expect(page).toContain('Ask your assistant for a fresh one.');
      expect(page).toContain(FRESH_LINK_ON_MAIN_PAGE);
      expect(page).toContain('href="/"');
      expect(lintHumanCopy(page)).toEqual([]);
    }
    expect(linkDeadPage('expired')).toContain('This link has run out.');
  });
});

// ---------------------------------------------------------------------------
describe('a collected photo\'s short link', () => {
  const TOKEN = 'abcdefghijklmnopqrstuv';

  it('redirects to a freshly signed address, and keeps no copy of it', async () => {
    photos = [
      { view_token_hash: sha256hex(TOKEN), s3_key: 'conversation-photos/dev/ch/x.jpg', collected_at: new Date() },
    ];
    const r = await get(`/p/${TOKEN}`, false);
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toMatch(/^https:\/\/bucket\.test\/conversation-photos/);
    expect(String(r.headers['cache-control'])).toContain('no-store');
    expect(r.headers['referrer-policy']).toBe('no-referrer');
  });

  it('opens for the signed-in recipient and for their assistant alike', async () => {
    photos = [
      { view_token_hash: sha256hex(TOKEN), s3_key: 'k.jpg', collected_at: new Date() },
    ];
    expect((await get(`/p/${TOKEN}`, true)).statusCode).toBe(302);
    expect((await get(`/p/${TOKEN}`, false)).statusCode).toBe(302);
  });

  it('says plainly when it has run out, and signs nothing', async () => {
    photos = [
      {
        view_token_hash: sha256hex(TOKEN),
        s3_key: 'k.jpg',
        collected_at: new Date(Date.now() - 16 * 60_000),
      },
    ];
    const r = await get(`/p/${TOKEN}`, false);
    expect(r.statusCode).toBe(404);
    expect(r.headers.location).toBeUndefined();
    expect(r.body).toContain('This photo link has run out.');
    expect(lintHumanCopy(photoLinkDeadPage())).toEqual([]);
  });

  it('finds nothing for a token it never handed out', async () => {
    const r = await get('/p/zzzzzzzzzzzzzzzzzzzzzz', false);
    expect(r.statusCode).toBe(404);
  });
});
