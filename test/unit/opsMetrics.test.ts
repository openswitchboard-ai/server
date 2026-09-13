import { afterEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  registerOpsMetricsRoutes,
  renderOpsMetricsHtml,
  type OpsDbMetrics,
} from '../../src/opsMetrics.js';
import { opsMetricsBasicAuthFrom } from '../../src/config.js';

const MCP_HOST = 'mcp.test';
const HUMAN_HOST = 'my.test';
const CREDENTIAL = 'ops:letmein';

const cfg = (over: Record<string, unknown> = {}): any => ({
  envName: 'dev',
  publicOrigin: `https://${MCP_HOST}`,
  counterOrigin: `https://${HUMAN_HOST}`,
  registrationMode: 'dev-bootstrap',
  opsMetricsBasicAuth: CREDENTIAL,
  ...over,
});

/** A complete fake of everything the database would have answered. */
function fakeMetrics(over: Partial<OpsDbMetrics> = {}): OpsDbMetrics {
  return {
    status: {
      db_round_trip_ms: 3,
      db_now: '2026-09-13T00:00:00.000Z',
      migrations_applied: 30,
      pulse_computed_at: '2026-09-13T00:00:00.000Z',
    },
    people: {
      accounts_total: 42,
      new_24h: 1,
      new_7d: 7,
      new_30d: 11,
      suspended: 0,
      onboarded: 40,
      kill_switch_on: 0,
      with_timezone: 38,
      with_passkey: 9,
      hears_via: [
        { label: 'email', n: 30 },
        { label: 'assistant', n: 12 },
      ],
      active_tokens: 12,
      accounts_with_active_token: 10,
      tokens_by_client: [{ label: 'Claude', n: 9 }],
      tokens_by_manual_version: [{ label: '32', n: 11 }],
    },
    cards: {
      total: 100,
      wants_open: 17,
      haves_open: 5,
      posted_24h: 2,
      posted_7d: 9,
      posted_30d: 31,
      expiring_24h: 1,
      paused_by_kill_switch: 0,
      screening_rejected: 3,
      pending_screening: 1,
      open_by_protocol_status: [{ label: 'active', n: 20 }],
      by_lifecycle_state: [{ label: 'PUBLISHED', n: 22 }],
      open_top_categories: [{ label: 'goods.bicycle.mountain', n: 4 }],
      open_by_reach: [{ label: 'radius', n: 22 }],
    },
    matching: {
      total: 8,
      created_24h: 1,
      created_7d: 3,
      declined: 2,
      by_state: [{ label: 'open', n: 6 }],
      by_stage: [{ label: '1', n: 8 }],
      median_seconds_to_match_7d: 1234,
      near_misses_7d: 4,
      category_misses_7d: 2,
      top_missed_categories_7d: [{ label: 'goods.unicycle', n: 2 }],
    },
    conversations: {
      messages_24h: 5,
      messages_7d: 20,
      channels_active_7d: 3,
      offers_total: 6,
      offers_7d: 2,
      offers_by_state: [{ label: 'proposed', n: 4 }],
      verdicts_by_value: [{ label: 'good', n: 3 }],
    },
    money: {
      settlements_total: 2,
      created_30d: 2,
      by_state: [{ label: 'released', n: 1 }],
      released_totals: [{ ccy: 'AUD', amount: '120.00', n: 1 }],
    },
    email: {
      sends_24h: 4,
      sends_7d: 25,
      sends_by_template_7d: [{ label: 'match-notice', n: 10 }],
      sends_by_kind_7d: [{ label: 'transactional', n: 25 }],
      sends_by_status_7d: [{ label: 'sent', n: 25 }],
      events_by_type_7d: [{ label: 'Delivery', n: 20 }],
      bounce_rate_7d: 0,
    },
    abuse: {
      read_calls_24h: 60,
      read_call_accounts_24h: 7,
      channel_sends_counted_24h: 12,
    },
    ...over,
  };
}

let apps: FastifyInstance[] = [];
afterEach(async () => {
  for (const a of apps) await a.close();
  apps = [];
});

function appWith(
  over: Record<string, unknown> = {},
  metrics: OpsDbMetrics = fakeMetrics(),
): FastifyInstance {
  const app = Fastify();
  registerOpsMetricsRoutes(app, cfg(over), { read: async () => metrics });
  apps.push(app);
  return app;
}

const basic = (cred: string) => `Basic ${Buffer.from(cred, 'utf8').toString('base64')}`;

const get = (app: FastifyInstance, url: string, headers: Record<string, string> = {}) =>
  app.inject({ method: 'GET', url, headers: { host: MCP_HOST, ...headers } });

describe('/ops/metrics registration', () => {
  it('is not registered at all without a credential in config', async () => {
    const app = appWith({ opsMetricsBasicAuth: undefined });
    const res = await get(app, '/ops/metrics');
    expect(res.statusCode).toBe(404);
    const json = await get(app, '/ops/metrics.json');
    expect(json.statusCode).toBe(404);
  });

  it('404s on the human hostname', async () => {
    const app = appWith();
    const res = await get(app, '/ops/metrics', {
      host: HUMAN_HOST,
      authorization: basic(CREDENTIAL),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('/ops/metrics auth', () => {
  it('401s with a Basic challenge when no credential is presented', async () => {
    const res = await get(appWith(), '/ops/metrics');
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toBe('Basic realm="OpenSwitchboard ops"');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-robots-tag']).toBe('noindex');
  });

  it('401s on the wrong password', async () => {
    const res = await get(appWith(), '/ops/metrics', {
      authorization: basic('ops:wrong'),
    });
    expect(res.statusCode).toBe(401);
  });

  it('401s on the wrong user', async () => {
    const res = await get(appWith(), '/ops/metrics', {
      authorization: basic('someone:letmein'),
    });
    expect(res.statusCode).toBe(401);
  });

  it('429s the eleventh failed attempt from one IP', async () => {
    const app = appWith();
    for (let i = 0; i < 10; i++) {
      const res = await get(app, '/ops/metrics', { authorization: basic('ops:wrong') });
      expect(res.statusCode).toBe(401);
    }
    const res = await get(app, '/ops/metrics', { authorization: basic('ops:wrong') });
    expect(res.statusCode).toBe(429);
  });

  it('does not rate-limit successful requests', async () => {
    const app = appWith();
    for (let i = 0; i < 15; i++) {
      const res = await get(app, '/ops/metrics', { authorization: basic(CREDENTIAL) });
      expect(res.statusCode).toBe(200);
    }
  });
});

describe('/ops/metrics content', () => {
  it('serves the page with the right credential', async () => {
    const res = await get(appWith(), '/ops/metrics', { authorization: basic(CREDENTIAL) });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.body).toContain('Ops metrics — OpenSwitchboard');
    expect(res.body).toContain('<meta http-equiv="refresh" content="60">');
    expect(res.body).toContain('Wants open');
    expect(res.body).toContain('>17<');
    expect(res.body).toContain('Accounts');
    expect(res.body).toContain('New this week');
    expect(res.body).toContain('th scope="col"');
  });

  it('serves the same data as JSON', async () => {
    const res = await get(appWith(), '/ops/metrics.json', {
      authorization: basic(CREDENTIAL),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.cards.wants_open).toBe(17);
    expect(body.people.accounts_total).toBe(42);
    expect(body.process.env_name).toBe('dev');
    expect(body.process.manual_version).toBeGreaterThan(0);
    expect(typeof body.generated_at).toBe('string');
    expect(typeof body.cache_age_seconds).toBe('number');
  });

  it('escapes anything a caller typed into a category name', async () => {
    const metrics = fakeMetrics();
    metrics.matching.top_missed_categories_7d = [
      { label: '<script>alert(1)</script>', n: 1 },
    ];
    const app = appWith({}, metrics);
    const res = await get(app, '/ops/metrics', { authorization: basic(CREDENTIAL) });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('<script>alert(1)</script>');
    expect(res.body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('renders without a database (pure function over the data)', () => {
    const html = renderOpsMetricsHtml({
      ...fakeMetrics(),
      generated_at: '2026-09-13T00:00:00.000Z',
      cache_age_seconds: 0,
      process: {
        env_name: 'dev',
        schema_version: '0.3.0',
        manual_version: 32,
        registration_mode: 'dev-bootstrap',
        settlements_configured: false,
        uptime_seconds: 10,
        node_version: 'v22.0.0',
      },
    });
    expect(html).toContain('Haves open');
    expect(html).toContain('Manual version');
  });
});

describe('OPS_METRICS_BASIC_AUTH validation', () => {
  it('absent means the page does not exist', () => {
    expect(opsMetricsBasicAuthFrom(undefined)).toBeUndefined();
    expect(opsMetricsBasicAuthFrom('')).toBeUndefined();
    expect(opsMetricsBasicAuthFrom('   ')).toBeUndefined();
  });

  it('accepts user:password', () => {
    expect(opsMetricsBasicAuthFrom('ops:letmein')).toBe('ops:letmein');
    expect(opsMetricsBasicAuthFrom('ops:pass:with:colons')).toBe('ops:pass:with:colons');
  });

  it('refuses a value with no colon', () => {
    expect(() => opsMetricsBasicAuthFrom('opsletmein')).toThrow(/user:password/);
  });

  it('refuses an empty password or an empty user', () => {
    expect(() => opsMetricsBasicAuthFrom('ops:')).toThrow(/both halves/);
    expect(() => opsMetricsBasicAuthFrom(':letmein')).toThrow(/both halves/);
  });
});
