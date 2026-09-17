/**
 * The token endpoint: what it will and will not hand out.
 *
 * The rows live in a small in-memory world rather than a real database, so
 * these are tests of the endpoint's own rules — single use, rotation, reuse,
 * lifetime, PKCE, and the doors a suspension shuts — rather than of SQL.
 */
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
}

interface World {
  tokens: TokenRow[];
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
        const t = world.tokens.find(
          (x) =>
            x.token_hash === params[0] &&
            x.kind === 'refresh' &&
            !x.revoked &&
            !x.suspended &&
            x.expires_at > new Date(),
        );
        return rows(t ? [t] : []);
      }
      if (/INSERT INTO oauth_tokens/.test(sql)) {
        const [accessHash, refreshHash, accountId, clientId, scope, manualVersion] = params;
        const in1h = new Date(Date.now() + 3600_000);
        const in30d = new Date(Date.now() + 30 * 86_400_000);
        world.tokens.push(
          mkToken({ token_hash: accessHash, kind: 'access', account_id: accountId, client_id: clientId, scope, manual_version: manualVersion, expires_at: in1h }),
          mkToken({ token_hash: refreshHash, kind: 'refresh', account_id: accountId, client_id: clientId, scope, manual_version: manualVersion, expires_at: in30d }),
        );
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
  ...over,
});

let app: FastifyInstance;

beforeEach(async () => {
  world = { tokens: [], stopped: new Set(), sql: [] };
  vi.spyOn(db, 'getPool').mockReturnValue(fakePool());
  vi.spyOn(db, 'dbConfigured').mockReturnValue(true);
  if (!app) {
    app = buildApp(cfg);
    await app.ready();
  }
});

const token = (payload: Record<string, string>) =>
  app.inject({
    method: 'POST',
    url: '/oauth/token',
    headers: { host: 'mcp.test', 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams(payload).toString(),
  });

/** A live refresh token in the world, and the string an agent would present. */
function liveRefresh(): string {
  const raw = 'osb_rt_a-refresh-token-that-is-live';
  world.tokens.push(mkToken({ token_hash: sha256hex(raw) }));
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
});
