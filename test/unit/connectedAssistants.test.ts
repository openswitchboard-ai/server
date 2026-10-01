/**
 * Connected assistants: seeing and ending an OAuth sign-in (1 October 2026).
 *
 * A person could revoke the agent keys they issued by hand but not an
 * assistant that signed in through OAuth; the only way to end one was Stop,
 * which ends everything. These hold the per-assistant door: the list shows only
 * this account's live clients, Disconnect ends one client on one account and
 * nothing else, the ended tokens are refused at the bearer check and at the
 * refresh, and the route and page around it behave.
 *
 * The tables are a small in-memory world that honours the columns the real
 * statements filter on, so mint, authenticate, disconnect and refuse is a
 * genuine round trip through the same code paths the service runs.
 */
import { createHash } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

vi.mock('../../src/crypto.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  writeConsentEvent: vi.fn(async () => 'consent/key'),
}));
// The rest of the settings page reads an account row and encrypted fields
// this world does not model; those readers answer "nothing set".
vi.mock('../../src/domain/counterOps.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  emailSettings: vi.fn(async () => ({
    freqMatches: 'immediate',
    freqDigests: 'daily',
    blindMode: false,
    unreachable: false,
    complaintSuppressed: false,
  })),
}));
vi.mock('../../src/domain/profile.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  readSharedProfile: vi.fn(async () => ({ firstName: '', locality: '' })),
}));
vi.mock('../../src/domain/arrangement.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  readArrangement: vi.fn(async () => ({})),
}));

import { buildApp } from '../../src/app.js';
import { authenticate } from '../../src/auth/oauth.js';
import * as ca from '../../src/auth/connectedAssistants.js';
import { assistantDisconnectLimiter } from '../../src/abuseLimit.js';
import * as home from '../../src/counter/pagesHome.js';
import * as cpages from '../../src/counter/pages.js';
import { writeConsentEvent } from '../../src/crypto.js';
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
} as unknown as Config;

const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex');

const ME = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const SMITHERY = 'cccccccc-3333-4333-8333-cccccccccccc';
const CLI = 'dddddddd-4444-4444-8444-dddddddddddd';
const NEVER = 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee';

const MY_COOKIE = 'osb_cs_my-session';
const OTHER_COOKIE = 'osb_cs_other-session';

interface TokenRow {
  token_hash: string;
  kind: 'access' | 'refresh' | 'api-key';
  account_id: string;
  client_id: string | null;
  scope: string;
  revoked: boolean;
  suspended: boolean;
  expires_at: Date;
  created_at: Date;
  last_used_at: Date | null;
  family_id: string | null;
  family_started_at: Date | null;
  rotated_from: string | null;
  manual_version: number | null;
  manual_start_sent_at: Date | null;
}
interface CodeRow {
  code_hash: string;
  account_id: string;
  client_id: string;
  used: boolean;
}
interface World {
  tokens: TokenRow[];
  codes: CodeRow[];
  clients: { client_id: string; client_name: string; redirect_uris: string[] }[];
  sessions: Map<string, string>;
}
let world: World;

const live = (t: TokenRow) => !t.revoked && t.expires_at > new Date();

const fakePool = {
  query: async (sql: string, params: any[] = []) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    const rows = (r: any[], rowCount = r.length) => ({ rows: r, rowCount });

    if (s.startsWith('SELECT id, account_id, pin_ok_until, elevated_via, oauth_ctx FROM counter_sessions')) {
      const acct = world.sessions.get(params[0]);
      return rows(acct ? [{ id: `sess-${acct}`, account_id: acct, pin_ok_until: null, elevated_via: null, oauth_ctx: null }] : []);
    }
    // The bearer check, verbatim.
    if (s.startsWith('SELECT account_id, client_id, scope, manual_version, manual_notified_at, manual_start_sent_at FROM oauth_tokens')) {
      const [hash, kind] = params;
      const t = world.tokens.find((x) => x.token_hash === hash && x.kind === kind && live(x) && !x.suspended);
      return rows(t ? [{ ...t, manual_notified_at: null }] : []);
    }
    if (s.startsWith('UPDATE oauth_tokens SET last_used_at')) {
      const t = world.tokens.find((x) => x.token_hash === params[0]);
      if (t) t.last_used_at = new Date();
      return rows([]);
    }
    // ---- the refresh endpoint ----
    if (s.startsWith('SELECT * FROM oauth_tokens WHERE token_hash')) {
      const t = world.tokens.find((x) => x.token_hash === params[0] && x.kind === 'refresh');
      return rows(t ? [t] : []);
    }
    if (s.startsWith('WITH old AS ( UPDATE oauth_tokens SET revoked = true')) {
      const [accessHash, refreshHash, accountId, clientId, scope, , familyId, familyStartedAt, , oldHash] = params;
      const old = world.tokens.find((x) => x.token_hash === oldHash && x.kind === 'refresh' && !x.revoked);
      if (!old) return rows([]);
      old.revoked = true;
      const shared = { account_id: accountId, client_id: clientId, scope, family_id: familyId, family_started_at: familyStartedAt };
      world.tokens.push(
        tok({ ...shared, token_hash: accessHash, kind: 'access' }),
        tok({ ...shared, token_hash: refreshHash, kind: 'refresh', rotated_from: oldHash }),
      );
      return rows([{ token_hash: accessHash }, { token_hash: refreshHash }]);
    }
    if (s.startsWith('UPDATE oauth_tokens SET revoked = true WHERE family_id')) {
      for (const t of world.tokens) if (t.family_id === params[0]) t.revoked = true;
      return rows([]);
    }
    // ---- connected assistants ----
    if (s.startsWith('SELECT c.client_id, c.client_name, c.redirect_uris')) {
      const out: any[] = [];
      for (const c of world.clients) {
        const mine = world.tokens.filter(
          (t) => t.account_id === params[0] && t.client_id === c.client_id && (t.kind === 'access' || t.kind === 'refresh'),
        );
        const alive = mine.filter(live);
        if (!alive.length) continue;
        const min = (ds: (Date | null)[]) => ds.filter(Boolean).sort((a, b) => +a! - +b!)[0] ?? null;
        const max = (ds: (Date | null)[]) => ds.filter(Boolean).sort((a, b) => +b! - +a!)[0] ?? null;
        out.push({
          client_id: c.client_id,
          client_name: c.client_name,
          redirect_uris: c.redirect_uris,
          first_connected: min(alive.map((t) => t.family_started_at)) ?? min(alive.map((t) => t.created_at)),
          last_used: max([...mine.map((t) => t.last_used_at), ...mine.map((t) => t.created_at)]),
        });
      }
      out.sort((a, b) => +b.last_used - +a.last_used);
      return rows(out);
    }
    if (s.startsWith('UPDATE oauth_codes SET used = true WHERE account_id')) {
      let n = 0;
      for (const c of world.codes) {
        if (c.account_id === params[0] && c.client_id === params[1] && !c.used) {
          c.used = true;
          n++;
        }
      }
      return rows([], n);
    }
    if (s.startsWith('UPDATE oauth_tokens SET revoked = true WHERE account_id = $1 AND client_id = $2::uuid')) {
      let n = 0;
      for (const t of world.tokens) {
        if (
          t.account_id === params[0] &&
          t.client_id === params[1] &&
          (t.kind === 'access' || t.kind === 'refresh') &&
          !t.revoked
        ) {
          t.revoked = true;
          n++;
        }
      }
      return rows([], n);
    }
    if (s.startsWith('SELECT client_name FROM oauth_clients WHERE client_id')) {
      const c = world.clients.find((x) => x.client_id === params[0]);
      return rows(c ? [{ client_name: c.client_name }] : []);
    }
    if (s.startsWith('SELECT c.client_name FROM oauth_clients c')) {
      const [acct, clientId] = params;
      const c = world.clients.find((x) => x.client_id === clientId);
      const mine = world.tokens.filter((t) => t.account_id === acct && t.client_id === clientId);
      return rows(c && mine.length && !mine.some(live) ? [{ client_name: c.client_name }] : []);
    }
    // Everything else the settings page and the MCP surface read: nothing on file.
    return rows([]);
  },
} as any;

let seq = 0;
function tok(over: Partial<TokenRow>): TokenRow {
  return {
    token_hash: `hash-${++seq}`,
    kind: 'access',
    account_id: ME,
    client_id: SMITHERY,
    scope: 'switchboard',
    revoked: false,
    suspended: false,
    expires_at: over.kind === 'refresh' ? new Date(Date.now() + 30 * 86_400_000) : new Date(Date.now() + 3600_000),
    created_at: new Date(),
    last_used_at: null,
    family_id: null,
    family_started_at: null,
    rotated_from: null,
    manual_version: null,
    manual_start_sent_at: null,
    ...over,
  };
}

/** One authorization: a live access + refresh pair for account × client. Returns the raw strings. */
function signIn(account: string, client: string, opts: { at?: Date; family?: string } = {}) {
  const n = ++seq;
  const access = `osb_at_access-${n}`;
  const refresh = `osb_rt_refresh-${n}`;
  const at = opts.at ?? new Date();
  const family = opts.family ?? `ffffffff-0000-4000-8000-${String(n).padStart(12, '0')}`;
  world.tokens.push(
    tok({ token_hash: sha256hex(access), kind: 'access', account_id: account, client_id: client, family_id: family, family_started_at: at, created_at: at }),
    tok({ token_hash: sha256hex(refresh), kind: 'refresh', account_id: account, client_id: client, family_id: family, family_started_at: at, created_at: at }),
  );
  return { access, refresh };
}

const bearer = (token: string) => ({ headers: { authorization: `Bearer ${token}` } }) as any;

let app: FastifyInstance;

beforeAll(async () => {
  app = buildApp(cfg);
  await app.ready();
});

beforeEach(() => {
  seq = 0;
  world = {
    tokens: [],
    codes: [],
    clients: [
      { client_id: SMITHERY, client_name: 'Smithery', redirect_uris: ['https://connect.smithery.ai/oauth/callback'] },
      { client_id: CLI, client_name: 'Claude Code', redirect_uris: ['http://localhost:8976/cb', 'http://127.0.0.1:8976/cb'] },
      { client_id: NEVER, client_name: 'Never signed in', redirect_uris: ['https://never.example/cb'] },
    ],
    sessions: new Map([
      [sha256hex(MY_COOKIE), ME],
      [sha256hex(OTHER_COOKIE), OTHER],
    ]),
  };
  vi.spyOn(db, 'getPool').mockReturnValue(fakePool);
  vi.spyOn(db, 'dbConfigured').mockReturnValue(true);
  vi.mocked(writeConsentEvent).mockClear();
  assistantDisconnectLimiter.reset();
});

// ---------------------------------------------------------------------------
describe('the list', () => {
  it('holds only this account’s clients with a usable token, one row each', async () => {
    signIn(ME, SMITHERY, { at: new Date(Date.now() - 5 * 86_400_000) });
    signIn(ME, SMITHERY); // a second authorization of the same client: still one row
    signIn(ME, CLI);
    signIn(OTHER, NEVER); // somebody else's
    const list = await ca.connectedAssistants(ME);
    expect(list.map((a) => a.clientId).sort()).toEqual([CLI, SMITHERY].sort());
    const smithery = list.find((a) => a.clientId === SMITHERY)!;
    expect(smithery.clientName).toBe('Smithery');
    expect(smithery.redirectHost).toBe('connect.smithery.ai');
    // First connected is the earliest live press, not the latest.
    expect(Date.now() - smithery.firstConnected.getTime()).toBeGreaterThan(4 * 86_400_000);
    expect(list.find((a) => a.clientId === CLI)!.redirectHost).toBe('localhost, 127.0.0.1');
  });

  it('a live refresh token alone keeps a client on the list; revoked or expired ones do not', async () => {
    // The hour is up on the access token, the refresh token is still good.
    world.tokens.push(
      tok({ kind: 'access', client_id: SMITHERY, expires_at: new Date(Date.now() - 1000) }),
      tok({ kind: 'refresh', client_id: SMITHERY }),
      // Everything CLI holds is dead.
      tok({ kind: 'access', client_id: CLI, revoked: true }),
      tok({ kind: 'refresh', client_id: CLI, expires_at: new Date(Date.now() - 1000) }),
    );
    expect((await ca.connectedAssistants(ME)).map((a) => a.clientId)).toEqual([SMITHERY]);
  });

  it('an agent key is not an OAuth sign-in and is not listed', async () => {
    world.tokens.push(tok({ kind: 'api-key', client_id: null }));
    expect(await ca.connectedAssistants(ME)).toEqual([]);
  });

  it('the redirect host is read from the registered address, or left blank', () => {
    expect(ca.redirectHostOf(['https://connect.smithery.ai/cb'])).toBe('connect.smithery.ai');
    expect(ca.redirectHostOf(['http://[::1]:9/cb'])).toBe('[::1]');
    expect(ca.redirectHostOf('nonsense')).toBe('');
    expect(ca.redirectHostOf(['not a url'])).toBe('');
  });
});

// ---------------------------------------------------------------------------
describe('disconnecting', () => {
  it('ends that client on this account and nothing else', async () => {
    const mine = signIn(ME, SMITHERY);
    const myCli = signIn(ME, CLI);
    const theirs = signIn(OTHER, SMITHERY);
    world.tokens.push(tok({ kind: 'api-key', client_id: null })); // my agent key
    world.codes.push(
      { code_hash: 'c1', account_id: ME, client_id: SMITHERY, used: false },
      { code_hash: 'c2', account_id: OTHER, client_id: SMITHERY, used: false },
    );

    const done = await ca.disconnectAssistant(ME, SMITHERY);
    expect(done).toEqual({ revoked: 2, clientName: 'Smithery' });

    expect(await authenticate(bearer(mine.access))).toBeUndefined();
    // The other client on my account, the same client on another account, and
    // my agent key are all untouched.
    expect((await authenticate(bearer(myCli.access)))?.accountId).toBe(ME);
    expect((await authenticate(bearer(theirs.access)))?.accountId).toBe(OTHER);
    expect(world.tokens.find((t) => t.kind === 'api-key')!.revoked).toBe(false);
    // A sign-in half way through for this pair cannot finish; the other account's can.
    expect(world.codes.map((c) => c.used)).toEqual([true, false]);
    // The registration itself stays: the same assistant can be authorised again.
    expect(world.clients.map((c) => c.client_id)).toContain(SMITHERY);
    expect((await ca.connectedAssistants(ME)).map((a) => a.clientId)).toEqual([CLI]);
    expect((await ca.connectedAssistants(OTHER)).map((a) => a.clientId)).toEqual([SMITHERY]);
  });

  it('reaches every refresh family the client holds here, the suspended ones included', async () => {
    signIn(ME, SMITHERY);
    signIn(ME, SMITHERY);
    world.tokens.push(tok({ kind: 'refresh', client_id: SMITHERY, suspended: true, family_id: 'f-stopped' }));
    const done = await ca.disconnectAssistant(ME, SMITHERY);
    expect(done.revoked).toBe(5);
    expect(world.tokens.every((t) => t.revoked)).toBe(true);
  });

  it('writes the disconnect to the consent log, once, and only when something was ended', async () => {
    signIn(ME, SMITHERY);
    await ca.disconnectAssistant(ME, SMITHERY);
    expect(vi.mocked(writeConsentEvent)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(writeConsentEvent).mock.calls[0][0]).toMatchObject({
      event: 'assistant-disconnected',
      account_id: ME,
      client_id: SMITHERY,
      tokens_revoked: 2,
    });
    expect(await ca.disconnectAssistant(ME, SMITHERY)).toEqual({ revoked: 0 });
    expect(vi.mocked(writeConsentEvent)).toHaveBeenCalledTimes(1);
  });

  it('a client id that is not one touches nothing', async () => {
    signIn(ME, SMITHERY);
    expect(await ca.disconnectAssistant(ME, "x' OR 1=1 --")).toEqual({ revoked: 0 });
    expect(world.tokens.some((t) => t.revoked)).toBe(false);
  });

  it('the assistant’s next MCP call gets 401', async () => {
    const { access } = signIn(ME, SMITHERY);
    const call = () =>
      app.inject({
        method: 'POST',
        url: '/mcp',
        headers: {
          host: 'mcp.test',
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${access}`,
        },
        payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      });
    expect((await call()).statusCode).toBe(200);
    await ca.disconnectAssistant(ME, SMITHERY);
    expect((await call()).statusCode).toBe(401);
  });

  it('and its refresh fails', async () => {
    const { refresh } = signIn(ME, SMITHERY);
    await ca.disconnectAssistant(ME, SMITHERY);
    const r = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: { host: 'mcp.test', 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh }).toString(),
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe('invalid_grant');
    expect(world.tokens.filter(live)).toEqual([]);
  });

  it('a refresh that read its token just before the disconnect mints nothing', async () => {
    const { refresh } = signIn(ME, SMITHERY);
    // The disconnect lands between the token endpoint reading the row and
    // rotating it: here, while it asks whether the account is stopped.
    const base = fakePool.query;
    vi.spyOn(db, 'getPool').mockReturnValue({
      query: async (sql: string, params: any[] = []) => {
        if (sql.startsWith('SELECT suspended_at FROM accounts')) {
          for (const t of world.tokens) if (t.client_id === SMITHERY) t.revoked = true;
        }
        return base(sql, params);
      },
    } as any);
    const r = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: { host: 'mcp.test', 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh }).toString(),
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error_description).toBe('refresh-token-revoked');
    expect(world.tokens).toHaveLength(2); // nothing new was minted
  });
});

// ---------------------------------------------------------------------------
describe('POST /assistants/disconnect', () => {
  const press = (clientId: string, cookie?: string, extra: Record<string, string> = {}) =>
    app.inject({
      method: 'POST',
      url: '/assistants/disconnect',
      headers: {
        host: 'my.test',
        'content-type': 'application/x-www-form-urlencoded',
        ...(cookie ? { cookie: `__Host-osb_counter=${cookie}` } : {}),
        ...extra,
      },
      payload: new URLSearchParams({ client_id: clientId }).toString(),
    });

  it('needs a signed-in session', async () => {
    signIn(ME, SMITHERY);
    const r = await press(SMITHERY);
    expect(r.statusCode).toBe(401);
    expect(r.json().error).toBe('not_signed_in');
    expect(world.tokens.some((t) => t.revoked)).toBe(false);
  });

  it('is turned away from another site', async () => {
    signIn(ME, SMITHERY);
    const r = await press(SMITHERY, MY_COOKIE, { origin: 'https://evil.example' });
    expect(r.statusCode).toBe(403);
    expect(world.tokens.some((t) => t.revoked)).toBe(false);
  });

  it('refuses an agent credential, like every route on these pages', async () => {
    const { access } = signIn(ME, SMITHERY);
    const r = await press(SMITHERY, undefined, { authorization: `Bearer ${access}` });
    expect(r.statusCode).toBe(403);
  });

  it('turns away a client id that is not one', async () => {
    for (const bad of ['', 'nope', `${SMITHERY}x`, "'; DROP TABLE oauth_tokens; --"]) {
      const r = await press(bad, MY_COOKIE);
      expect(r.statusCode, bad).toBe(400);
      expect(r.body, bad).toContain('That assistant is unknown.');
    }
  });

  it('disconnects and goes back to settings with the notice', async () => {
    signIn(ME, SMITHERY);
    const r = await press(SMITHERY, MY_COOKIE);
    expect(r.statusCode).toBe(303);
    expect(r.headers.location).toBe(`/settings?saved=disconnected&assistant=${SMITHERY}`);
    expect(world.tokens.every((t) => t.revoked)).toBe(true);

    const page = await app.inject({
      method: 'GET',
      url: r.headers.location as string,
      headers: { host: 'my.test', cookie: `__Host-osb_counter=${MY_COOKIE}` },
    });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("Disconnected. Smithery can&#39;t reach your account any more.");
    expect(page.body).toContain(home.CONNECTED_ASSISTANTS_EMPTY);
  });

  it('only ends it for the account that pressed', async () => {
    signIn(ME, SMITHERY);
    const theirs = signIn(OTHER, SMITHERY);
    await press(SMITHERY, MY_COOKIE);
    expect((await authenticate(bearer(theirs.access)))?.accountId).toBe(OTHER);
  });

  it('says so when there was nothing left to end', async () => {
    const r = await press(NEVER, MY_COOKIE);
    expect(r.statusCode).toBe(303);
    expect(r.headers.location).toBe('/settings?saved=already-disconnected');
  });

  it('is paced: twenty an hour per account', async () => {
    for (let i = 0; i < 20; i++) expect((await press(SMITHERY, MY_COOKIE)).statusCode, String(i)).toBe(303);
    const r = await press(SMITHERY, MY_COOKIE);
    expect(r.statusCode).toBe(429);
    // Another account has its own count.
    expect((await press(SMITHERY, OTHER_COOKIE)).statusCode).toBe(303);
  });

  it('is in the enumerated human-only route class', async () => {
    const { COUNTER_ROUTE_TABLE } = await import('../../src/counter/routes.js');
    expect(COUNTER_ROUTE_TABLE.map((r) => `${r.method} ${r.url}`)).toContain('POST /assistants/disconnect');
  });
});

// ---------------------------------------------------------------------------
describe('the notice after the redirect', () => {
  const settings = (q: string) =>
    app.inject({ method: 'GET', url: `/settings${q}`, headers: { host: 'my.test', cookie: `__Host-osb_counter=${MY_COOKIE}` } });

  it('names only an assistant this account held and holds no longer', async () => {
    // Never held by this account: a crafted link cannot put its name here.
    signIn(OTHER, NEVER);
    world.tokens.forEach((t) => (t.revoked = true));
    const crafted = await settings(`?saved=disconnected&assistant=${NEVER}`);
    expect(crafted.body).toContain("Disconnected. That assistant can&#39;t reach your account any more.");
    expect(crafted.body).not.toContain('Never signed in');

    // Still connected: not named as disconnected.
    signIn(ME, CLI);
    const stillOn = await settings(`?saved=disconnected&assistant=${CLI}`);
    expect(stillOn.body).toContain("Disconnected. That assistant can&#39;t");
  });

  it('a saved code it does not know shows nothing', async () => {
    const r = await settings('?saved=<script>');
    expect(r.statusCode).toBe(200);
    expect(r.body).not.toContain('Disconnected.');
  });
});

// ---------------------------------------------------------------------------
describe('the settings section', () => {
  const DAY = (iso: string) => cpages.localTime(iso, 'day');
  const view = (assistants: home.ConnectedAssistantView[]): home.EmailSettingsView => ({
    hearsVia: 'email',
    timezone: 'Australia/Sydney',
    freqMatches: 'immediate',
    freqDigests: 'daily',
    complaintSuppressed: false,
    emailUnreachable: false,
    keyCount: 0,
    assistants,
  });

  it('empty: says none are connected', () => {
    const html = home.settingsPage(view([]));
    expect(html).toContain('<h2>Connected assistants</h2>');
    expect(html).toContain('None connected right now.');
    expect(html).not.toContain('/assistants/disconnect');
  });

  it('one line per assistant: name, host, dates in the reader’s clock, and a Disconnect button', () => {
    const html = home.settingsPage(
      view([
        { clientId: SMITHERY, name: 'Smithery', via: 'connect.smithery.ai', connected: DAY('2026-09-20T00:00:00.000Z'), lastUsed: DAY('2026-09-30T00:00:00.000Z') },
      ]),
    );
    expect(html).toContain('<strong>Smithery</strong> via connect.smithery.ai, connected <time datetime="2026-09-20T00:00:00.000Z" data-local="day">');
    expect(html).toContain('last used <time datetime="2026-09-30T00:00:00.000Z" data-local="day">');
    expect(html).toContain('action="/assistants/disconnect"');
    expect(html).toContain(`name="client_id" value="${SMITHERY}"`);
    expect(html).toContain('>Disconnect</button>');
    // Placed with the keys section, just before it.
    expect(html.indexOf('Connected assistants')).toBeLessThan(html.indexOf("Keys for assistants that can&#39;t sign in"));
  });

  it('escapes the name a client registered itself under', () => {
    const html = home.settingsPage(
      view([
        { clientId: SMITHERY, name: '<img src=x onerror=alert(1)>"&', via: 'evil.example', connected: DAY('2026-09-20'), lastUsed: DAY('2026-09-20') },
      ]),
    );
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;&quot;&amp;');
  });
});
