/**
 * AN EMAILED CODE IS RECOVERY, NOT A CREDENTIAL (28 September 2026).
 *
 * On an account holding a passkey and no PIN, signing in with an emailed code
 * opens a window for the everyday presses. Anyone who can read the inbox can
 * produce that code, so it must never:
 *   - set a first PIN or fit a new passkey,
 *   - make an agent key or authorise an assistant,
 *   - move money.
 * The one road where a code does set a PIN is /pin/recover, which says what
 * it does, mails the owner at once, and holds the new PIN back from money for
 * 24 hours.
 *
 * Also here: a first PIN on an account that already held a passkey is a new
 * way in and mails a notice; a payment approval's one-use link is bound to its
 * action as well as its account and ref; and a passkey sign-in comes back to
 * the link that sent the person to sign in.
 */
import { createHash } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

vi.mock('../../src/crypto.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  writeConsentEvent: vi.fn(async () => 'consent/key'),
}));

vi.mock('../../src/domain/counterOps.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  accountEmail: vi.fn(async () => 'human@example.test'),
}));

vi.mock('../../src/counter/email.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  sendSecurityNoticeEmail: vi.fn(async () => ({ outcome: 'sent' })),
}));

vi.mock('../../src/counter/webauthn.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  accountHasPasskey: vi.fn(async () => world.hasPasskey),
  verifyAuthentication: vi.fn(async () => ACCOUNT),
  authenticationOptions: vi.fn(async () => ({ challenge: 'chal-1' })),
  registrationOptions: vi.fn(async () => ({ challenge: 'chal-2', user: { id: 'u' } })),
}));

import { buildApp } from '../../src/app.js';
import { sendSecurityNoticeEmail } from '../../src/counter/email.js';
import { hashPin } from '../../src/counter/pin.js';
import { initCounterKeys } from '../../src/counter/keys.js';
import { signLink } from '../../src/counter/links.js';
import { returnPathOk, RETURN_COOKIE } from '../../src/counter/session.js';
import { anonymousSessionLimiter, pinAttemptLimiter } from '../../src/abuseLimit.js';
import * as db from '../../src/db.js';
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
  quotas: { maxOpenCards: 5, maxPublishesPerDay: 10, maxOffersPerHour: 6 },
  docsBase: 'https://openswitchboard.ai/docs',
  settlementFeePercent: 0,
  settlementFeeFlatMinor: 100,
  settlementProcessingPercent: 1.75,
  settlementProcessingFixedMinor: 30,
} as unknown as Config;

const ACCOUNT = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const SETTLEMENT = 'cccccccc-3333-4333-8333-cccccccccccc';
const MATCH = 'dddddddd-4444-4444-8444-dddddddddddd';
const PIN = '482913';

interface World {
  hasPasskey: boolean;
  pinHash: string | null;
  pinMoneyFrom: Date | null;
  elevatedUntil: Date | null;
  elevatedVia: string | null;
  signedIn: boolean;
  /** Every statement that wrote to accounts, in order. */
  accountWrites: string[];
  settlementApproved: boolean;
  links: any[];
}
let world: World;
let pinHash: string;

function fakePool() {
  const rows = (r: any[]) => ({ rows: r, rowCount: r.length });
  return {
    query: async (sql: string, params: any[] = []) => {
      const s = sql.replace(/\s+/g, ' ').trim();
      if (s.startsWith('SELECT id, account_id, pin_ok_until, elevated_via, oauth_ctx FROM counter_sessions')) {
        return rows([
          {
            id: 'sess-1',
            account_id: world.signedIn ? ACCOUNT : null,
            pin_ok_until: world.elevatedUntil,
            elevated_via: world.elevatedVia,
            oauth_ctx: null,
          },
        ]);
      }
      if (s.startsWith('INSERT INTO counter_sessions')) return rows([{ id: 'sess-2' }]);
      if (s.startsWith('WITH pending AS')) return rows([{ webauthn_challenge: 'chal-1' }]);
      if (s.startsWith('UPDATE counter_sessions SET pin_ok_until')) {
        world.elevatedUntil = new Date(Date.now() + 5 * 60_000);
        world.elevatedVia = params[2];
        return rows([]);
      }
      if (s.startsWith('SELECT * FROM accounts WHERE id')) {
        return rows([
          {
            id: ACCOUNT,
            status: 'active',
            onboarded_at: new Date('2026-01-01'),
            pin_hash: world.pinHash,
            timezone: 'Australia/Sydney',
            created_at: new Date('2026-01-01'),
          },
        ]);
      }
      if (s.startsWith('SELECT timezone FROM accounts')) return rows([{ timezone: 'Australia/Sydney' }]);
      if (s.startsWith('SELECT pin_money_from FROM accounts')) {
        return rows([{ pin_money_from: world.pinMoneyFrom }]);
      }
      if (s.startsWith('UPDATE accounts SET pin_money_from = now()')) {
        world.accountWrites.push('hold');
        world.pinMoneyFrom = new Date(Date.now() + 24 * 3_600_000);
        return rows([{ pin_money_from: world.pinMoneyFrom }]);
      }
      if (s.startsWith('UPDATE accounts SET pin_money_from = NULL')) {
        world.accountWrites.push('clear-hold');
        world.pinMoneyFrom = null;
        return rows([]);
      }
      if (s.startsWith('UPDATE accounts SET pin_hash')) {
        world.accountWrites.push('pin');
        world.pinHash = params[1];
        return rows([]);
      }
      if (s.includes('SET pin_failed_attempts = pin_failed_attempts + 1')) {
        if (!world.pinHash) return rows([]);
        return rows([
          {
            pin_hash: world.pinHash,
            pin_failed_attempts: 1,
            pin_locked_until: null,
            pin_money_from: world.pinMoneyFrom,
          },
        ]);
      }
      if (s.startsWith('SELECT (created_at >')) return rows([{ young: false }]);
      if (s.startsWith('SELECT * FROM settlements WHERE id')) {
        return rows([
          {
            id: SETTLEMENT,
            match_id: MATCH,
            buyer_account: ACCOUNT,
            seller_account: OTHER,
            state: 'proposed',
            amount: '100',
            ccy: 'AUD',
            buyer_approved_at: null,
            seller_approved_at: null,
          },
        ]);
      }
      if (/^UPDATE settlements/.test(s)) {
        world.settlementApproved = true;
        return rows([
          {
            id: SETTLEMENT,
            match_id: MATCH,
            buyer_account: ACCOUNT,
            seller_account: OTHER,
            state: 'approved-by-buyer',
            amount: '100',
            ccy: 'AUD',
          },
        ]);
      }
      if (s.startsWith('SELECT * FROM approval_links WHERE id')) {
        return rows(world.links.filter((l) => l.id === params[0]));
      }
      if (s.startsWith('UPDATE approval_links SET used_at')) {
        const l = world.links.find((x) => x.id === params[0] && !x.used_at);
        if (!l) return rows([]);
        l.used_at = new Date();
        return rows([{ id: l.id }]);
      }
      return rows([]);
    },
  } as any;
}

let app: FastifyInstance;

beforeAll(async () => {
  pinHash = await hashPin(PIN);
  process.env.COUNTER_LINK_HMAC_KEY = 'a'.repeat(64);
  process.env.COUNTER_COOKIE_KEY = 'b'.repeat(64);
  await initCounterKeys(cfg);
  app = buildApp(cfg);
  await app.ready();
});

beforeEach(() => {
  // A passkey-only account, just signed in with an emailed code.
  world = {
    hasPasskey: true,
    pinHash: null,
    pinMoneyFrom: null,
    elevatedUntil: new Date(Date.now() + 5 * 60_000),
    elevatedVia: 'code',
    signedIn: true,
    accountWrites: [],
    settlementApproved: false,
    links: [],
  };
  pinAttemptLimiter.reset();
  anonymousSessionLimiter.reset();
  vi.spyOn(db, 'getPool').mockReturnValue(fakePool());
  vi.mocked(sendSecurityNoticeEmail).mockClear();
});

const post = (url: string, body: Record<string, string> = {}, cookie = '__Host-osb_counter=osb_cs_x') =>
  app.inject({
    method: 'POST',
    url,
    headers: {
      host: 'my.test',
      'content-type': 'application/x-www-form-urlencoded',
      ...(cookie ? { cookie } : {}),
    },
    payload: new URLSearchParams(body).toString(),
  });

const get = (url: string, cookie = '__Host-osb_counter=osb_cs_x') =>
  app.inject({ method: 'GET', url, headers: { host: 'my.test', ...(cookie ? { cookie } : {}) } });

describe('a window an emailed code opened', () => {
  it('does not set a first PIN', async () => {
    const r = await post('/pin/set', { pin: PIN, pin2: PIN });
    expect(r.statusCode).toBe(403);
    expect(r.body).toContain('Confirm it is you.');
    // The way through for a lost passkey is named, and it is its own road.
    expect(r.body).toContain('href="/pin/recover"');
    expect(world.accountWrites).not.toContain('pin');
  });

  it('does not open the PIN page either, and the page asks for the passkey', async () => {
    const r = await get('/pin');
    expect(r.body).toContain('Confirm it is you.');
    expect(r.body).toContain('data-pk-form="confirmForm"');
  });

  it('does not fit a new passkey', async () => {
    const r = await post('/passkey/options');
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toBe('ceremony_required');
  });

  it('does not make an agent key', async () => {
    const r = await post('/agent-keys', { name: 'laptop' });
    expect(r.statusCode).toBe(401);
    expect(r.json().error_description).toBe('This takes your passkey. Go back and press again with it.');
  });

  it('does not get past the confirm step on the way to either', async () => {
    const r = await post('/confirm', { next: '/pin', pin: '' });
    expect(r.statusCode).toBe(401);
  });

  it('a passkey window does all of it, and a first PIN mails a notice', async () => {
    world.elevatedVia = 'passkey';
    const r = await post('/pin/set', { pin: PIN, pin2: PIN });
    expect(r.statusCode).toBe(303);
    expect(world.accountWrites).toEqual(['pin', 'clear-hold']);
    expect(world.elevatedVia).toBe('pin');
    expect(vi.mocked(sendSecurityNoticeEmail)).toHaveBeenCalledWith(
      cfg,
      'human@example.test',
      ACCOUNT,
      'pin-set',
    );
  });

  it('an old row with nothing recorded counts as the weaker kind', async () => {
    world.elevatedVia = null;
    const r = await post('/passkey/options');
    expect(r.statusCode).toBe(403);
  });
});

describe('lost your passkey', () => {
  it('without a fresh code, offers to email one', async () => {
    world.elevatedUntil = null;
    const r = await get('/pin/recover');
    expect(r.body).toContain('Lost your passkey?');
    expect(r.body).toContain('action="/pin/recover/code"');
    expect(r.body).toContain('Money, a new passkey and a new assistant wait 24 hours.');
  });

  it('after a fresh code, asks for the PIN', async () => {
    const r = await get('/pin/recover');
    expect(r.body).toContain('<h1>Set a PIN.</h1>');
    expect(r.body).toContain('action="/pin/recover"');
    expect(r.body).toContain('Six or more digits.');
  });

  it('just confirmed with the passkey: the ordinary road, with no wait', async () => {
    world.elevatedVia = 'passkey';
    const r = await get('/pin/recover');
    expect(r.statusCode).toBe(303);
    expect(r.headers.location).toBe('/pin');
  });

  it('sets the PIN held back from money, holds it first, and mails the owner at once', async () => {
    const r = await post('/pin/recover', { pin: PIN, pin2: PIN });
    expect(r.statusCode).toBe(200);
    expect(world.accountWrites).toEqual(['hold', 'pin']);
    expect(r.body).toMatch(/A new PIN can move money from [^.]+\. Your passkey works now\./);
    expect(r.body).toContain('We have emailed you to say a PIN was set.');
    expect(vi.mocked(sendSecurityNoticeEmail)).toHaveBeenCalledWith(
      cfg,
      'human@example.test',
      ACCOUNT,
      'pin-set-by-code',
    );
  });

  it('is refused without a window at all', async () => {
    world.elevatedUntil = null;
    const r = await post('/pin/recover', { pin: PIN, pin2: PIN });
    expect(r.statusCode).toBe(403);
    expect(world.accountWrites).toEqual([]);
  });

  it('is not a road for an account that holds a PIN already', async () => {
    world.pinHash = pinHash;
    const r = await post('/pin/recover', { pin: PIN, pin2: PIN });
    expect(r.statusCode).toBe(303);
    expect(world.accountWrites).toEqual([]);
  });

  it('the recovered PIN cannot fit a passkey or make a key while it waits', async () => {
    world.pinHash = pinHash;
    world.pinMoneyFrom = new Date(Date.now() + 24 * 3_600_000);
    world.elevatedUntil = null;
    const r = await post('/confirm', { next: '/passkey', pin: PIN });
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toBe('pin_held');
    expect(r.json().error_description).toMatch(/^A new PIN can do this from .+\. Your passkey works now\.$/);
    const k = await post('/agent-keys', { name: 'laptop', pin: PIN });
    expect(k.statusCode).toBe(403);
  });
});

describe('a payment approval link', () => {
  const mint = (action: string) => {
    const row = {
      id: `eeeeeeee-5555-4555-8555-00000000000${world.links.length}`,
      account_id: ACCOUNT,
      action,
      ref_id: SETTLEMENT,
      amount: null,
      ccy: null,
      counterparty_account: OTHER,
      payload: null,
      created_at: new Date(),
      expires_at: new Date(Date.now() + 15 * 60_000),
      used_at: null,
      decision: null,
    };
    const token = signLink(row);
    world.links.push({ ...row, token_hash: createHash('sha256').update(token).digest('hex') });
    return token;
  };

  beforeEach(() => {
    world.pinHash = pinHash;
    world.hasPasskey = false;
  });

  it('is bound to its action: a link minted for something else spends nothing here', async () => {
    const token = mint('offer-accept');
    const r = await post('/approve', {
      action: 'settlement-approve',
      ref_id: SETTLEMENT,
      decision: 'approve',
      pin: PIN,
      link_token: token,
    });
    expect(r.statusCode).toBe(400);
    expect(world.links[0].used_at).toBeNull();
    expect(world.settlementApproved).toBe(false);
  });

  it('its own link is spent by the press', async () => {
    const token = mint('settlement-approve');
    const r = await post('/approve', {
      action: 'settlement-approve',
      ref_id: SETTLEMENT,
      decision: 'approve',
      pin: PIN,
      link_token: token,
    });
    expect(r.statusCode).toBe(303);
    expect(world.links[0].used_at).not.toBeNull();
  });

  it('asks its question in the one-question style, with the money in sentences', async () => {
    const r = await get(`/approvals/settlement/${SETTLEMENT}`);
    expect(r.statusCode).toBe(200);
    expect(r.body).toMatch(/<h1>Agree to pay \$[0-9.]+ AUD\?<\/h1>/);
    expect(r.body).toContain('That is the $100 AUD you agreed');
    expect(r.body).not.toContain('class="headline"');
    expect(r.body).not.toContain('proposed');
    // The person's first week is not everybody's first week: an account that
    // is not new says nothing about it.
    expect(r.body).not.toContain('joined this week');
  });
});

describe('signing in comes back to the link', () => {
  it('keeps only the two shapes of path it may return to', () => {
    expect(returnPathOk('/a/0f0e7c1a-0000-4000-8000-000000000000.abc_DEF-123')).toBe(true);
    expect(returnPathOk('/open/0f0e7c1a-0000-4000-8000-000000000000')).toBe(true);
    for (const bad of [
      '//evil.example/a/x',
      'https://evil.example/a/x',
      '/a/x/../../settings',
      '/a/x?next=//evil',
      '/open/not-a-uuid',
      '/ledger',
      '/a/',
      '',
    ]) {
      expect(returnPathOk(bad), bad).toBe(false);
    }
  });

  it('an open request opened signed out sends the person to sign in, and keeps it', async () => {
    world.signedIn = false;
    const r = await get('/open/0f0e7c1a-0000-4000-8000-000000000000', '');
    expect(r.statusCode).toBe(303);
    expect(r.headers.location).toBe('/login');
    expect(String(r.headers['set-cookie'])).toContain(
      `${RETURN_COOKIE}=/open/0f0e7c1a-0000-4000-8000-000000000000;`,
    );
  });

  it('a passkey sign-in goes back to the kept link, and spends the cookie', async () => {
    const path = '/a/0f0e7c1a-0000-4000-8000-000000000000.abc';
    world.signedIn = false;
    const signIn = (returnCookie: string) =>
      app.inject({
        method: 'POST',
        url: '/login/passkey/verify',
        headers: {
          host: 'my.test',
          'content-type': 'application/json',
          cookie: `__Host-osb_counter=osb_cs_x; ${RETURN_COOKIE}=${returnCookie}`,
        },
        payload: JSON.stringify({ id: 'cred' }),
      });
    const r = await signIn(path);
    expect(r.statusCode).toBe(200);
    expect(r.json().next).toBe(path);
    const cookies = ([] as string[]).concat(r.headers['set-cookie'] as any);
    expect(cookies.some((c) => c.startsWith(`${RETURN_COOKIE}=; Path=/; Max-Age=0`))).toBe(true);
    // Anywhere else is the main page, as before.
    const evil = await signIn('//evil.example/a/x');
    expect(evil.json().next).toBe('/');
  });

  it('a cookie somebody else wrote is held to the same two shapes', async () => {
    const { takeReturnPath } = await import('../../src/counter/session.js');
    const headers: Record<string, unknown> = {};
    const reply: any = { header: (k: string, v: unknown) => ((headers[k] = v), reply) };
    const req: any = { headers: { cookie: `${RETURN_COOKIE}=//evil.example/steal` } };
    expect(takeReturnPath(req, reply)).toBeUndefined();
    expect(String(headers['set-cookie'])).toContain(`${RETURN_COOKIE}=; Path=/; Max-Age=0`);
    const ok: any = { headers: { cookie: `${RETURN_COOKIE}=/open/0f0e7c1a-0000-4000-8000-000000000000` } };
    expect(takeReturnPath(ok, reply)).toBe('/open/0f0e7c1a-0000-4000-8000-000000000000');
  });
});

describe('sessions made for nobody are paced', () => {
  it('the passkey sign-in button makes ten a minute per connection, then refuses', async () => {
    world.signedIn = false;
    vi.spyOn(db, 'getPool').mockReturnValue({
      ...fakePool(),
      query: async (sql: string, params: any[] = []) =>
        /FROM counter_sessions/.test(sql) && /^\s*SELECT/.test(sql)
          ? { rows: [], rowCount: 0 }
          : fakePool().query(sql, params),
    } as any);
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) codes.push((await post('/login/passkey/options', {}, '')).statusCode);
    expect(codes.slice(0, 10).every((c) => c === 200)).toBe(true);
    expect(codes[10]).toBe(429);
  });
});
