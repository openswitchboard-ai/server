/**
 * Two gaps closed in the cleanup after the 28 September 2026 review merge.
 *
 *  - A verdict ("how did it go?") could be recorded on an introduction still
 *    in line by posting the form by hand. An in-line introduction has not been
 *    made yet, so POST /verdict answers it the way the match page does: 404.
 *  - Turning everything back on after the kill switch took any window,
 *    including one an emailed code opened, while the kill-switch email says it
 *    takes a passkey or PIN. It now takes the strong ceremony, and the main
 *    page asks for it accordingly.
 */
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
  sendKillSwitchEmail: vi.fn(async () => ({ outcome: 'sent' })),
}));

vi.mock('../../src/counter/webauthn.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  accountHasPasskey: vi.fn(async () => world.hasPasskey),
}));

import { buildApp } from '../../src/app.js';
import { sendKillSwitchEmail } from '../../src/counter/email.js';
import { hashPin } from '../../src/counter/pin.js';
import { initCounterKeys } from '../../src/counter/keys.js';
import { anonymousSessionLimiter, pinAttemptLimiter } from '../../src/abuseLimit.js';
import * as db from '../../src/db.js';
import * as home from '../../src/counter/pagesHome.js';
import { recordVerdict } from '../../src/domain/matches.js';
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
} as unknown as Config;

const ACCOUNT = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const MATCH = 'dddddddd-4444-4444-8444-dddddddddddd';
const PIN = '482913';

interface World {
  hasPasskey: boolean;
  pinHash: string | null;
  elevatedUntil: Date | null;
  elevatedVia: string | null;
  matchLive: boolean;
  matchState: string;
  verdicts: string[];
  killedOff: boolean;
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
            account_id: ACCOUNT,
            pin_ok_until: world.elevatedUntil,
            elevated_via: world.elevatedVia,
            oauth_ctx: null,
          },
        ]);
      }
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
      if (s.startsWith('SELECT pin_money_from FROM accounts')) return rows([{ pin_money_from: null }]);
      if (s.includes('SET pin_failed_attempts = pin_failed_attempts + 1')) {
        if (!world.pinHash) return rows([]);
        return rows([
          { pin_hash: world.pinHash, pin_failed_attempts: 1, pin_locked_until: null, pin_money_from: null },
        ]);
      }
      if (s.startsWith('SELECT * FROM matches WHERE id')) {
        if (params[0] !== MATCH) return rows([]);
        return rows([
          {
            id: MATCH,
            card_want: 'card-w',
            card_have: 'card-h',
            account_want: ACCOUNT,
            account_have: OTHER,
            category: 'goods.bicycle.mountain',
            stage: 2,
            state: world.matchState,
            live: world.matchLive,
          },
        ]);
      }
      if (s.startsWith('INSERT INTO match_verdicts')) {
        world.verdicts.push(params[2]);
        return rows([]);
      }
      if (s.startsWith('UPDATE accounts SET kill_switch_at = NULL')) {
        world.killedOff = true;
        return rows([]);
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
  world = {
    hasPasskey: true,
    pinHash: null,
    elevatedUntil: null,
    elevatedVia: null,
    matchLive: true,
    matchState: 'open',
    verdicts: [],
    killedOff: false,
  };
  pinAttemptLimiter.reset();
  anonymousSessionLimiter.reset();
  vi.spyOn(db, 'getPool').mockReturnValue(fakePool());
  vi.mocked(sendKillSwitchEmail).mockClear();
});

const post = (url: string, body: Record<string, string> = {}) =>
  app.inject({
    method: 'POST',
    url,
    headers: {
      host: 'my.test',
      'content-type': 'application/x-www-form-urlencoded',
      cookie: '__Host-osb_counter=osb_cs_x',
    },
    payload: new URLSearchParams(body).toString(),
  });

// ---------------------------------------------------------------------------
describe('a verdict on an introduction still in line', () => {
  it('is refused as not found, and nothing is recorded', async () => {
    world.matchLive = false;
    const r = await post('/verdict', { match_id: MATCH, verdict: 'bad' });
    expect(r.statusCode).toBe(404);
    expect(r.body).toContain('No such match on your ledger.');
    expect(world.verdicts).toEqual([]);
  });

  it('is refused the same way by the domain call the assistant uses', async () => {
    world.matchLive = false;
    await expect(recordVerdict(MATCH, ACCOUNT, 'good', 'agent')).rejects.toMatchObject({ notFound: true });
    expect(world.verdicts).toEqual([]);
  });

  it('a live introduction takes it as before', async () => {
    const r = await post('/verdict', { match_id: MATCH, verdict: 'good' });
    expect(r.statusCode).toBe(303);
    expect(world.verdicts).toEqual(['good']);
  });

  it('a closed introduction is not in line, whatever its live flag says', async () => {
    world.matchLive = false;
    world.matchState = 'closed';
    const r = await post('/verdict', { match_id: MATCH, verdict: 'fine' });
    expect(r.statusCode).toBe(303);
    expect(world.verdicts).toEqual(['fine']);
  });
});

// ---------------------------------------------------------------------------
describe('turning everything back on', () => {
  it('does not lean on a window an emailed code opened', async () => {
    world.elevatedUntil = new Date(Date.now() + 5 * 60_000);
    world.elevatedVia = 'code';
    const r = await post('/kill/off', { pin: '' });
    expect(r.statusCode).toBe(401);
    expect(r.json().error_description).toBe('This takes your passkey. Go back and press again with it.');
    expect(world.killedOff).toBe(false);
    expect(vi.mocked(sendKillSwitchEmail)).not.toHaveBeenCalled();
  });

  it('a passkey window turns it back on', async () => {
    world.elevatedUntil = new Date(Date.now() + 5 * 60_000);
    world.elevatedVia = 'passkey';
    const r = await post('/kill/off', { pin: '' });
    expect(r.statusCode).toBe(303);
    expect(world.killedOff).toBe(true);
  });

  it('on an account with a PIN, a code window still asks for the PIN, and the PIN does it', async () => {
    world.pinHash = pinHash;
    world.elevatedUntil = new Date(Date.now() + 5 * 60_000);
    world.elevatedVia = 'code';
    const wrong = await post('/kill/off', { pin: '000000' });
    expect(wrong.statusCode).toBe(401);
    expect(world.killedOff).toBe(false);
    const right = await post('/kill/off', { pin: PIN });
    expect(right.statusCode).toBe(303);
    expect(world.killedOff).toBe(true);
  });

  it('the main page asks for the credential, and a failed passkey is not told to email a code', () => {
    const page = home.dashboardPage({
      killSwitchOn: true,
      ceremony: { hasPin: false, hasPasskey: true, elevated: false },
      cardCounts: { total: 0, published: 0, pending: 0 },
      pendingApprovals: [],
    });
    expect(page).toContain('Turning it back on needs your passkey.');
    expect(page).toContain('data-pk-form="killOffForm" data-pk-fallback="retry"');
    const withPin = home.dashboardPage({
      killSwitchOn: true,
      ceremony: { hasPin: true, hasPasskey: false, elevated: false },
      cardCounts: { total: 0, published: 0, pending: 0 },
      pendingApprovals: [],
    });
    expect(withPin).toContain('id="pin-kill"');
  });
});
