/**
 * The token endpoint: what it will and will not hand out.
 *
 * The rows live in a small in-memory world rather than a real database, so
 * these are tests of the endpoint's own rules — single use, rotation, reuse,
 * lifetime, PKCE, and the doors a suspension shuts — rather than of SQL.
 */
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../src/app.js';
import * as db from '../../src/db.js';
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

const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex');

const ACCOUNT = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const CLIENT = 'cccccccc-3333-4333-8333-cccccccccccc';

interface TokenRow {
  token_hash: string;
  kind: string;
  account_id: string;
  client_id: string;
  scope: string;
  manual_version: number | null;
  revoked: boolean;
  suspended: boolean;
  expires_at: Date;
  rotated_from: string | null;
  family_id: string | null;
  family_started_at: Date | null;
}

interface CodeRow {
  code_hash: string;
  client_id: string;
  account_id: string;
  redirect_uri: string;
  code_challenge: string;
  scope: string;
  expires_at: Date;
  used: boolean;
}

interface World {
  tokens: TokenRow[];
  codes: CodeRow[];
  clients: { client_id: string; redirect_uris: string[] }[];
  stopped: Set<string>;
  sql: { sql: string; params: any[] }[];
}
let world: World;

function fakePool() {
  return {
    query: async (sql: string, params: any[] = []) => {
      const rows = (r: any[]) => ({ rows: r, rowCount: r.length });
      world.sql.push({ sql, params });

      if (/SELECT suspended_at FROM accounts/.test(sql)) {
        return rows([{ suspended_at: world.stopped.has(params[0]) ? new Date() : null }]);
      }
      if (/SELECT \* FROM oauth_tokens WHERE token_hash/.test(sql)) {
        const t = world.tokens.find((x) => x.token_hash === params[0] && x.kind === 'refresh');
        return rows(t ? [t] : []);
      }
      if (/INSERT INTO oauth_tokens/.test(sql)) {
        const [accessHash, refreshHash, accountId, clientId, scope, manualVersion, familyId, familyStartedAt] = params;
        const in1h = new Date(Date.now() + 3600_000);
        const in30d = new Date(Date.now() + 30 * 86_400_000);
        const shared = {
          account_id: accountId,
          client_id: clientId,
          scope,
          manual_version: manualVersion,
          family_id: familyId,
          family_started_at: familyStartedAt,
        };
        world.tokens.push(
          mkToken({ ...shared, token_hash: accessHash, kind: 'access', expires_at: in1h }),
          mkToken({ ...shared, token_hash: refreshHash, kind: 'refresh', expires_at: in30d }),
        );
        return rows([]);
      }
      if (/UPDATE oauth_tokens SET revoked = true WHERE family_id/.test(sql)) {
        for (const t of world.tokens) if (t.family_id === params[0]) t.revoked = true;
        return rows([]);
      }
      if (/UPDATE oauth_tokens SET revoked = true WHERE token_hash = \$1 OR rotated_from/.test(sql)) {
        for (const t of world.tokens) {
          if (t.token_hash === params[0] || t.rotated_from === params[0]) t.revoked = true;
        }
        return rows([]);
      }
      if (/UPDATE oauth_tokens SET revoked = true WHERE token_hash/.test(sql)) {
        const t = world.tokens.find((x) => x.token_hash === params[0]);
        if (t) t.revoked = true;
        return rows([]);
      }
      if (/UPDATE oauth_tokens SET rotated_from/.test(sql)) {
        const t = world.tokens.find((x) => x.token_hash === params[1]);
        if (t) t.rotated_from = params[0];
        return rows([]);
      }

      // ---- authorization codes ----
      if (/UPDATE oauth_codes SET used = true/.test(sql)) {
        const c = world.codes.find(
          (x) => x.code_hash === params[0] && !x.used && x.expires_at > new Date(),
        );
        if (!c) return rows([]);
        c.used = true;
        return rows([c]);
      }
      if (/INSERT INTO oauth_clients/.test(sql)) {
        const client_id = `client-${world.clients.length + 1}`;
        world.clients.push({ client_id, redirect_uris: JSON.parse(params[1]) });
        return rows([{ client_id, created_at: new Date() }]);
      }
      return rows([]);
    },
  } as any;
}

const mkToken = (over: Partial<TokenRow>): TokenRow => ({
  token_hash: 'x',
  kind: 'refresh',
  account_id: ACCOUNT,
  client_id: CLIENT,
  scope: 'switchboard',
  manual_version: null,
  revoked: false,
  suspended: false,
  expires_at: new Date(Date.now() + 30 * 86_400_000),
  rotated_from: null,
  family_id: null,
  family_started_at: null,
  ...over,
});

let app: FastifyInstance;

beforeEach(async () => {
  world = { tokens: [], codes: [], clients: [], stopped: new Set(), sql: [] };
  vi.spyOn(db, 'getPool').mockReturnValue(fakePool());
  vi.spyOn(db, 'dbConfigured').mockReturnValue(true);
  if (!app) {
    app = buildApp(cfg);
    await app.ready();
  }
});

// The registration tests set this to skip the per-IP rail; nothing else in the
// suite should inherit an exemption from them.
afterEach(() => {
  delete process.env.RATELIMIT_BYPASS_TOKEN;
});

const token = (payload: Record<string, string>) =>
  app.inject({
    method: 'POST',
    url: '/oauth/token',
    headers: { host: 'mcp.test', 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams(payload).toString(),
  });

const FAMILY = 'ffffffff-6666-4666-8666-ffffffffffff';

/** A live refresh token in the world, and the string an agent would present. */
function liveRefresh(over: Partial<TokenRow> = {}): string {
  const raw = 'osb_rt_a-refresh-token-that-is-live';
  world.tokens.push(
    mkToken({
      token_hash: sha256hex(raw),
      family_id: FAMILY,
      family_started_at: new Date(),
      ...over,
    }),
  );
  return raw;
}

describe('refreshing', () => {
  it('rotates: the old one dies and a new pair comes back', async () => {
    const raw = liveRefresh();
    const r = await token({ grant_type: 'refresh_token', refresh_token: raw });
    expect(r.statusCode).toBe(200);
    expect(r.json().refresh_token).toBeTruthy();
    expect(r.json().refresh_token).not.toBe(raw);
    expect(world.tokens.find((t) => t.token_hash === sha256hex(raw))!.revoked).toBe(true);
  });

  it('a stopped account gets no new keys', async () => {
    const raw = liveRefresh();
    world.stopped.add(ACCOUNT);
    const r = await token({ grant_type: 'refresh_token', refresh_token: raw });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe('invalid_grant');
    expect(r.json().error_description).toBe('account-suspended');
    // And nothing was minted on the way to refusing.
    expect(world.tokens).toHaveLength(1);
  });

  it('an unknown refresh token is refused', async () => {
    const r = await token({ grant_type: 'refresh_token', refresh_token: 'osb_rt_nonsense' });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe('invalid_grant');
  });

  it('the new pair stays in the same family and ages from the same press', async () => {
    const startedAt = new Date(Date.now() - 5 * 86_400_000);
    const raw = liveRefresh({ family_started_at: startedAt });
    const r = await token({ grant_type: 'refresh_token', refresh_token: raw });
    const fresh = world.tokens.find(
      (t) => t.token_hash === sha256hex(r.json().refresh_token),
    )!;
    expect(fresh.family_id).toBe(FAMILY);
    expect(new Date(fresh.family_started_at!).getTime()).toBe(startedAt.getTime());
  });

  it('a suspended token — the kill switch — is refused without killing anything', async () => {
    const raw = liveRefresh({ suspended: true });
    const r = await token({ grant_type: 'refresh_token', refresh_token: raw });
    expect(r.statusCode).toBe(400);
    expect(r.json().error_description).toBe('token-suspended');
    // The kill switch is reversible, so nothing here is made permanent.
    expect(world.tokens[0].revoked).toBe(false);
  });

  it('an expired refresh token is refused', async () => {
    const raw = liveRefresh({ expires_at: new Date(Date.now() - 1000) });
    const r = await token({ grant_type: 'refresh_token', refresh_token: raw });
    expect(r.statusCode).toBe(400);
    expect(r.json().error_description).toBe('refresh-token-expired');
  });

  it('a refresh presented by a different client is refused', async () => {
    const raw = liveRefresh();
    const r = await token({
      grant_type: 'refresh_token',
      refresh_token: raw,
      client_id: 'somebody-else',
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error_description).toBe('client-mismatch');
  });
});

describe('a refresh token presented twice', () => {
  it('kills the whole family, not just the token', async () => {
    const raw = liveRefresh();
    const first = await token({ grant_type: 'refresh_token', refresh_token: raw });
    expect(first.statusCode).toBe(200);
    const rotated = first.json().refresh_token;

    // The same one again: either a retry or a thief, and the same answer.
    const again = await token({ grant_type: 'refresh_token', refresh_token: raw });
    expect(again.statusCode).toBe(400);
    expect(again.json().error_description).toBe('refresh-token-reused');

    // Everything descended from that one press is dead, the freshly issued
    // pair included, so the copy that WAS working stops working too.
    for (const t of world.tokens) expect(t.revoked).toBe(true);
    const third = await token({ grant_type: 'refresh_token', refresh_token: rotated });
    expect(third.statusCode).toBe(400);
    expect(third.json().error_description).toBe('refresh-token-reused');
  });

  it('reaches what it can on a token minted before families existed', async () => {
    const raw = liveRefresh({ family_id: null, family_started_at: null, revoked: true });
    const child = mkToken({ token_hash: 'child-hash', rotated_from: sha256hex(raw) });
    world.tokens.push(child);
    const r = await token({ grant_type: 'refresh_token', refresh_token: raw });
    expect(r.statusCode).toBe(400);
    expect(child.revoked).toBe(true);
  });
});

describe('a grant does not renew itself for ever', () => {
  it('dies ninety days after the press, however recently it rotated', async () => {
    const raw = liveRefresh({
      family_started_at: new Date(Date.now() - 91 * 86_400_000),
      // Still well inside the refresh token's own thirty days: it is the
      // authorization that has run out, not the token.
      expires_at: new Date(Date.now() + 20 * 86_400_000),
    });
    const r = await token({ grant_type: 'refresh_token', refresh_token: raw });
    expect(r.statusCode).toBe(400);
    expect(r.json().error_description).toBe('authorization-expired');
    for (const t of world.tokens) expect(t.revoked).toBe(true);
  });

  it('eighty-nine days is still fine', async () => {
    const raw = liveRefresh({ family_started_at: new Date(Date.now() - 89 * 86_400_000) });
    const r = await token({ grant_type: 'refresh_token', refresh_token: raw });
    expect(r.statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
const VERIFIER = 'a'.repeat(43);
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');
const CODE = 'osb_ac_a-code-that-was-just-minted';

function liveCode(over: Partial<CodeRow> = {}) {
  world.codes.push({
    code_hash: sha256hex(CODE),
    client_id: CLIENT,
    account_id: ACCOUNT,
    redirect_uri: 'https://app.example/cb',
    code_challenge: CHALLENGE,
    scope: 'switchboard',
    expires_at: new Date(Date.now() + 600_000),
    used: false,
    ...over,
  });
}

const exchange = (over: Record<string, string> = {}) =>
  token({
    grant_type: 'authorization_code',
    code: CODE,
    code_verifier: VERIFIER,
    client_id: CLIENT,
    redirect_uri: 'https://app.example/cb',
    ...over,
  });

describe('exchanging an authorization code', () => {
  it('works once', async () => {
    liveCode();
    const r = await exchange();
    expect(r.statusCode).toBe(200);
    expect(r.json().access_token).toMatch(/^osb_at_/);
    expect(world.codes[0].used).toBe(true);
  });

  it('starts a family, dated now', async () => {
    liveCode();
    const r = await exchange();
    const fresh = world.tokens.find((t) => t.token_hash === sha256hex(r.json().refresh_token))!;
    expect(fresh.family_id).toBeTruthy();
    expect(Date.now() - new Date(fresh.family_started_at!).getTime()).toBeLessThan(5000);
  });

  it('is single use, and the database is what decides it', async () => {
    liveCode();
    expect((await exchange()).statusCode).toBe(200);
    const second = await exchange();
    expect(second.statusCode).toBe(400);
    expect(second.json().error_description).toBe('code-unusable');
  });

  it('two exchanges racing each other: exactly one wins', async () => {
    liveCode();
    const [a, b] = await Promise.all([exchange(), exchange()]);
    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes).toEqual([200, 400]);
  });

  it('an expired code is refused', async () => {
    liveCode({ expires_at: new Date(Date.now() - 1000) });
    const r = await exchange();
    expect(r.statusCode).toBe(400);
    expect(r.json().error_description).toBe('code-unusable');
  });

  it('a wrong verifier fails PKCE, and burns the code doing it', async () => {
    liveCode();
    const r = await exchange({ code_verifier: 'b'.repeat(43) });
    expect(r.statusCode).toBe(400);
    expect(r.json().error_description).toBe('PKCE verification failed');
    // Somebody presented a code that was not theirs; it must not be
    // presentable again.
    expect(world.codes[0].used).toBe(true);
  });

  it('a mismatched client or redirect is refused', async () => {
    liveCode();
    expect((await exchange({ client_id: 'someone-else' })).json().error_description).toBe(
      'client-mismatch',
    );
    liveCode();
    expect((await exchange({ redirect_uri: 'https://evil.example/cb' })).json().error_description).toBe(
      'redirect-uri-mismatch',
    );
  });

  it('a verifier that is not a verifier is turned away before anything is spent', async () => {
    for (const bad of ['short', 'a'.repeat(129), `${'a'.repeat(42)}!`, `${'a'.repeat(42)} `]) {
      liveCode();
      const r = await exchange({ code_verifier: bad });
      expect(r.statusCode, bad).toBe(400);
      expect(r.json().error, bad).toBe('invalid_request');
      expect(world.codes[world.codes.length - 1].used, bad).toBe(false);
      world.codes = [];
    }
  });

  it('accepts the whole unreserved set at both ends of the length', async () => {
    for (const len of [43, 128]) {
      const v = ('aA0._~-'.repeat(20) + '0'.repeat(128)).slice(0, len);
      const ch = createHash('sha256').update(v).digest('base64url');
      world.codes = [];
      liveCode({ code_challenge: ch });
      const r = await exchange({ code_verifier: v });
      expect(r.statusCode, String(len)).toBe(200);
    }
  });
});

// ---------------------------------------------------------------------------
describe('where a code may be sent back to', () => {
  // More registrations than the per-IP rail allows in an hour, so the suite
  // uses the same exemption CI does rather than testing the rail by accident.
  const BYPASS = 'x'.repeat(40);
  const register = (uris: string[]) => {
    process.env.RATELIMIT_BYPASS_TOKEN = BYPASS;
    return app.inject({
      method: 'POST',
      url: '/oauth/register',
      headers: {
        host: 'mcp.test',
        'content-type': 'application/json',
        'x-osb-ratelimit-bypass': BYPASS,
      },
      payload: { client_name: 'a client', redirect_uris: uris },
    });
  };

  it('https anywhere, and http on the loopback address', async () => {
    for (const u of [
      'https://app.example/cb',
      'http://127.0.0.1:8976/cb',
      'http://localhost:8976/cb',
      'http://[::1]:8976/cb',
    ]) {
      expect((await register([u])).statusCode, u).toBe(201);
    }
  });

  it('nothing else at all', async () => {
    for (const u of [
      'http://app.example/cb',
      'myapp://callback',
      'javascript:alert(1)',
      'data:text/html,x',
      'file:///tmp/cb',
    ]) {
      const r = await register([u]);
      expect(r.statusCode, u).toBe(400);
      expect(r.json().error, u).toBe('invalid_redirect_uri');
    }
  });

  it('one bad one in a list of good ones refuses the lot', async () => {
    const r = await register(['https://app.example/cb', 'myapp://callback']);
    expect(r.statusCode).toBe(400);
  });
});
