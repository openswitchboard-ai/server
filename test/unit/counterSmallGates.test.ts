/**
 * The small gates on the human surface and around it.
 *
 * Each of these is one line of code and one whole class of thing it stops:
 * a form on another site pressing a button here, an id that is not an id
 * reaching a query, key material that is not a key, a one-click renewal that
 * could be pressed for ever, and a compare that throws on a header somebody
 * chose the bytes of.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { buildApp } from '../../src/app.js';
import * as db from '../../src/db.js';
import { rateLimitBypassed } from '../../src/abuseLimit.js';
import { initCounterKeys } from '../../src/counter/keys.js';
import { isZeroDecimal } from '../../src/stripe.js';
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
} as unknown as Config;

let app: FastifyInstance;

beforeEach(async () => {
  vi.spyOn(db, 'getPool').mockReturnValue({
    query: async () => ({ rows: [], rowCount: 0 }),
  } as any);
  if (!app) {
    app = buildApp(cfg);
    await app.ready();
  }
});

const post = (url: string, headers: Record<string, string> = {}) =>
  app.inject({
    method: 'POST',
    url,
    headers: {
      host: 'my.test',
      'content-type': 'application/x-www-form-urlencoded',
      ...headers,
    },
    payload: '',
  });

describe('nothing on another site may press a button on this one', () => {
  it('turns away a cross-site write, whatever it was going to do', async () => {
    const r = await post('/logout', { origin: 'https://evil.example' });
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toBe('cross_site_request');
  });

  it('turns away one that says so in Sec-Fetch-Site', async () => {
    const r = await post('/logout', { 'sec-fetch-site': 'cross-site' });
    expect(r.statusCode).toBe(403);
  });

  it('and one that says same-site, which is another host on this domain', async () => {
    const r = await post('/logout', { 'sec-fetch-site': 'same-site' });
    expect(r.statusCode).toBe(403);
  });

  it('lets our own page through, by either signal', async () => {
    expect((await post('/logout', { origin: 'https://my.test' })).statusCode).not.toBe(403);
    expect((await post('/logout', { 'sec-fetch-site': 'same-origin' })).statusCode).not.toBe(403);
    // A form navigation sends 'none' in some browsers and nothing in older
    // ones; neither is a reason to refuse a person their own page.
    expect((await post('/logout', { 'sec-fetch-site': 'none' })).statusCode).not.toBe(403);
    expect((await post('/logout')).statusCode).not.toBe(403);
  });

  it('a nonsense Origin is not given the benefit of the doubt', async () => {
    const r = await post('/logout', { origin: 'not a url' });
    expect(r.statusCode).toBe(403);
  });

  it('reading is never refused: a GET changes nothing here', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/login',
      headers: { host: 'my.test', origin: 'https://evil.example' },
    });
    expect(r.statusCode).toBe(200);
  });
});

describe('an id that is not an id', () => {
  it('is a page that does not exist, not a 500', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/settlements/not-a-uuid',
      headers: { host: 'my.test' },
    });
    expect(r.statusCode).toBe(404);
    expect(r.body).toContain('There is nothing here.');
  });

  it('answers a write the same way, in the shape a write expects', async () => {
    const r = await post('/settlements/..%2Fetc/confirm', { origin: 'https://my.test' });
    expect(r.statusCode).toBe(404);
    expect(r.json().error).toBe('not_found');
  });

  it('lets a real one through to the ordinary not-signed-in answer', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/settlements/00000000-0000-4000-8000-000000000000',
      headers: { host: 'my.test' },
    });
    expect(r.statusCode).not.toBe(404);
  });
});

describe('key material is checked before it is used', () => {
  const keep = { link: process.env.COUNTER_LINK_HMAC_KEY, cookie: process.env.COUNTER_COOKIE_KEY };
  const restore = () => {
    process.env.COUNTER_LINK_HMAC_KEY = keep.link ?? 'a'.repeat(64);
    process.env.COUNTER_COOKIE_KEY = keep.cookie ?? 'b'.repeat(64);
  };

  it('refuses anything that is not hex, rather than keying on nothing', async () => {
    // Buffer.from('not-a-key', 'hex') is an empty Buffer and no error at all,
    // so every HMAC after it would be keyed on zero bytes.
    process.env.COUNTER_LINK_HMAC_KEY = 'not-a-key';
    process.env.COUNTER_COOKIE_KEY = 'b'.repeat(64);
    await expect(initCounterKeys(cfg)).rejects.toThrow(/COUNTER_LINK_HMAC_KEY must be hex/);
    restore();
  });

  it('refuses a key that is hex but too short to be one', async () => {
    process.env.COUNTER_LINK_HMAC_KEY = 'a'.repeat(64);
    process.env.COUNTER_COOKIE_KEY = 'ab'.repeat(8); // 8 bytes
    await expect(initCounterKeys(cfg)).rejects.toThrow(/at least 32 bytes/);
    restore();
  });

  it('accepts a real one', async () => {
    restore();
    process.env.COUNTER_LINK_HMAC_KEY = 'a'.repeat(64);
    process.env.COUNTER_COOKIE_KEY = 'b'.repeat(64);
    await expect(initCounterKeys(cfg)).resolves.toBeUndefined();
  });
});

describe('the rate-limit exemption compares bytes', () => {
  it('a header of the same LENGTH but different bytes does not throw', () => {
    const token = 'x'.repeat(40);
    process.env.RATELIMIT_BYPASS_TOKEN = token;
    try {
      // 40 characters, 80 bytes: string length matched and buffer length did
      // not, which is what used to make timingSafeEqual throw.
      expect(rateLimitBypassed({ 'x-osb-ratelimit-bypass': 'é'.repeat(40) })).toBe(false);
      expect(rateLimitBypassed({ 'x-osb-ratelimit-bypass': 'y'.repeat(40) })).toBe(false);
      expect(rateLimitBypassed({ 'x-osb-ratelimit-bypass': token })).toBe(true);
    } finally {
      delete process.env.RATELIMIT_BYPASS_TOKEN;
    }
  });
});

describe('currencies with no minor unit', () => {
  it('are the whole list Stripe has, not just the one we thought of', () => {
    expect(isZeroDecimal('JPY')).toBe(true);
    expect(isZeroDecimal('krw')).toBe(true);
    expect(isZeroDecimal('VND')).toBe(true);
    expect(isZeroDecimal('AUD')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('the renew-all link may be pressed once', () => {
  it('carries a jti, and spending it once is all there is', async () => {
    const { signEmailToken, verifyEmailToken, consumeEmailToken } = await import(
      '../../src/email/tokens.js'
    );
    process.env.COUNTER_LINK_HMAC_KEY = 'a'.repeat(64);
    process.env.COUNTER_COOKIE_KEY = 'b'.repeat(64);
    await initCounterKeys(cfg);

    const spent = new Set<string>();
    vi.spyOn(db, 'getPool').mockReturnValue({
      query: async (_sql: string, params: any[]) => {
        if (spent.has(params[0])) return { rows: [], rowCount: 0 };
        spent.add(params[0]);
        return { rows: [{ jti: params[0] }], rowCount: 1 };
      },
    } as any);

    const t = signEmailToken('bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb', 'renew-all');
    const v = verifyEmailToken(t, 'renew-all');
    expect(v.ok).toBe(true);
    expect(v.jti).toBeTruthy();
    expect(await consumeEmailToken({ ...v, purpose: 'renew-all' })).toBe(true);
    // A forwarded email, a shared screen, a mail archive: all the same answer.
    expect(await consumeEmailToken({ ...v, purpose: 'renew-all' })).toBe(false);
  });

  it('unsubscribe is deliberately not on that road', async () => {
    const { signEmailToken, verifyEmailToken } = await import('../../src/email/tokens.js');
    process.env.COUNTER_LINK_HMAC_KEY = 'a'.repeat(64);
    process.env.COUNTER_COOKIE_KEY = 'b'.repeat(64);
    await initCounterKeys(cfg);
    // One-click unsubscribe has to keep working every time a mail client tries
    // it, and turning email off twice is turning it off once.
    const v = verifyEmailToken(
      signEmailToken('bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb', 'unsubscribe'),
      'unsubscribe',
    );
    expect(v.ok).toBe(true);
    expect(v.jti).toBeUndefined();
  });

  it('two renew links are never the same link', async () => {
    const { signEmailToken } = await import('../../src/email/tokens.js');
    process.env.COUNTER_LINK_HMAC_KEY = 'a'.repeat(64);
    process.env.COUNTER_COOKIE_KEY = 'b'.repeat(64);
    await initCounterKeys(cfg);
    const a = signEmailToken('bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb', 'renew-all');
    const b = signEmailToken('bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb', 'renew-all');
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
describe('a settlement approval burns on the press', () => {
  it('the page carries its link back, so the press is what spends it', async () => {
    const cpages = await import('../../src/counter/pages.js');
    const html = cpages.mainPage({
      action: 'settlement-approve',
      refId: '00000000-0000-4000-8000-000000000000',
      facts: [{ k: 'Amount', v: '400 AUD' }],
      anomalies: [],
      hasPin: true,
      hasPasskey: false,
      elevated: false,
      postPath: '/approve',
      linkToken: 'a-one-use-token',
    });
    expect(html).toContain('name="link_token"');
    expect(html).toContain('value="a-one-use-token"');
  });

  it('a page reached from the main page carries none, because that road is not one-use', async () => {
    const cpages = await import('../../src/counter/pages.js');
    const html = cpages.mainPage({
      action: 'settlement-approve',
      refId: '00000000-0000-4000-8000-000000000000',
      facts: [],
      anomalies: [],
      hasPin: true,
      hasPasskey: false,
      elevated: false,
      postPath: '/approve',
    });
    expect(html).not.toContain('name="link_token"');
  });
});

describe('a counterpartys name is not markup', () => {
  it('is escaped everywhere the photo page prints it', async () => {
    const cpages = await import('../../src/counter/pages.js');
    const html = cpages.photoPage({
      who: '<script>alert(1)</script>',
      thing: 'mountain bike',
      token: 't',
      ttlDays: 7,
      maxMb: 8,
      maxCaption: 200,
    } as any);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
