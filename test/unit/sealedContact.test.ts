/**
 * SEALED CONTACT DETAILS (1 October 2026; domain/sealedContact.ts).
 *
 * What is asserted here:
 *  - THE CRYPTO ROUND TRIP. The very script the pages serve (SEALED_CORE_JS)
 *    runs under Node's WebCrypto the way it runs in a browser: a key pair with
 *    a non-extractable private half, a copy sealed to its public half, and the
 *    details back out with the private half. The wrong key, the wrong
 *    introduction, or a flipped byte opens nothing. The server and the page
 *    agree on the key id.
 *  - THE DOOR THAT REFUSES PLAINTEXT. A send carrying any readable field — an
 *    address, a phone number, anything but scrambled copies — is refused before
 *    anything is stored, and nothing it carried reaches a log or a query.
 *  - A GOOD SEND stores only ciphertext, burns the link, and records the press.
 *  - OPENING DELETES: the copy is handed over and every copy is deleted in the
 *    same transaction; a second open finds nothing; a browser with no matching
 *    key deletes nothing; and the sweep takes what nobody opened.
 *  - THE PAGES carry no inline script and the stricter policy, and the send
 *    page's boxes have no names, so a form submitted without the script sends
 *    nothing.
 */
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID, webcrypto } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

const consentEvents: any[] = [];
vi.mock('../../src/crypto.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  writeConsentEvent: vi.fn(async (e: any) => {
    consentEvents.push(e);
    return 'consent-events/test';
  }),
}));

import * as db from '../../src/db.js';
import { buildApp } from '../../src/app.js';
import { initCounterKeys } from '../../src/counter/keys.js';
import { signLink } from '../../src/counter/links.js';
import { SEALED_CORE_JS, SEALED_JS, SEALED_JS_SRI } from '../../src/counter/sealedScript.js';
import { contactReceivePage, contactSendPage } from '../../src/counter/pages.js';
import {
  SealedRefusal,
  assertSealedBody,
  checkPublicKey,
  keyIdOf,
  looksLikeText,
  openSealed,
  sealedAad,
  sweepSealedContacts,
} from '../../src/domain/sealedContact.js';
import { lintHumanCopy } from '../../src/email/lint.js';
import type { Config } from '../../src/config.js';

// ---------------------------------------------------------------------------
// The browser half, run as the browser runs it.
// ---------------------------------------------------------------------------
type Sealed = {
  b64u(b: ArrayBuffer | Uint8Array): string;
  unb64u(s: string): Uint8Array;
  keyIdOf(raw: Uint8Array): Promise<string>;
  makeKeyPair(): Promise<{ privateKey: CryptoKey; publicRaw: Uint8Array; key_id: string }>;
  seal(details: unknown, recipient: { key_id: string; public_key: string }, matchId: string): Promise<any>;
  open(env: any, priv: CryptoKey, publicRaw: Uint8Array, matchId: string): Promise<any>;
  makeDeviceKey(): Promise<CryptoKey>;
  sealLocal(obj: unknown, k: CryptoKey): Promise<{ iv: Uint8Array; ct: Uint8Array }>;
  openLocal(box: { iv: Uint8Array; ct: Uint8Array }, k: CryptoKey): Promise<any>;
};
const S: Sealed = new Function(`${SEALED_CORE_JS}\nreturn OSB_SEALED;`)();

const MARK_ADDRESS = '12 Example Street, Exampleton';
const MARK_PHONE = '0412 345 678';
const MATCH = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const ANA = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const BEPPE = 'cccccccc-3333-4333-8333-cccccccccccc';

describe('the crypto round trip, with the script the page serves', () => {
  it('seals to one browser key and opens with its private half only', async () => {
    const bob = await S.makeKeyPair();
    // The private half cannot be exported by anything on the page.
    expect(bob.privateKey.extractable).toBe(false);
    await expect(webcrypto.subtle.exportKey('pkcs8', bob.privateKey as any)).rejects.toThrow();
    const recipient = { key_id: bob.key_id, public_key: S.b64u(bob.publicRaw) };
    const env = await S.seal({ address: MARK_ADDRESS, phone: MARK_PHONE }, recipient, MATCH);
    // The envelope is the only thing that ever leaves the browser, and it
    // carries nothing readable.
    const wire = JSON.stringify(env);
    expect(wire).not.toContain('Example');
    expect(wire).not.toContain('0412');
    // Padded to 256 bytes plus the GCM tag, so the length says little.
    expect((S.unb64u(env.ct).length - 16) % 256).toBe(0);
    const back = await S.open(env, bob.privateKey, bob.publicRaw, MATCH);
    expect(back).toEqual({ address: MARK_ADDRESS, phone: MARK_PHONE });
  });

  it('opens nothing with the wrong key, on the wrong introduction, or tampered', async () => {
    const bob = await S.makeKeyPair();
    const eve = await S.makeKeyPair();
    const env = await S.seal({ phone: MARK_PHONE }, { key_id: bob.key_id, public_key: S.b64u(bob.publicRaw) }, MATCH);
    await expect(S.open(env, eve.privateKey, eve.publicRaw, MATCH)).rejects.toThrow();
    await expect(S.open(env, bob.privateKey, bob.publicRaw, randomUUID())).rejects.toThrow();
    await expect(S.open({ ...env, key_id: eve.key_id }, bob.privateKey, bob.publicRaw, MATCH)).rejects.toThrow();
    const ct = S.unb64u(env.ct);
    ct[5] ^= 1;
    await expect(S.open({ ...env, ct: S.b64u(ct) }, bob.privateKey, bob.publicRaw, MATCH)).rejects.toThrow();
  });

  it('agrees with the server on the key id, and the server accepts the key', async () => {
    const k = await S.makeKeyPair();
    expect(keyIdOf(k.publicRaw)).toBe(k.key_id);
    const raw = await checkPublicKey(S.b64u(k.publicRaw));
    expect(raw.length).toBe(65);
    // Not a point on the curve: refused.
    const bad = new Uint8Array(65).fill(7);
    bad[0] = 4;
    await expect(checkPublicKey(S.b64u(bad))).rejects.toBeInstanceOf(SealedRefusal);
    expect(sealedAad(MATCH, k.key_id)).toBe(`osb-sealed-contact-v1|${MATCH}|${k.key_id}`);
  });

  it('keeps remembered details sealed under a device key that cannot leave', async () => {
    const dk = await S.makeDeviceKey();
    expect(dk.extractable).toBe(false);
    const box = await S.sealLocal({ address: MARK_ADDRESS }, dk);
    expect(Buffer.from(box.ct).toString('latin1')).not.toContain('Example');
    expect(await S.openLocal(box, dk)).toEqual({ address: MARK_ADDRESS });
  });

  it('is served with an SRI hash that matches what is served', () => {
    const want = `sha384-${createHash('sha384').update(SEALED_JS, 'utf8').digest('base64')}`;
    expect(SEALED_JS_SRI).toBe(want);
  });
});

// ---------------------------------------------------------------------------
describe('the door that refuses plaintext', () => {
  let keyId: string;
  let good: any;
  beforeAll(async () => {
    const bob = await S.makeKeyPair();
    keyId = bob.key_id;
    good = await S.seal({ address: MARK_ADDRESS }, { key_id: bob.key_id, public_key: S.b64u(bob.publicRaw) }, MATCH);
  });
  const refused = (body: unknown, keys = [keyId]) => {
    try {
      assertSealedBody(body, keys);
    } catch (e) {
      expect(e).toBeInstanceOf(SealedRefusal);
      // The refusal names the rule and never the value.
      expect(String((e as Error).message)).not.toContain('Example');
      expect(String((e as Error).message)).not.toContain('0412');
      return (e as SealedRefusal).code;
    }
    return 'accepted';
  };

  it('accepts scrambled copies for keys the recipient has', () => {
    expect(refused({ decision: 'yes', envelopes: [good] })).toBe('accepted');
    expect(refused({ decision: 'yes', pin: '123456', envelopes: [good] })).toBe('accepted');
  });

  it('refuses any readable field, anywhere', () => {
    expect(refused({ decision: 'yes', envelopes: [good], address: MARK_ADDRESS })).toBe('plaintext_refused');
    expect(refused({ decision: 'yes', envelopes: [good], phone: MARK_PHONE })).toBe('plaintext_refused');
    expect(refused({ decision: 'yes', envelopes: [{ ...good, note: MARK_ADDRESS }] })).toBe('plaintext_refused');
    // Plain words dressed up as a copy.
    const words = Buffer.from(`${MARK_ADDRESS} and call ${MARK_PHONE} after five`).toString('base64url');
    expect(refused({ decision: 'yes', envelopes: [{ ...good, ct: words }] })).toBe('plaintext_refused');
    // A value that is not base64url at all.
    expect(refused({ decision: 'yes', envelopes: [{ ...good, ct: MARK_ADDRESS }] })).toBe('bad_envelope');
  });

  it('refuses copies for keys the recipient does not have, and malformed ones', () => {
    expect(refused({ decision: 'yes', envelopes: [good] }, ['f'.repeat(32)])).toBe('unknown_key');
    expect(refused({ decision: 'yes', envelopes: [good, good] })).toBe('unknown_key');
    expect(refused({ decision: 'yes', envelopes: [] })).toBe('bad_envelope');
    expect(refused({ decision: 'no', envelopes: [good] })).toBe('bad_request');
    expect(refused({ decision: 'yes', envelopes: [{ ...good, iv: 'AAAA' }] })).toBe('bad_envelope');
    expect(refused({ decision: 'yes', pin: 'not a pin', envelopes: [good] })).toBe('bad_request');
    expect(refused([good])).toBe('bad_request');
  });

  it('reads random bytes as ciphertext and words as words', () => {
    expect(looksLikeText(webcrypto.getRandomValues(new Uint8Array(272)))).toBe(false);
    expect(looksLikeText(Buffer.from('a line of ordinary words that someone typed out'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The routes, against a small stand-in database that records every statement.
// ---------------------------------------------------------------------------
const cfg = {
  envName: 'dev',
  port: 0,
  publicOrigin: 'https://mcp.test',
  counterOrigin: 'https://my.test',
  legacyCounterHosts: [],
  consentLogBucket: 'x',
  identityKeyArn: 'x',
  bedrockModelId: 'x',
  registrationMode: 'dev-bootstrap',
  region: 'us-east-1',
  quotas: { maxOpenCards: 20, maxPublishesPerDay: 20, maxOffersPerHour: 6 },
  docsBase: 'https://openswitchboard.ai/docs',
} as unknown as Config;

const SID = 'osb_cs_testsessionvaluetestsessionvalue';
const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex');

interface World {
  link: any;
  keys: { account_id: string; key_id: string; public_key: Buffer }[];
  sealed: any[];
  copies: any[];
  statements: { sql: string; params: any[] }[];
  elevated: boolean;
  matchState: string;
}
let w: World;

function fakePool() {
  const rows = (r: any[]) => ({ rows: r, rowCount: r.length });
  const query = async (sql: string, params: any[] = []) => {
    w.statements.push({ sql, params });
    if (/FROM counter_sessions/.test(sql) && /SELECT id, account_id/.test(sql)) {
      return params[0] === sha256hex(SID)
        ? rows([
            {
              id: 'sess-1',
              account_id: BEPPE,
              pin_ok_until: w.elevated ? new Date(Date.now() + 60_000) : null,
              elevated_via: 'pin',
              oauth_ctx: null,
            },
          ])
        : rows([]);
    }
    if (/SELECT suspended_at FROM accounts/.test(sql)) return rows([]);
    if (/SELECT \* FROM approval_links WHERE id = \$1$/.test(sql.trim())) {
      return rows(w.link && w.link.id === params[0] ? [w.link] : []);
    }
    if (/UPDATE approval_links SET used_at = now\(\)/.test(sql)) {
      if (w.link && !w.link.used_at) {
        w.link.used_at = new Date();
        return rows([{ id: w.link.id }]);
      }
      return rows([]);
    }
    if (/UPDATE approval_links SET decision/.test(sql)) {
      w.link.decision = params[1];
      return rows([]);
    }
    if (/SELECT \* FROM matches WHERE id = \$1/.test(sql)) {
      return rows([
        { id: MATCH, account_want: ANA, account_have: BEPPE, state: w.matchState, stage: 3, category: 'goods.bicycle.mountain' },
      ]);
    }
    if (/FROM contact_keys WHERE account_id/.test(sql)) {
      return rows(w.keys.filter((k) => k.account_id === params[0]));
    }
    if (/UPDATE sealed_contacts SET replaced_at/.test(sql)) return rows([]);
    if (/INSERT INTO sealed_contacts/.test(sql)) {
      const id = randomUUID();
      const row = {
        id,
        match_id: params[0],
        sender_account: params[1],
        recipient_account: params[2],
        created_at: new Date(),
        expires_at: new Date(Date.now() + 7 * 86_400_000),
        opened_at: null,
        replaced_at: null,
        missed_at: null,
      };
      w.sealed.push(row);
      return rows([{ id, expires_at: row.expires_at }]);
    }
    if (/INSERT INTO sealed_contact_copies/.test(sql)) {
      w.copies.push({ sealed_id: params[0], key_id: params[1], epk: params[2], iv: params[3], ct: params[4] });
      return rows([]);
    }
    if (/SELECT s\.\* FROM sealed_contacts s JOIN matches m[\s\S]*FOR UPDATE OF s/.test(sql)) {
      if (w.matchState !== 'open' && w.matchState !== 'archived') return rows([]);
      return rows(w.sealed.filter((s) => s.id === params[0] && s.recipient_account === params[1]));
    }
    if (/SELECT key_id, epk, iv, ct FROM sealed_contact_copies/.test(sql)) {
      return rows(w.copies.filter((c) => c.sealed_id === params[0] && c.key_id === params[1]));
    }
    if (/DELETE FROM sealed_contact_copies WHERE sealed_id = \$1/.test(sql)) {
      const n = w.copies.length;
      w.copies = w.copies.filter((c) => c.sealed_id !== params[0]);
      return { rows: [], rowCount: n - w.copies.length };
    }
    if (/UPDATE sealed_contacts SET opened_at = now\(\)/.test(sql)) {
      for (const s of w.sealed) if (s.id === params[0]) s.opened_at = new Date();
      return rows([]);
    }
    if (/DELETE FROM sealed_contact_copies WHERE sealed_id IN/.test(sql)) {
      const dead = new Set(w.sealed.filter((s) => s.expires_at.getTime() <= Date.now()).map((s) => s.id));
      const n = w.copies.length;
      w.copies = w.copies.filter((c) => !dead.has(c.sealed_id));
      return { rows: [], rowCount: n - w.copies.length };
    }
    if (/DELETE FROM sealed_contacts\s+WHERE expires_at/.test(sql)) {
      const n = w.sealed.length;
      w.sealed = w.sealed.filter((s) => s.expires_at.getTime() > Date.now() - 86_400_000);
      return { rows: [], rowCount: n - w.sealed.length };
    }
    return rows([]);
  };
  return {
    query,
    connect: async () => ({ query, release: () => {} }),
  } as any;
}

let app: FastifyInstance;
let bob: Awaited<ReturnType<Sealed['makeKeyPair']>>;

beforeAll(async () => {
  process.env.COUNTER_LINK_HMAC_KEY = 'a'.repeat(64);
  process.env.COUNTER_COOKIE_KEY = 'b'.repeat(64);
  await initCounterKeys(cfg);
  app = buildApp(cfg);
  await app.ready();
  bob = await S.makeKeyPair();
});

let logged: string[];
beforeEach(() => {
  consentEvents.length = 0;
  const id = randomUUID();
  const row = {
    id,
    account_id: BEPPE,
    action: 'contact-send',
    ref_id: MATCH,
    amount: null,
    ccy: null,
    counterparty_account: ANA,
    payload: null,
    created_at: new Date(),
    expires_at: new Date(Date.now() + 10 * 60_000),
    used_at: null,
    decision: null,
  };
  w = {
    link: { ...row, token_hash: '' },
    keys: [{ account_id: ANA, key_id: bob.key_id, public_key: Buffer.from(bob.publicRaw) }],
    sealed: [],
    copies: [],
    statements: [],
    elevated: true,
    matchState: 'open',
  };
  w.link.token_hash = sha256hex(signLink(row));
  vi.spyOn(db, 'getPool').mockReturnValue(fakePool());
  // Every line anything writes, from the request log to a stray console call.
  logged = [];
  const keep = (chunk: unknown) => {
    logged.push(String(chunk));
    return true;
  };
  vi.spyOn(process.stdout, 'write').mockImplementation(keep as any);
  vi.spyOn(process.stderr, 'write').mockImplementation(keep as any);
  for (const m of ['log', 'warn', 'error', 'info'] as const) {
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logged.push(a.map(String).join(' ')));
  }
});
afterEach(() => {
  vi.restoreAllMocks();
});

const token = () => signLink(w.link);
const post = (url: string, body: unknown) =>
  app.inject({
    method: 'POST',
    url,
    headers: {
      host: 'my.test',
      cookie: `__Host-osb_counter=${SID}`,
      'content-type': 'application/json',
      origin: 'https://my.test',
    },
    payload: JSON.stringify(body),
  });

/** Nothing readable anywhere: not in a statement, not in a log line. */
function assertNothingReadable() {
  const everything = [
    ...w.statements.map((s) => `${s.sql} ${JSON.stringify(s.params, (_k, v) => (Buffer.isBuffer(v) ? v.toString('latin1') : v))}`),
    ...logged,
  ].join('\n');
  expect(everything).not.toContain('Example');
  expect(everything).not.toContain('0412');
  expect(everything).not.toContain('345 678');
}

describe('the send press', () => {
  it('refuses a request carrying an address or a phone number, and stores and logs nothing', async () => {
    const env = await S.seal({ address: MARK_ADDRESS }, { key_id: bob.key_id, public_key: S.b64u(bob.publicRaw) }, MATCH);
    for (const body of [
      { decision: 'yes', envelopes: [env], address: MARK_ADDRESS },
      { decision: 'yes', envelopes: [env], phone: MARK_PHONE },
      { decision: 'yes', address: MARK_ADDRESS, phone: MARK_PHONE },
    ]) {
      const r = await post(`/a/${encodeURIComponent(token())}/contact`, body);
      expect(r.statusCode).toBe(400);
      expect(r.json().error).toBe('plaintext_refused');
    }
    expect(w.sealed).toHaveLength(0);
    expect(w.copies).toHaveLength(0);
    expect(w.link.used_at).toBeNull();
    expect(consentEvents).toHaveLength(0);
    assertNothingReadable();
  });

  it('stores only ciphertext, burns the link and records the press', async () => {
    const env = await S.seal(
      { address: MARK_ADDRESS, phone: MARK_PHONE },
      { key_id: bob.key_id, public_key: S.b64u(bob.publicRaw) },
      MATCH,
    );
    const r = await post(`/a/${encodeURIComponent(token())}/contact`, { decision: 'yes', envelopes: [env] });
    expect(r.statusCode).toBe(200);
    expect(r.json().title).toBe('Sent');
    expect(w.sealed).toHaveLength(1);
    expect(w.copies).toHaveLength(1);
    expect(w.link.used_at).not.toBeNull();
    expect(w.link.decision).toBe('approved');
    // The consent log records the press: who, to whom, where. Never what.
    expect(consentEvents).toEqual([
      expect.objectContaining({ event: 'contact-send', account_id: BEPPE, recipient_account: ANA, match_id: MATCH }),
    ]);
    expect(JSON.stringify(consentEvents)).not.toMatch(/Example|0412/);
    assertNothingReadable();
    // A second press finds the link spent.
    const again = await post(`/a/${encodeURIComponent(token())}/contact`, { decision: 'yes', envelopes: [env] });
    expect(again.statusCode).toBe(410);
  });

  it('asks for the credential outside the window, before anything is stored', async () => {
    w.elevated = false;
    const env = await S.seal({ phone: MARK_PHONE }, { key_id: bob.key_id, public_key: S.b64u(bob.publicRaw) }, MATCH);
    const r = await post(`/a/${encodeURIComponent(token())}/contact`, { decision: 'yes', envelopes: [env] });
    expect(r.statusCode).toBe(401);
    expect(w.sealed).toHaveLength(0);
    expect(w.link.used_at).toBeNull();
  });
});

describe('opening deletes', () => {
  it('hands over the copy once, deletes every copy, and the page opens it', async () => {
    const env = await S.seal({ phone: MARK_PHONE }, { key_id: bob.key_id, public_key: S.b64u(bob.publicRaw) }, MATCH);
    await post(`/a/${encodeURIComponent(token())}/contact`, { decision: 'yes', envelopes: [env] });
    const id = w.sealed[0].id;
    const first = await openSealed(ANA, id, bob.key_id);
    expect(first.ok).toBe(true);
    expect(w.copies).toHaveLength(0);
    expect(w.sealed[0].opened_at).not.toBeNull();
    if (first.ok) {
      const d = await S.open(first.envelope, bob.privateKey, bob.publicRaw, first.match_id);
      expect(d).toEqual({ phone: MARK_PHONE });
    }
    const second = await openSealed(ANA, id, bob.key_id);
    expect(second).toEqual({ ok: false, reason: 'opened' });
    // Somebody else's account finds nothing at all.
    expect(await openSealed(BEPPE, id, bob.key_id)).toEqual({ ok: false, reason: 'not_found' });
  });

  it('opens nothing once the introduction is closed, as a report closes it', async () => {
    const env = await S.seal({ phone: MARK_PHONE }, { key_id: bob.key_id, public_key: S.b64u(bob.publicRaw) }, MATCH);
    await post(`/a/${encodeURIComponent(token())}/contact`, { decision: 'yes', envelopes: [env] });
    w.matchState = 'closed';
    expect(await openSealed(ANA, w.sealed[0].id, bob.key_id)).toEqual({ ok: false, reason: 'not_found' });
    expect(w.copies).toHaveLength(1);
  });

  it('deletes nothing when this browser holds none of the keys', async () => {
    const env = await S.seal({ phone: MARK_PHONE }, { key_id: bob.key_id, public_key: S.b64u(bob.publicRaw) }, MATCH);
    await post(`/a/${encodeURIComponent(token())}/contact`, { decision: 'yes', envelopes: [env] });
    const id = w.sealed[0].id;
    expect(await openSealed(ANA, id, 'e'.repeat(32))).toEqual({ ok: false, reason: 'no_key' });
    expect(w.copies).toHaveLength(1);
  });

  it('sweeps what nobody opened once its seven days are up', async () => {
    const env = await S.seal({ phone: MARK_PHONE }, { key_id: bob.key_id, public_key: S.b64u(bob.publicRaw) }, MATCH);
    await post(`/a/${encodeURIComponent(token())}/contact`, { decision: 'yes', envelopes: [env] });
    expect(await sweepSealedContacts()).toEqual({ copies: 0, sends: 0 });
    w.sealed[0].expires_at = new Date(Date.now() - 1000);
    expect((await sweepSealedContacts()).copies).toBe(1);
    expect(w.copies).toHaveLength(0);
    expect(await openSealed(ANA, w.sealed[0].id, bob.key_id)).toEqual({ ok: false, reason: 'expired' });
  });
});

describe('the pages', () => {
  const send = contactSendPage({
    token: 'tok',
    who: 'Alex',
    matchId: MATCH,
    slot: 'slot',
    keys: [{ key_id: 'a'.repeat(32), public_key: 'AAAA' }],
    ttlDays: 7,
    hasPin: true,
    hasPasskey: true,
    elevated: false,
  });
  const receive = contactReceivePage({ id: randomUUID(), who: 'Alex', matchId: MATCH, slot: 'slot', keyIds: [] });

  it('carries no inline script, only ours with its SRI hash', () => {
    for (const page of [send, receive]) {
      const scripts = [...page.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
      expect(scripts.length).toBe(1);
      expect(scripts[0][2].trim()).toBe('');
      expect(scripts[0][1]).toContain(`integrity="${SEALED_JS_SRI}"`);
      expect(scripts[0][1]).toMatch(/src="\/assets\/sealed\.js\?v=[0-9a-f]{12}"/);
    }
  });

  it('has no named boxes, so nothing readable can be submitted', () => {
    const form = send.match(/<form[\s\S]*?<\/form>/)![0];
    expect(form).toContain('method="dialog"');
    expect(form).not.toMatch(/<(input|textarea|select)\b[^>]*\bname=/);
    expect(form).toContain('Remember on this device');
  });

  it('says what happens, plainly, and warns before showing', () => {
    expect(send).toContain("Neither assistant sees them, and we can&#39;t read them.");
    expect(receive).toContain('This works once. Write it down or save it somewhere safe now');
    for (const page of [send, receive]) {
      const text = page.replace(/<style>[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ');
      expect(lintHumanCopy(text)).toEqual([]);
    }
  });

  it('is served with the stricter policy and is never cached', async () => {
    const r = await app.inject({
      method: 'GET',
      url: `/a/${encodeURIComponent(token())}`,
      headers: { host: 'my.test', cookie: `__Host-osb_counter=${SID}` },
    });
    expect(r.statusCode).toBe(200);
    const csp = String(r.headers['content-security-policy']);
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(csp).toContain("connect-src 'self'");
    expect(r.headers['cache-control']).toBe('no-store');
    // Viewing spends nothing.
    expect(w.link.used_at).toBeNull();
  });

  it('serves the script itself from this origin', async () => {
    const r = await app.inject({ method: 'GET', url: '/assets/sealed.js', headers: { host: 'my.test' } });
    expect(r.statusCode).toBe(200);
    expect(r.body).toBe(SEALED_JS);
    expect(String(r.headers['content-type'])).toMatch(/javascript/);
  });
});
