/**
 * Agent keys (1.C): human-issued static bearer tokens for MCP clients that
 * cannot run an OAuth flow.
 *
 * The invariant this suite exists to hold is a structural one: a key is an
 * AGENT credential and nothing more. It authenticates on the MCP path, it is
 * refused on every human-page route (where humans approve things), the kill
 * switch reaches it, and revoking it kills it at once.
 *
 * The oauth_tokens table is stood in for by a small fake that honours the
 * columns the real statements filter on (kind, revoked, suspended,
 * expires_at), so the round trip below is a genuine one: mint → authenticate
 * → revoke → refused.
 */
import { createHash } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

vi.mock('../../src/crypto.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  writeConsentEvent: vi.fn(async () => 'consent/key'),
}));

import { buildApp } from '../../src/app.js';
import { authenticate, AGENT_KEY_PREFIX } from '../../src/auth/oauth.js';
import * as agentKeys from '../../src/domain/agentKeys.js';
import * as ops from '../../src/domain/counterOps.js';
import * as chome from '../../src/counter/pagesHome.js';
import { writeConsentEvent } from '../../src/crypto.js';
import * as db from '../../src/db.js';
import type { Config } from '../../src/config.js';

const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex');

const cfg: Config = {
  envName: 'dev',
  port: 0,
  publicOrigin: 'https://mcp.test',
  counterOrigin: 'https://my.test',
  legacyCounterHosts: ['counter.test'],
  sesFrom: 'OpenSwitchboard <board@openswitchboard.ai>',
  sesReplyTo: 'info@openswitchboard.ai',
  sesConfigurationSet: 'unused',
  emailEventsQueueUrl: 'http://unused',
  dbSecretArn: 'unused',
  screeningQueueUrl: 'http://unused',
  matchingQueueUrl: 'http://unused',
  opsQueueUrl: 'http://unused',
  consentLogBucket: 'unused',
  identityKeyArn: 'unused',
  bedrockModelId: 'unused',
  registrationMode: 'dev-bootstrap',
  region: 'us-east-1',
  quotas: { maxOpenCards: 5, maxPublishesPerDay: 10, maxOffersPerHour: 6 },
  docsBase: 'https://openswitchboard.ai/docs',
  settlementFeePercent: 0,
};

// ---------------------------------------------------------------------------
// A stand-in oauth_tokens table: enough of PostgreSQL's behaviour for the
// exact statements these paths run.
// ---------------------------------------------------------------------------
interface TokenRow {
  token_hash: string;
  kind: string;
  account_id: string;
  client_id: string | null;
  scope: string;
  name: string | null;
  key_id: string | null;
  created_at: Date;
  last_used_at: Date | null;
  expires_at: Date;
  revoked: boolean;
  suspended: boolean;
  /** The agent-manual version this session was last handed. */
  manual_version: number | null;
}

let table: TokenRow[] = [];
let uuidCounter = 0;

const fakePool = {
  query: async (sql: string, params: any[] = []) => {
    const s = sql.replace(/\s+/g, ' ').trim();

    if (s.startsWith('SELECT account_id, client_id, scope, manual_version, manual_notified_at FROM oauth_tokens')) {
      const [hash, kind] = params;
      const row = table.find(
        (t) =>
          t.token_hash === hash &&
          t.kind === kind &&
          !t.revoked &&
          !t.suspended &&
          t.expires_at > new Date(),
      );
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (s.startsWith('UPDATE oauth_tokens SET last_used_at')) {
      const row = table.find((t) => t.token_hash === params[0]);
      if (row) row.last_used_at = new Date();
      return { rows: [], rowCount: row ? 1 : 0 };
    }
    if (s.startsWith('UPDATE oauth_tokens SET manual_version')) {
      const row = table.find((t) => t.token_hash === params[0]);
      if (row) row.manual_version = params[1];
      return { rows: [], rowCount: row ? 1 : 0 };
    }
    if (s.startsWith('INSERT INTO oauth_tokens')) {
      const ttlDays = Number(/interval '(\d+) days'/.exec(s)?.[1] ?? 0);
      const row: TokenRow = {
        token_hash: params[0],
        kind: 'api-key',
        account_id: params[1],
        client_id: null,
        scope: 'switchboard',
        name: params[2],
        key_id: `00000000-0000-4000-8000-${String(++uuidCounter).padStart(12, '0')}`,
        created_at: new Date(),
        last_used_at: null,
        expires_at: new Date(Date.now() + ttlDays * 86_400_000),
        revoked: false,
        suspended: false,
        manual_version: null,
      };
      table.push(row);
      return { rows: [row], rowCount: 1 };
    }
    if (s.startsWith('SELECT key_id, name, created_at')) {
      const rows = table
        .filter(
          (t) =>
            t.account_id === params[0] &&
            t.kind === 'api-key' &&
            !t.revoked &&
            t.expires_at > new Date(),
        )
        .sort((a, b) => +b.created_at - +a.created_at);
      return { rows, rowCount: rows.length };
    }
    if (s.startsWith('UPDATE oauth_tokens SET revoked = true WHERE account_id')) {
      const row = table.find(
        (t) =>
          t.account_id === params[0] && t.key_id === params[1] && t.kind === 'api-key' && !t.revoked,
      );
      if (row) row.revoked = true;
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    // The kill switch's suspend-all / restore-all, verbatim from counterOps.
    if (s.startsWith('UPDATE oauth_tokens SET suspended = true')) {
      let n = 0;
      for (const t of table) {
        if (t.account_id === params[0] && !t.revoked) {
          t.suspended = true;
          n++;
        }
      }
      return { rows: [], rowCount: n };
    }
    if (s.startsWith('UPDATE oauth_tokens SET suspended = false')) {
      for (const t of table) if (t.account_id === params[0]) t.suspended = false;
      return { rows: [], rowCount: 0 };
    }
    // cards / accounts statements the kill switch also runs: nothing to model.
    return { rows: [], rowCount: 0 };
  },
} as any;

const ACCOUNT = 'acct-agent-key';
const reqWith = (token?: string) =>
  ({ headers: token ? { authorization: `Bearer ${token}` } : {} }) as any;

let app: FastifyInstance;

beforeAll(async () => {
  app = buildApp(cfg);
  await app.ready();
});

beforeEach(() => {
  table = [];
  vi.spyOn(db, 'getPool').mockReturnValue(fakePool);
  vi.mocked(writeConsentEvent).mockClear();
});

// ---------------------------------------------------------------------------

describe('agent key format', () => {
  it('is osb_ak_ plus at least 32 bytes of base64url randomness', async () => {
    const { token } = await agentKeys.createAgentKey(ACCOUNT, 'the laptop agent');
    expect(token.startsWith('osb_ak_')).toBe(true);
    expect(AGENT_KEY_PREFIX).toBe('osb_ak_');
    const body = token.slice('osb_ak_'.length);
    expect(body).toMatch(/^[A-Za-z0-9_-]+$/); // base64url alphabet only
    expect(Buffer.from(body, 'base64url').length).toBeGreaterThanOrEqual(32);
  });

  it('two keys never collide', async () => {
    const a = await agentKeys.createAgentKey(ACCOUNT, 'one');
    const b = await agentKeys.createAgentKey(ACCOUNT, 'two');
    expect(a.token).not.toBe(b.token);
  });

  it('stores only the hash, bound to the account, with no OAuth client and a 90-day life', async () => {
    const { token } = await agentKeys.createAgentKey(ACCOUNT, 'the laptop agent');
    expect(agentKeys.AGENT_KEY_TTL_DAYS).toBe(90);
    const row = table[0];
    expect(table.map((t) => t.token_hash)).not.toContain(token); // plaintext never stored
    expect(row.token_hash).toBe(sha256hex(token));
    expect(row.kind).toBe('api-key');
    expect(row.account_id).toBe(ACCOUNT);
    expect(row.client_id).toBeNull();
    expect(row.scope).toBe('switchboard');
    const days = (+row.expires_at - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(89.9);
    expect(days).toBeLessThan(90.1);
  });

  it('caps how many live keys one account may hold', async () => {
    for (let i = 0; i < agentKeys.AGENT_KEY_MAX_LIVE; i++) {
      await agentKeys.createAgentKey(ACCOUNT, `key ${i}`);
    }
    await expect(agentKeys.createAgentKey(ACCOUNT, 'one too many')).rejects.toBeInstanceOf(
      agentKeys.AgentKeyLimitError,
    );
  });

  it('writes issuance and revocation to the WORM consent log', async () => {
    const { row } = await agentKeys.createAgentKey(ACCOUNT, 'the laptop agent');
    expect(vi.mocked(writeConsentEvent).mock.calls[0][0]).toMatchObject({
      event: 'agent-key-issued',
      account_id: ACCOUNT,
      key_id: row.keyId,
    });
    await agentKeys.revokeAgentKey(ACCOUNT, row.keyId);
    expect(vi.mocked(writeConsentEvent).mock.calls[1][0]).toMatchObject({
      event: 'agent-key-revoked',
      account_id: ACCOUNT,
      key_id: row.keyId,
    });
  });
});

describe('agent key authentication: the round trip', () => {
  it('a fresh key resolves to its account through the same path as an access token', async () => {
    const { token } = await agentKeys.createAgentKey(ACCOUNT, 'the laptop agent');
    const auth = await authenticate(reqWith(token));
    expect(auth).toEqual({
      accountId: ACCOUNT,
      clientId: null,
      scope: 'switchboard',
      tokenHash: sha256hex(token),
      manualVersion: null,
      manualNotifiedAt: null,
    });
  });

  it('stamps last_used_at, so an agent on a key counts as recently seen', async () => {
    const { token } = await agentKeys.createAgentKey(ACCOUNT, 'the laptop agent');
    expect(table[0].last_used_at).toBeNull();
    await authenticate(reqWith(token));
    await new Promise((r) => setTimeout(r, 5)); // the stamp is fired off the request path
    expect(table[0].last_used_at).toBeInstanceOf(Date);
  });

  it('an unknown or malformed key resolves to nobody', async () => {
    await agentKeys.createAgentKey(ACCOUNT, 'the laptop agent');
    expect(await authenticate(reqWith('osb_ak_totally-made-up'))).toBeUndefined();
    expect(await authenticate(reqWith('osb_xx_wrong-prefix'))).toBeUndefined();
    expect(await authenticate(reqWith())).toBeUndefined();
  });

  it('an access-token prefix cannot borrow an agent key row (and the reverse)', async () => {
    const { token } = await agentKeys.createAgentKey(ACCOUNT, 'the laptop agent');
    // Same secret, wrong prefix: the lookup is keyed on kind as well as hash.
    const swapped = `osb_at_${token.slice('osb_ak_'.length)}`;
    expect(await authenticate(reqWith(swapped))).toBeUndefined();
  });

  it('revoking a key kills it at once', async () => {
    const { token, row } = await agentKeys.createAgentKey(ACCOUNT, 'the laptop agent');
    expect(await authenticate(reqWith(token))).toBeTruthy();
    expect(await agentKeys.revokeAgentKey(ACCOUNT, row.keyId)).toBe('the laptop agent');
    expect(await authenticate(reqWith(token))).toBeUndefined();
    expect(await agentKeys.listAgentKeys(ACCOUNT)).toEqual([]);
  });

  it('a key belongs to one account: another account cannot revoke it', async () => {
    const { token, row } = await agentKeys.createAgentKey(ACCOUNT, 'the laptop agent');
    expect(await agentKeys.revokeAgentKey('someone-else', row.keyId)).toBeUndefined();
    expect(await authenticate(reqWith(token))).toBeTruthy();
  });

  it('an expired key resolves to nobody', async () => {
    const { token } = await agentKeys.createAgentKey(ACCOUNT, 'the laptop agent');
    table[0].expires_at = new Date(Date.now() - 1000);
    expect(await authenticate(reqWith(token))).toBeUndefined();
  });

  it('the kill switch suspends agent keys too, and turning it back on restores them', async () => {
    const { token } = await agentKeys.createAgentKey(ACCOUNT, 'the laptop agent');
    await ops.killSwitchOn(ACCOUNT);
    expect(table[0].suspended).toBe(true);
    expect(await authenticate(reqWith(token))).toBeUndefined();
    await ops.killSwitchOff(ACCOUNT);
    expect(await authenticate(reqWith(token))).toBeTruthy();
  });
});

describe('agent keys reach the MCP surface and nothing else', () => {
  it('an agent key lists tools on /mcp', async () => {
    const { token } = await agentKeys.createAgentKey(ACCOUNT, 'the laptop agent');
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
    expect(res.statusCode).toBe(200);
    const names = JSON.parse(res.body).result.tools.map((t: any) => t.name);
    expect(names).toContain('publish_intent');
    expect(names).toContain('check_matches');
  });

  it('a revoked agent key gets 401 on /mcp', async () => {
    const { token, row } = await agentKeys.createAgentKey(ACCOUNT, 'the laptop agent');
    await agentKeys.revokeAgentKey(ACCOUNT, row.keyId);
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
  });

  it('an agent key gets 403 on the approval pages, its own issuance route included', async () => {
    const { token } = await agentKeys.createAgentKey(ACCOUNT, 'the laptop agent');
    for (const [method, url] of [
      ['GET', '/'],
      ['GET', '/agent-keys'],
      ['POST', '/agent-keys'],
      ['POST', '/agent-keys/revoke'],
      ['POST', '/approve'],
    ] as const) {
      const res = await app.inject({
        method: method as any,
        url,
        headers: { host: 'my.test', authorization: `Bearer ${token}` },
      });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      expect(res.json().error, `${method} ${url}`).toBe('agent_credentials_rejected');
    }
  });
});

describe('issuance route: signed-in session plus a PIN ceremony', () => {
  const post = (url: string, body: Record<string, string>, cookie?: string) =>
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

  it('refuses a caller with no session', async () => {
    for (const url of ['/agent-keys', '/agent-keys/revoke']) {
      const res = await post(url, { name: 'the laptop agent', pin: '246810' });
      expect(res.statusCode, url).toBe(401);
      expect(res.json().error).toBe('not_signed_in');
    }
  });

  it('the listing page sends a signed-out caller to sign in', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/agent-keys',
      headers: { host: 'my.test' },
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe('/login');
  });

  it('the routes are part of the enumerated human-only route class', async () => {
    const { COUNTER_ROUTE_TABLE } = await import('../../src/counter/routes.js');
    const urls = COUNTER_ROUTE_TABLE.map((r) => `${r.method} ${r.url}`);
    expect(urls).toContain('GET /agent-keys');
    expect(urls).toContain('POST /agent-keys');
    expect(urls).toContain('POST /agent-keys/revoke');
  });
});

describe('agent key pages: copy', () => {
  const rendered = [
    {
      name: 'agent-keys-empty',
      html: chome.agentKeysPage({ keys: [], elevated: false, atLimit: false }),
    },
    {
      name: 'agent-keys-list',
      html: chome.agentKeysPage(
        {
          keys: [
            {
              keyId: 'k-1',
              name: 'the laptop agent',
              created: '2026-09-01',
              lastUsed: '2026-09-02',
              expires: '2026-11-30',
            },
            { keyId: 'k-2', name: 'the phone agent', created: '2026-09-01', expires: '2026-11-30' },
          ],
          elevated: true,
          atLimit: false,
        },
        'Revoked. Anything still using that key stops working right now.',
      ),
    },
    {
      name: 'agent-keys-at-limit',
      html: chome.agentKeysPage(
        { keys: [], elevated: false, atLimit: true },
        undefined,
        'That key is unknown.',
      ),
    },
    {
      name: 'agent-key-created',
      html: chome.agentKeyCreatedPage({
        name: 'the laptop agent',
        token: 'osb_ak_ZXhhbXBsZS1rZXktdmFsdWUtZm9yLXRoZS1yZW5kZXItc3VpdGU',
        expires: '2026-11-30',
      }),
    },
  ];

  // The banned-phrase lint over these pages runs with every other counter
  // page in my.test.ts's copy-cull render suite. What is asserted here
  // is what the pages have to SAY.

  it('the new key is shown once, with a copy button', () => {
    const html = rendered.find((p) => p.name === 'agent-key-created')!.html;
    expect(html).toContain('osb_ak_ZXhhbXBsZS1rZXktdmFsdWUtZm9yLXRoZS1yZW5kZXItc3VpdGU');
    expect(html).toContain('id="copybtn"');
    expect(html).toContain('navigator.clipboard.writeText');
    expect(html).toContain('only place it is ever shown');
  });

  it('the create form asks for the PIN until the session is elevated', () => {
    const cold = rendered.find((p) => p.name === 'agent-keys-empty')!.html;
    const warm = rendered.find((p) => p.name === 'agent-keys-list')!.html;
    expect(cold).toContain('Confirm with your PIN');
    expect(warm).not.toContain('Confirm with your PIN');
  });

  it('the listing names each key, when it was made, when it was last used and when it lapses', () => {
    const html = rendered.find((p) => p.name === 'agent-keys-list')!.html;
    expect(html).toContain('the laptop agent');
    expect(html).toContain('made 2026-09-01');
    expect(html).toContain('last used 2026-09-02');
    expect(html).toContain('lapses 2026-11-30');
    expect(html).toContain('never used yet');
    expect(html).toContain('/agent-keys/revoke');
  });
});
