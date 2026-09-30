/**
 * DELETE MY ACCOUNT (founder decision, 28 September 2026).
 *
 * WHAT IS ASSERTED HERE.
 *
 *  - Settings links to the page; the page is one paragraph, one button and a
 *    way back, and passes the human-copy lint in every ceremony state;
 *  - the press takes the PIN or the passkey at that moment, even inside a
 *    window a sign-in or an earlier press opened; nothing happens without it;
 *  - the press withdraws every live want and have through the ordinary
 *    withdraw, closes every open introduction the ordinary way, pulls back
 *    every session, token and key, erases the account's own details, keeps
 *    what safety, the law and money need, and marks the account deleted;
 *  - it is idempotent, and the confirmation email goes out once, as an
 *    exempt template, before the address is erased;
 *  - the account cannot sign in again, an old agent token gets the ordinary
 *    plain 401, and a new registration on the same address starts fresh —
 *    unless the account was suspended, when the address stays refused;
 *  - a payment still under way refuses it, plainly.
 */
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

// The ordinary withdraw and the ordinary closes are what deletion must reuse;
// they are held to their own behaviour in their own files. Here they are
// recorded, so what is asserted is that deletion goes through them.
const calls = vi.hoisted(() => ({
  withdrawn: [] as string[],
  archived: [] as { id: string; via: string }[],
  declined: [] as string[],
  sent: [] as any[],
  sentKeys: new Set<string>(),
  /** Run at the moment of each send, to look at the world as it stood. */
  onSend: undefined as undefined | (() => void),
}));
vi.mock('../../src/domain/cards.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  withdrawIntent: vi.fn(async (_acct: string, id: string) => {
    calls.withdrawn.push(id);
    return { intent_id: id, state: 'WITHDRAWN', introductions_archived: 0, conversations_kept: 0 };
  }),
}));
vi.mock('../../src/domain/matches.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  archiveMatch: vi.fn(async (id: string, _acct: string, via: string) => {
    calls.archived.push({ id, via });
    return { intro_id: id, state: 'archived', already: false, promoted: [] };
  }),
  declineMatch: vi.fn(async (id: string) => {
    calls.declined.push(id);
    return [];
  }),
}));
vi.mock('../../src/email/send.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  sendEmail: vi.fn(async (_cfg: unknown, input: any) => {
    if (calls.sentKeys.has(input.dedupeKey)) return { status: 'duplicate' };
    calls.sentKeys.add(input.dedupeKey);
    calls.sent.push(input);
    calls.onSend?.();
    return { status: 'sent', sesMessageId: 'm-1' };
  }),
}));

import { buildApp } from '../../src/app.js';
import * as db from '../../src/db.js';
import * as creds from '../../src/counter/credentials.js';
import * as cpages from '../../src/counter/pages.js';
import * as home from '../../src/counter/pagesHome.js';
import { initCounterKeys } from '../../src/counter/keys.js';
import { hashPin } from '../../src/counter/pin.js';
import { writeConsentEvent } from '../../src/crypto.js';
import { deleteAccount, PaymentUnderWay } from '../../src/domain/accountDeletion.js';
import { emailHashes, findAccountByEmail } from '../../src/domain/accounts.js';
import { createPendingAccount } from '../../src/domain/counterOps.js';
import { emailIsSuspended } from '../../src/safety/suspend.js';
import {
  ACCOUNT_DELETED_LINES,
  ACCOUNT_DELETED_SUBJECT,
  EXEMPT_TEMPLATES,
  renderAccountDeleted,
} from '../../src/email/templates.js';
import { lintHumanCopy } from '../../src/email/lint.js';
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

const ANA = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const CARD_LIVE = 'dddddddd-4444-4444-8444-dddddddddddd';
const CARD_PENDING = 'dddddddd-4444-4444-8444-ddddddddddd2';
const INTRO_EARLY = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaa1';
const INTRO_TALKING = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaa2';
const SID = 'osb_cs_testsessionvaluetestsessionvalue';
const PIN = '241083';
const EMAIL = 'ana@example.test';
const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex');
let pinHash: string;

interface Account {
  id: string;
  status: string;
  email_hash: string;
  email_hash_v2: string | null;
  email_enc: Buffer;
  first_name_enc: Buffer;
  locality_enc: Buffer;
  data_key_enc: Buffer;
  pin_hash: string | null;
  timezone: string | null;
  arrangement: unknown;
  suspended_at: Date | null;
  deleted_at: Date | null;
  onboarded_at: Date;
  hears_via: string;
}

interface World {
  accounts: Map<string, Account>;
  sessions: Map<string, { account_id: string; pin_ok_until: Date | null }>;
  tokens: { account_id: string; token_hash: string }[];
  passkeys: Set<string>;
  suspendedEmails: { v1: string; v2: string }[];
  liveCards: string[];
  openIntros: { id: string; conversation: boolean }[];
  paymentUnderWay: boolean;
  held: boolean;
  sql: { sql: string; params: any[] }[];
  began: number;
  committed: number;
}
let world: World;

function anaRow(over: Partial<Account> = {}): Account {
  const eh = emailHashes(EMAIL);
  return {
    id: ANA,
    status: 'active',
    email_hash: eh.v1,
    email_hash_v2: eh.v2,
    email_enc: Buffer.from(`enc:${EMAIL}`),
    first_name_enc: Buffer.from('enc:Ana'),
    locality_enc: Buffer.from('enc:Kaleen'),
    data_key_enc: Buffer.from('wrapped'),
    pin_hash: pinHash,
    timezone: 'Australia/Hobart',
    arrangement: { cadence: 'hourly' },
    suspended_at: null,
    deleted_at: null,
    onboarded_at: new Date('2026-01-01'),
    hears_via: 'email',
    ...over,
  };
}

function fakePool() {
  const query = async (sql: string, params: any[] = []) => {
    const rows = (r: any[]) => ({ rows: r, rowCount: r.length });
    world.sql.push({ sql, params });
    if (/^\s*BEGIN/.test(sql)) {
      world.began += 1;
      return rows([]);
    }
    if (/^\s*COMMIT/.test(sql)) {
      world.committed += 1;
      return rows([]);
    }

    // ---- accounts ----
    if (/SELECT suspended_at FROM accounts/.test(sql)) {
      return rows([{ suspended_at: world.accounts.get(params[0])?.suspended_at ?? null }]);
    }
    if (/^\s*SELECT \* FROM accounts WHERE id/.test(sql)) {
      const a = world.accounts.get(params[0]);
      return rows(a ? [{ ...a }] : []);
    }
    if (/SELECT \* FROM accounts WHERE email_hash_v2 = \$1 OR email_hash = \$2/.test(sql)) {
      return rows(
        [...world.accounts.values()].filter(
          (a) => a.email_hash_v2 === params[0] || a.email_hash === params[1],
        ),
      );
    }
    if (/SELECT id, status FROM accounts WHERE email_hash_v2/.test(sql)) {
      return rows(
        [...world.accounts.values()]
          .filter((a) => a.email_hash_v2 === params[0] || a.email_hash === params[1])
          .map((a) => ({ id: a.id, status: a.status })),
      );
    }
    if (/SELECT gen_random_uuid\(\) AS id/.test(sql)) {
      return rows([{ id: 'ffffffff-9999-4999-8999-ffffffffffff' }]);
    }
    if (/INSERT INTO accounts/.test(sql)) {
      world.accounts.set(params[0], {
        ...anaRow(),
        id: params[0],
        status: 'pending',
        email_hash: params[1],
        email_hash_v2: params[2],
        email_enc: params[3],
        pin_hash: null,
        timezone: null,
        arrangement: null,
      });
      return rows([]);
    }
    if (/UPDATE accounts SET\s+status = 'deleted'/.test(sql)) {
      const a = world.accounts.get(params[0]);
      if (!a || a.status === 'deleted') return rows([]);
      Object.assign(a, {
        status: 'deleted',
        deleted_at: new Date(),
        email_hash: `deleted:${a.id}`,
        email_hash_v2: null,
        email_enc: params[1],
        first_name_enc: params[2],
        locality_enc: params[3],
        pin_hash: null,
        timezone: null,
        arrangement: null,
      });
      return rows([{ id: a.id }]);
    }
    if (/SELECT hears_via FROM accounts/.test(sql)) return rows([{ hears_via: 'email' }]);
    if (/SELECT timezone FROM accounts/.test(sql)) return rows([{ timezone: null }]);
    if (/SELECT pin_money_from FROM accounts/.test(sql)) return rows([{ pin_money_from: null }]);
    if (/SET pin_failed_attempts = pin_failed_attempts \+ 1/.test(sql)) {
      const a = world.accounts.get(params[0]);
      return rows(
        a?.pin_hash
          ? [{ pin_hash: a.pin_hash, pin_failed_attempts: 0, pin_locked_until: null, pin_money_from: null }]
          : [],
      );
    }
    if (/SELECT pin_hash, pin_locked_until FROM accounts/.test(sql)) {
      return rows([{ pin_hash: world.accounts.get(params[0])?.pin_hash ?? null, pin_locked_until: null }]);
    }

    // ---- what deletion asks before it acts ----
    if (/FROM settlements/.test(sql)) return world.paymentUnderWay ? rows([{ '?column?': 1 }]) : rows([]);
    if (/AS held\s+FROM accounts a/.test(sql)) {
      const a = world.accounts.get(params[0]);
      return rows([{ held: world.held || !!a?.suspended_at }]);
    }
    if (/SELECT m\.id FROM matches m/.test(sql)) return rows([]);
    if (/SELECT id FROM cards\s+WHERE account_id = \$1 AND lifecycle_state IN/.test(sql)) {
      return rows(world.liveCards.map((id) => ({ id })));
    }
    if (/AS conversation FROM matches/.test(sql)) return rows(world.openIntros);

    // ---- suspended addresses ----
    if (/INSERT INTO suspended_emails/.test(sql)) {
      if (!world.suspendedEmails.some((e) => e.v1 === params[0])) {
        world.suspendedEmails.push({ v1: params[0], v2: params[1] });
      }
      return rows([]);
    }
    if (/FROM suspended_emails/.test(sql)) {
      const hit = world.suspendedEmails.some((e) => e.v2 === params[0] || e.v1 === params[1]);
      return hit ? rows([{ '?column?': 1 }]) : rows([]);
    }

    // ---- credentials ----
    if (/DELETE FROM counter_sessions WHERE account_id/.test(sql)) {
      for (const [k, v] of world.sessions) if (v.account_id === params[0]) world.sessions.delete(k);
      return rows([]);
    }
    if (/DELETE FROM counter_sessions WHERE sid_hash/.test(sql)) {
      world.sessions.delete(params[0]);
      return rows([]);
    }
    if (/FROM counter_sessions/.test(sql) && /SELECT id, account_id/.test(sql)) {
      const s = world.sessions.get(params[0]);
      return rows(
        s
          ? [{ id: 'sess-1', account_id: s.account_id, pin_ok_until: s.pin_ok_until, elevated_via: 'pin', oauth_ctx: null }]
          : [],
      );
    }
    if (/UPDATE counter_sessions SET pin_ok_until/.test(sql)) {
      const s = world.sessions.get(sha256hex(SID));
      if (s) s.pin_ok_until = new Date(Date.now() + 5 * 60_000);
      return rows([]);
    }
    if (/DELETE FROM oauth_tokens WHERE account_id/.test(sql)) {
      world.tokens = world.tokens.filter((t) => t.account_id !== params[0]);
      return rows([]);
    }
    if (/FROM oauth_tokens/.test(sql) && /token_hash = \$1/.test(sql)) {
      return rows(world.tokens.filter((t) => t.token_hash === params[0]).map((t) => ({ ...t, scope: 'switchboard' })));
    }
    if (/DELETE FROM webauthn_credentials WHERE account_id/.test(sql)) {
      world.passkeys.delete(params[0]);
      return rows([]);
    }
    if (/FROM webauthn_credentials/.test(sql)) {
      return world.passkeys.has(params[0]) ? rows([{ '?column?': 1 }]) : rows([]);
    }
    if (/read_calls|write_calls/.test(sql) && /SELECT/.test(sql)) return rows([{ n: 0, oldest: null }]);
    return rows([]);
  };
  return { query, connect: async () => ({ query, release: () => {} }) } as any;
}

let app: FastifyInstance;

beforeEach(async () => {
  pinHash = pinHash ?? (await hashPin(PIN));
  process.env.COUNTER_LINK_HMAC_KEY = 'a'.repeat(64);
  process.env.COUNTER_COOKIE_KEY = 'b'.repeat(64);
  await initCounterKeys(cfg);
  world = {
    accounts: new Map([[ANA, anaRow()]]),
    sessions: new Map([[sha256hex(SID), { account_id: ANA, pin_ok_until: null }]]),
    tokens: [
      { account_id: ANA, token_hash: sha256hex('osb_at_oldtoken') },
      { account_id: ANA, token_hash: sha256hex('osb_ak_oldkey') },
    ],
    passkeys: new Set(),
    suspendedEmails: [],
    liveCards: [CARD_LIVE, CARD_PENDING],
    openIntros: [
      { id: INTRO_EARLY, conversation: false },
      { id: INTRO_TALKING, conversation: true },
    ],
    paymentUnderWay: false,
    held: false,
    sql: [],
    began: 0,
    committed: 0,
  };
  calls.withdrawn = [];
  calls.archived = [];
  calls.declined = [];
  calls.sent = [];
  calls.sentKeys = new Set();
  calls.onSend = undefined;
  vi.mocked(writeConsentEvent).mockClear();
  vi.spyOn(db, 'getPool').mockReturnValue(fakePool());
  vi.spyOn(db, 'dbConfigured').mockReturnValue(true);
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
      cookie: `__Host-osb_counter=${SID}`,
      ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
    },
    ...(body ? { payload: new URLSearchParams(body).toString() } : {}),
  });

const elevate = () => {
  world.sessions.get(sha256hex(SID))!.pin_ok_until = new Date(Date.now() + 5 * 60_000);
};
const ana = () => world.accounts.get(ANA)!;
const ran = (re: RegExp) => world.sql.some((q) => re.test(q.sql));

// ---------------------------------------------------------------------------
describe('the rule', () => {
  it('deleting ignores the window, the way money does', () => {
    expect(creds.isFreshCeremonyAction(creds.ACCOUNT_DELETE_ACTION)).toBe(true);
    expect(creds.elevationFor(creds.ACCOUNT_DELETE_ACTION, true)).toBe(false);
    expect(creds.needsCeremonyAtPress({ hasPin: true, hasPasskey: false }, true, 'account-delete')).toBe(true);
    expect(creds.needsCeremonyAtPress({ hasPin: false, hasPasskey: true }, true, 'account-delete')).toBe(true);
    // It moves no money, so the money list and its wording stay as they were.
    expect(creds.isMoneyAction(creds.ACCOUNT_DELETE_ACTION)).toBe(false);
    for (const a of creds.MONEY_ACTIONS) expect(creds.isFreshCeremonyAction(a)).toBe(true);
    expect(creds.isFreshCeremonyAction('stage3-disclosure')).toBe(false);
  });
});

describe('the page', () => {
  it('Settings links to it', async () => {
    const html = home.settingsPage({
      hearsVia: 'email',
      timezone: null,
      approveWith: { pin: true, passkey: false },
      keyCount: 0,
      freqMatches: 'immediate',
      freqDigests: 'weekly',
      complaintSuppressed: false,
      emailUnreachable: false,
    } as any);
    expect(html).toContain('href="/account/delete"');
    expect(html).toContain('Delete my account');
  });

  it('says what happens in one paragraph, has one button, and a way back', async () => {
    elevate();
    const r = await inject('GET', '/account/delete');
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain(home.ACCOUNT_DELETE_WHAT_HAPPENS);
    expect(r.body.match(/>Delete my account<\/button>/g)).toHaveLength(1);
    expect(r.body).toContain('<a class="btn secondary" href="/">Not now</a>');
  });

  it('asks for the PIN even inside an elevated window', async () => {
    elevate();
    const r = await inject('GET', '/account/delete');
    expect(r.body).toContain('Confirm with your PIN');
    expect(r.body).toContain('This takes your PIN every time.');
    expect(r.body).not.toContain('<input type="hidden" name="pin" value="">');
  });

  it('a passkey-only account presses with its passkey, inside the form', () => {
    const html = home.accountDeletePage({ hasPin: false, hasPasskey: true, elevated: true });
    expect(html).not.toContain('class="pinbox"');
    expect(html).toContain('data-pk-form="deleteForm"');
    expect(html).toContain('data-pk-inline="1"');
    expect(html).toContain('This takes your passkey every time.');
  });

  it('an account holding both is offered both', () => {
    const html = home.accountDeletePage({ hasPin: true, hasPasskey: true, elevated: true });
    expect(html).toContain('Confirm with your PIN');
    expect(html).toContain('Use your passkey instead');
    expect(html).toContain('data-pk-inline="1"');
  });

  it('a payment under way takes the button off and says why', async () => {
    world.paymentUnderWay = true;
    const r = await inject('GET', '/account/delete');
    expect(r.body).toContain(home.ACCOUNT_DELETE_PAYMENT_UNDER_WAY);
    expect(r.body).not.toContain('>Delete my account</button>');
  });

  it('passes the lint in every state', () => {
    for (const c of [
      { hasPin: true, hasPasskey: false },
      { hasPin: false, hasPasskey: true },
      { hasPin: true, hasPasskey: true },
    ]) {
      expect(lintHumanCopy(home.accountDeletePage({ ...c, elevated: true }))).toEqual([]);
      expect(lintHumanCopy(home.accountDeletePage({ ...c, elevated: false, paymentUnderWay: true }))).toEqual([]);
    }
    expect(lintHumanCopy(home.accountDeletedPage(true))).toEqual([]);
    expect(lintHumanCopy(cpages.ceremonyNoteInner(cpages.freshCeremony({ hasPin: true, hasPasskey: true, elevated: true })))).toEqual([]);
  });
});

describe('the press', () => {
  it('an elevated session posting without the PIN deletes nothing', async () => {
    elevate();
    const r = await inject('POST', '/account/delete', {});
    expect(r.statusCode).toBe(401);
    expect(r.body).toContain(home.ACCOUNT_DELETE_WHAT_HAPPENS);
    expect(ana().status).toBe('active');
    expect(calls.withdrawn).toEqual([]);
    expect(calls.sent).toEqual([]);
    expect(writeConsentEvent).not.toHaveBeenCalled();
  });

  it('a wrong PIN deletes nothing', async () => {
    const r = await inject('POST', '/account/delete', { pin: '999999' });
    expect(r.statusCode).toBe(401);
    expect(ana().status).toBe('active');
  });

  it('with the PIN: withdraws, closes, revokes, erases, keeps, and signs out', async () => {
    const r = await inject('POST', '/account/delete', { pin: PIN });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('Your account is deleted and you are signed out. We have sent one email to say so.');
    expect(String(r.headers['set-cookie'])).toContain('__Host-osb_counter=; Path=/; Max-Age=0');

    // The consent log, first, and named for what it is.
    expect(writeConsentEvent).toHaveBeenCalledWith({
      event: 'account-deleted',
      account_id: ANA,
      recorded_via: 'counter',
    });

    // Every live want and have, through the ordinary withdraw.
    expect(calls.withdrawn).toEqual([CARD_LIVE, CARD_PENDING]);
    // Every open introduction, the ordinary way: a decline before a
    // conversation, a file-away once one is open.
    expect(calls.declined).toEqual([INTRO_EARLY]);
    expect(calls.archived).toEqual([{ id: INTRO_TALKING, via: 'account-deleted' }]);

    // Everything out in the world, pulled back.
    expect(world.sessions.size).toBe(0);
    expect(world.tokens).toEqual([]);
    expect(ran(/DELETE FROM oauth_codes WHERE account_id/)).toBe(true);
    expect(ran(/DELETE FROM webauthn_credentials WHERE account_id/)).toBe(true);
    expect(ran(/UPDATE approval_links SET expires_at = now\(\)/)).toBe(true);

    // The account: marked deleted, its own details erased.
    const a = ana();
    expect(a.status).toBe('deleted');
    expect(a.deleted_at).toBeInstanceOf(Date);
    expect(a.email_hash).toBe(`deleted:${ANA}`);
    expect(a.email_hash_v2).toBeNull();
    expect(a.email_enc.toString()).toBe('enc:');
    expect(a.first_name_enc.toString()).toBe('enc:');
    expect(a.locality_enc.toString()).toBe('enc:');
    expect(a.pin_hash).toBeNull();
    expect(a.timezone).toBeNull();
    expect(a.arrangement).toBeNull();
    const erase = world.sql.find((q) => /UPDATE accounts SET\s+status = 'deleted'/.test(q.sql))!.sql;
    for (const col of ['login_code_hash = NULL', 'pin_money_from = NULL', "email_freq_matches = 'off'", "email_freq_digests = 'off'", 'arrangement_updated_at = NULL']) {
      expect(erase).toContain(col);
    }
    // What is kept stays untouched by that statement.
    for (const col of ['suspended_at', 'suspended_reason', 'stripe_account_id_enc', 'consented_at', 'adult_asserted_at', 'data_key_enc']) {
      expect(erase).not.toContain(col);
    }

    // The erase is one transaction.
    expect(world.began).toBe(1);
    expect(world.committed).toBe(1);

    // The postings' words and place come off; the rows stay.
    expect(ran(/UPDATE cards SET[\s\S]*attributes = '\{\}'::jsonb[\s\S]*geo = '\{\}'::jsonb/)).toBe(true);
    expect(ran(/DELETE FROM cards/)).toBe(false);
    // Working state goes.
    for (const t of ['offer_drafts', 'posting_references', 'shelf_attempts', 'category_misses', 'publish_events', 'conversation_windows', 'channel_notify', 'channel_send_rate', 'read_calls', 'write_calls', 'near_misses', 'jev_shadow', 'email_verifications']) {
      expect(ran(new RegExp(`DELETE FROM ${t}\\b`)), t).toBe(true);
    }
    expect(ran(/UPDATE channel_messages SET expires_at = now\(\)/)).toBe(true);
    expect(ran(/UPDATE conversation_photos SET expires_at = now\(\)/)).toBe(true);
  });

  it('keeps what safety, the law and money need', async () => {
    await inject('POST', '/account/delete', { pin: PIN });
    for (const t of ['reports', 'safety_reviews', 'photo_quarantine', 'ledger_entries', 'consent_tokens', 'settlements', 'settlement_evidence', 'suspended_emails', 'email_suppressions', 'matches', 'offers', 'reputation', 'accounts']) {
      expect(ran(new RegExp(`DELETE FROM ${t}\\b`)), t).toBe(false);
    }
    expect(ran(/UPDATE (reports|safety_reviews|photo_quarantine|ledger_entries|settlements)\b/)).toBe(false);
    // The mutes other people set on this account stay; its own go.
    const mutes = world.sql.find((q) => /DELETE FROM match_mutes/.test(q.sql))!;
    expect(mutes.sql).toMatch(/WHERE account_id = \$1$/);
  });

  it('under a safety hold, the postings, offers and photos keep their words', async () => {
    world.held = true;
    const out = await deleteAccount(ANA, cfg);
    expect(out.held).toBe(true);
    expect(ran(/UPDATE cards SET[\s\S]*attributes = '\{\}'/)).toBe(false);
    expect(ran(/UPDATE offers SET message = NULL/)).toBe(false);
    expect(ran(/UPDATE conversation_photos SET expires_at/)).toBe(false);
    // The person's own details still go.
    expect(ana().status).toBe('deleted');
    expect(ana().first_name_enc.toString()).toBe('enc:');
  });

  it('a payment under way refuses it, and nothing is touched', async () => {
    world.paymentUnderWay = true;
    const r = await inject('POST', '/account/delete', { pin: PIN });
    expect(r.statusCode).toBe(409);
    expect(r.body).toContain(home.ACCOUNT_DELETE_PAYMENT_UNDER_WAY);
    expect(ana().status).toBe('active');
    await expect(deleteAccount(ANA, cfg)).rejects.toBeInstanceOf(PaymentUnderWay);
    expect(writeConsentEvent).not.toHaveBeenCalled();
  });
});

describe('idempotent, and the email goes once', () => {
  it('a second run does nothing and sends nothing', async () => {
    const first = await deleteAccount(ANA, cfg);
    expect(first.already).toBe(false);
    expect(first.email).toBe('sent');
    const writes = world.sql.length;
    const second = await deleteAccount(ANA, cfg);
    expect(second.already).toBe(true);
    // One read of the account, and nothing else.
    expect(world.sql.length - writes).toBe(1);
    expect(calls.sent).toHaveLength(1);
    expect(writeConsentEvent).toHaveBeenCalledTimes(1);
  });

  it('a run that stopped before the erase is run again and sends no second email', async () => {
    await deleteAccount(ANA, cfg);
    // As though the transaction never landed.
    world.accounts.set(ANA, anaRow());
    const again = await deleteAccount(ANA, cfg);
    expect(again.email).toBe('duplicate');
    expect(calls.sent).toHaveLength(1);
    expect(ana().status).toBe('deleted');
  });

  it('is the exempt confirmation, to the address, before it is erased', async () => {
    let atSend: { status: string; email: string; began: number } | undefined;
    calls.onSend = () => {
      atSend = { status: ana().status, email: ana().email_enc.toString(), began: world.began };
    };
    await inject('POST', '/account/delete', { pin: PIN });
    expect(atSend).toEqual({ status: 'active', email: `enc:${EMAIL}`, began: 0 });
    expect(calls.sent).toHaveLength(1);
    const e = calls.sent[0];
    expect(e.to).toBe(EMAIL);
    expect(e.template).toBe('account-deleted');
    expect(e.kind).toBe('transactional');
    expect(e.dedupeKey).toBe(`account-deleted:${ANA}`);
    expect(EXEMPT_TEMPLATES.has('account-deleted')).toBe(true);
    expect(e.content.subject).toBe(ACCOUNT_DELETED_SUBJECT);
    expect(e.content.text).toContain('Your OpenSwitchboard account is deleted.');
  });

  it('the email reads plainly and carries no button', () => {
    const c = renderAccountDeleted({ settingsUrl: 'https://my.test/settings' });
    for (const line of ACCOUNT_DELETED_LINES) expect(c.text).toContain(line);
    expect(lintHumanCopy(c.text)).toEqual([]);
    expect(lintHumanCopy(c.html)).toEqual([]);
    expect(c.html).not.toMatch(/padding:14px 34px/);
  });
});

describe('afterwards', () => {
  it('the old session is gone, so the pages send it to sign in', async () => {
    await inject('POST', '/account/delete', { pin: PIN });
    const r = await inject('GET', '/settings');
    expect(r.statusCode).toBe(303);
    expect(r.headers.location).toBe('/login');
  });

  it('the address no longer finds the account, and nothing is left to sign in with', async () => {
    await deleteAccount(ANA, cfg);
    expect(await findAccountByEmail(EMAIL)).toBeUndefined();
    expect(ana().pin_hash).toBeNull();
    expect(world.passkeys.has(ANA)).toBe(false);
  });

  it('an old agent token gets the ordinary plain answer', async () => {
    await deleteAccount(ANA, cfg);
    for (const token of ['osb_at_oldtoken', 'osb_ak_oldkey']) {
      const res = await app.inject({
        method: 'POST',
        url: '/mcp',
        headers: {
          host: 'mcp.test',
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${token}`,
        },
        payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      });
      expect(res.statusCode).toBe(401);
      expect(JSON.parse(res.body)).toEqual({
        error: 'invalid_token',
        error_description: 'A valid access token is required.',
      });
    }
  });

  it('a new registration on the same address starts fresh', async () => {
    await deleteAccount(ANA, cfg);
    expect(await emailIsSuspended(EMAIL)).toBe(false);
    const fresh = await createPendingAccount(EMAIL);
    expect(fresh.status).toBe('pending');
    expect(fresh.id).not.toBe(ANA);
    expect((await findAccountByEmail(EMAIL))?.id).toBe(fresh.id);
  });

  it('a suspended account deleted by the operator keeps its address refused', async () => {
    world.accounts.set(ANA, anaRow({ suspended_at: new Date() }));
    const out = await deleteAccount(ANA, cfg, 'operator');
    expect(out.held).toBe(true);
    expect(ana().status).toBe('deleted');
    expect(await emailIsSuspended(EMAIL)).toBe(true);
  });

  it('a suspended person cannot reach the page at all', async () => {
    world.accounts.set(ANA, anaRow({ suspended_at: new Date() }));
    const r = await inject('GET', '/account/delete');
    expect(r.statusCode).toBe(403);
  });
});
