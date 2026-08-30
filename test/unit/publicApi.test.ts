import { afterEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  geoLabel,
  registerPublicRoutes,
  type PublicDataSource,
  type PublicStats,
} from '../../src/publicApi.js';
import type { PulseRow } from '../../src/domain/pulse.js';

const cfg: any = { envName: 'dev' };

function appWith(deps: PublicDataSource): FastifyInstance {
  const app = Fastify();
  registerPublicRoutes(app, cfg, deps);
  return app;
}

const row = (over: Partial<PulseRow> = {}): PulseRow => ({
  category: 'goods.bicycle.mountain',
  geo_bucket: 'qd66',
  open_want_count: 13,
  open_have_count: 4,
  matches_created: null,
  median_seconds_to_match: null,
  computed_at: new Date(),
  ...over,
});

let apps: FastifyInstance[] = [];
const track = (a: FastifyInstance) => (apps.push(a), a);
afterEach(async () => {
  for (const a of apps) await a.close();
  apps = [];
});

describe('/public/pulse', () => {
  it('maps pulse rows to labelled public rows, k_floor declared', async () => {
    const app = track(
      appWith({ pulseRows: async () => [row()], stats: async () => ({}) }),
    );
    const res = await app.inject({ method: 'GET', url: '/public/pulse' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.k_floor).toBe(10);
    expect(body.rows).toHaveLength(1);
    const r = body.rows[0];
    expect(r.category).toBe('goods.bicycle.mountain');
    expect(r.category_label).toContain('Mountain bikes');
    expect(r.geo_bucket).toBe('qd66');
    expect(r.geo_label).toMatch(/^area qd66/);
    expect(r.open_want_count).toBe(13);
    expect(r.matches_created).toBeNull();
    expect(r.median_seconds_to_match).toBeNull();
  });

  it('serves an honest empty rows array when the table is empty', async () => {
    const app = track(appWith({ pulseRows: async () => [], stats: async () => ({}) }));
    const res = await app.inject({ method: 'GET', url: '/public/pulse' });
    expect(res.json().rows).toEqual([]);
  });

  it('caches for 60s (reader called once across repeated requests)', async () => {
    let calls = 0;
    const app = track(
      appWith({
        pulseRows: async () => (calls++, [row()]),
        stats: async () => ({}),
      }),
    );
    await app.inject({ method: 'GET', url: '/public/pulse' });
    await app.inject({ method: 'GET', url: '/public/pulse' });
    expect(calls).toBe(1);
  });

  it('CORS: allows the site + local dev origins, refuses others', async () => {
    const app = track(appWith({ pulseRows: async () => [], stats: async () => ({}) }));
    for (const origin of ['https://openswitchboard.ai', 'http://localhost:4321']) {
      const res = await app.inject({
        method: 'GET',
        url: '/public/pulse',
        headers: { origin },
      });
      expect(res.headers['access-control-allow-origin']).toBe(origin);
    }
    const bad = await app.inject({
      method: 'GET',
      url: '/public/pulse',
      headers: { origin: 'https://evil.example' },
    });
    expect(bad.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('rate limits per IP with 429 beyond the window budget', async () => {
    const app = track(appWith({ pulseRows: async () => [], stats: async () => ({}) }));
    let last = 0;
    for (let i = 0; i < 61; i++) {
      const res = await app.inject({ method: 'GET', url: '/public/pulse' });
      last = res.statusCode;
    }
    expect(last).toBe(429);
  });
});

describe('/public/stats', () => {
  it('passes through only what the source (already floored) provides', async () => {
    const stats: PublicStats = { open_want_count: 42, matches_created: 11 };
    const app = track(appWith({ pulseRows: async () => [], stats: async () => stats }));
    const res = await app.inject({ method: 'GET', url: '/public/stats' });
    const body = res.json();
    expect(body.open_want_count).toBe(42);
    expect(body.matches_created).toBe(11);
    expect(body).not.toHaveProperty('back_pocket_count');
    expect(body).not.toHaveProperty('median_seconds_to_match');
    expect(body.k_floor).toBe(10);
  });

  it('empty network: totals object carries no numeric totals at all', async () => {
    const app = track(appWith({ pulseRows: async () => [], stats: async () => ({}) }));
    const body = (await app.inject({ method: 'GET', url: '/public/stats' })).json();
    const keys = Object.keys(body).sort();
    expect(keys).toEqual(['as_of', 'k_floor']);
  });
});

describe('geoLabel', () => {
  it('labels geohash buckets with the coarse cell size, never a place guess', () => {
    expect(geoLabel('qd66')).toMatch(/^area qd66 \(~\d+ km cell\)$/);
    expect(geoLabel('AU-WA')).toBe('region AU-WA');
  });
});
