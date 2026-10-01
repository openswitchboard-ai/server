import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  DEFAULT_TOTALS_THRESHOLDS,
  STATS_MEDIAN_WINDOW_DAYS,
  TOTALS_INTROS_WINDOW_DAYS,
  allowedOrigins,
  geoLabel,
  registerPublicRoutes,
  totalsFor,
  type PublicDataSource,
  type PublicStats,
  type RawTotals,
} from '../../src/publicApi.js';
import { inRange } from '../../src/config.js';
import type { PulseRow } from '../../src/domain/pulse.js';

const cfg: any = { envName: 'dev' };
const here = dirname(fileURLToPath(import.meta.url));


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

describe('the 2026-09-28 review', () => {
  it('prod does not trust the local dev origin', async () => {
    const app = Fastify();
    registerPublicRoutes(app, { envName: 'prod' } as any, {
      pulseRows: async () => [],
      stats: async () => ({}),
    });
    track(app);
    const local = await app.inject({
      method: 'GET',
      url: '/public/stats',
      headers: { origin: 'http://localhost:4321' },
    });
    expect(local.headers['access-control-allow-origin']).toBeUndefined();
    const site = await app.inject({
      method: 'GET',
      url: '/public/stats',
      headers: { origin: 'https://openswitchboard.ai' },
    });
    expect(site.headers['access-control-allow-origin']).toBe('https://openswitchboard.ai');
    expect(allowedOrigins({ envName: 'dev' })).toContain('http://localhost:4321');
    expect(allowedOrigins({ envName: 'prod' })).toContain('https://www.openswitchboard.ai');
  });

  it('a cold cache is filled once however many requests arrive together', async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const app = track(
      appWith({
        pulseRows: async () => [],
        stats: async () => {
          calls += 1;
          await gate;
          return { open_want_count: 42 };
        },
      }),
    );
    const burst = Array.from({ length: 5 }, () =>
      app.inject({ method: 'GET', url: '/public/stats' }),
    );
    await new Promise((r) => setTimeout(r, 20));
    release();
    const res = await Promise.all(burst);
    expect(calls).toBe(1);
    for (const r of res) expect(r.json().open_want_count).toBe(42);
  });

  it('the median looks back a bounded window and is floored on that window', () => {
    const src = readFileSync(join(here, '..', '..', 'src', 'publicApi.ts'), 'utf8');
    expect(STATS_MEDIAN_WINDOW_DAYS).toBe(90);
    expect(src).toMatch(/WHERE m\.created_at > now\(\) - make_interval\(days => \$1::int\)/);
    expect(src).toContain('m.recent_matches >= K_ANON');
  });
});

const raw = (over: Partial<RawTotals> = {}): RawTotals => ({
  live_postings: 142,
  live_countries: 9,
  introductions_30d: 38,
  category_rows: 4,
  ...over,
});

const noTotals = async (): Promise<RawTotals> =>
  raw({ live_postings: 0, live_countries: 0, introductions_30d: 0, category_rows: 0 });

describe('totalsFor: stages', () => {
  it('defaults are 100 postings and 25 introductions', () => {
    expect(DEFAULT_TOTALS_THRESHOLDS).toEqual({ postingsMin: 100, introsMin: 25 });
    expect(TOTALS_INTROS_WINDOW_DAYS).toBe(30);
  });

  it('stage 0 under the postings threshold: the stage and nothing else', () => {
    for (const n of [0, 1, 9, 10, 99]) {
      const t = totalsFor(raw({ live_postings: n }));
      expect(t).toEqual({ stage: 0 });
    }
  });

  it('stage 0 hides introductions and categories however many there are', () => {
    const t = totalsFor(raw({ live_postings: 99, introductions_30d: 500, category_rows: 40 }));
    expect(t).toEqual({ stage: 0 });
  });

  it('stage 1 at the postings threshold: total and countries, no introductions', () => {
    const t = totalsFor(raw({ live_postings: 100, introductions_30d: 24 }));
    expect(t).toEqual({ stage: 1, live_postings: 100, live_countries: 9 });
    expect(t).not.toHaveProperty('introductions_30d');
  });

  it('stage 1 holds even with category rows while introductions are under threshold', () => {
    const t = totalsFor(raw({ introductions_30d: 3, category_rows: 12 }));
    expect(t.stage).toBe(1);
    expect(t).not.toHaveProperty('introductions_30d');
  });

  it('stage 2 at the introductions threshold with no category rows', () => {
    const t = totalsFor(raw({ introductions_30d: 25, category_rows: 0 }));
    expect(t).toEqual({ stage: 2, live_postings: 142, live_countries: 9, introductions_30d: 25 });
  });

  it('stage 3 once a per-category row exists', () => {
    const t = totalsFor(raw());
    expect(t).toEqual({ stage: 3, live_postings: 142, live_countries: 9, introductions_30d: 38 });
  });

  it('never serves the category row count itself', () => {
    expect(totalsFor(raw())).not.toHaveProperty('category_rows');
  });

  it('thresholds from config move the stages', () => {
    const th = { postingsMin: 500, introsMin: 100 };
    expect(totalsFor(raw({ live_postings: 499 }), th)).toEqual({ stage: 0 });
    expect(totalsFor(raw({ live_postings: 500, introductions_30d: 99 }), th).stage).toBe(1);
    expect(totalsFor(raw({ live_postings: 500, introductions_30d: 100 }), th).stage).toBe(3);
  });

  it('a threshold set under the k floor is held at the floor', () => {
    const th = { postingsMin: 1, introsMin: 1 };
    expect(totalsFor(raw({ live_postings: 9 }), th)).toEqual({ stage: 0 });
    const t = totalsFor(raw({ live_postings: 10, introductions_30d: 9 }), th);
    expect(t.stage).toBe(1);
    expect(t).not.toHaveProperty('introductions_30d');
  });
});

describe('PUBLIC_TOTALS_* config', () => {
  it('unset takes the defaults; under the k floor or not a whole number fails boot', () => {
    expect(inRange(undefined, 100, 10, 1_000_000, 'PUBLIC_TOTALS_POSTINGS_MIN')).toBe(100);
    expect(inRange('250', 100, 10, 1_000_000, 'PUBLIC_TOTALS_POSTINGS_MIN')).toBe(250);
    expect(() => inRange('5', 25, 10, 1_000_000, 'PUBLIC_TOTALS_INTROS_MIN')).toThrow();
    expect(() => inRange('lots', 25, 10, 1_000_000, 'PUBLIC_TOTALS_INTROS_MIN')).toThrow();
  });

  it('loadConfig reads both variables with those bounds', () => {
    const src = readFileSync(join(here, '..', '..', 'src', 'config.ts'), 'utf8');
    expect(src).toMatch(/process\.env\.PUBLIC_TOTALS_POSTINGS_MIN,\s*100,\s*10,/);
    expect(src).toMatch(/process\.env\.PUBLIC_TOTALS_INTROS_MIN,\s*25,\s*10,/);
  });
});

describe('/public/totals', () => {
  const app3 = (totals: () => Promise<RawTotals>, c: any = cfg) => {
    const app = Fastify();
    registerPublicRoutes(app, c, { pulseRows: async () => [], stats: async () => ({}), totals });
    return track(app);
  };

  it('stage 0 body is exactly {stage: 0}', async () => {
    const app = app3(async () => raw({ live_postings: 57 }));
    const res = await app.inject({ method: 'GET', url: '/public/totals' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ stage: 0 });
    expect(res.body).not.toContain('57');
  });

  it('empty network is stage 0', async () => {
    const res = await app3(noTotals).inject({ method: 'GET', url: '/public/totals' });
    expect(res.json()).toEqual({ stage: 0 });
  });

  it('stage 1 serves the total and countries only', async () => {
    const app = app3(async () => raw({ introductions_30d: 7 }));
    const body = (await app.inject({ method: 'GET', url: '/public/totals' })).json();
    expect(Object.keys(body).sort()).toEqual(['as_of', 'live_countries', 'live_postings', 'stage']);
    expect(body.stage).toBe(1);
    expect(body.live_postings).toBe(142);
  });

  it('stage 3 serves introductions too, and nothing per account or per posting', async () => {
    const body = (await app3(async () => raw()).inject({ method: 'GET', url: '/public/totals' })).json();
    expect(Object.keys(body).sort()).toEqual([
      'as_of',
      'introductions_30d',
      'live_countries',
      'live_postings',
      'stage',
    ]);
    expect(body.stage).toBe(3);
  });

  it('reads thresholds from config', async () => {
    const c = { envName: 'dev', publicTotals: { postingsMin: 200, introsMin: 25 } };
    const res = await app3(async () => raw(), c).inject({ method: 'GET', url: '/public/totals' });
    expect(res.json()).toEqual({ stage: 0 });
  });

  it('caches, fills a cold cache once, and shares the CORS rule', async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const app = app3(async () => {
      calls += 1;
      await gate;
      return raw();
    });
    const burst = Array.from({ length: 5 }, () =>
      app.inject({
        method: 'GET',
        url: '/public/totals',
        headers: { origin: 'https://openswitchboard.ai' },
      }),
    );
    await new Promise((r) => setTimeout(r, 20));
    release();
    const res = await Promise.all(burst);
    await app.inject({ method: 'GET', url: '/public/totals' });
    expect(calls).toBe(1);
    for (const r of res) {
      expect(r.json().stage).toBe(3);
      expect(r.headers['access-control-allow-origin']).toBe('https://openswitchboard.ai');
    }
    const pre = await app.inject({ method: 'OPTIONS', url: '/public/totals' });
    expect(pre.statusCode).toBe(204);
  });

  it('a failed fill is not cached', async () => {
    let calls = 0;
    const app = app3(async () => {
      calls += 1;
      if (calls === 1) throw new Error('db down');
      return raw();
    });
    expect((await app.inject({ method: 'GET', url: '/public/totals' })).statusCode).toBe(500);
    expect((await app.inject({ method: 'GET', url: '/public/totals' })).json().stage).toBe(3);
  });

  it('shares the per-IP budget with the other public routes', async () => {
    const app = app3(async () => raw());
    for (let i = 0; i < 60; i++) await app.inject({ method: 'GET', url: '/public/pulse' });
    const res = await app.inject({ method: 'GET', url: '/public/totals' });
    expect(res.statusCode).toBe(429);
  });

  it('counts only introductions that went live, over 30 days, and countries at the k floor', () => {
    const src = readFileSync(join(here, '..', '..', 'src', 'publicApi.ts'), 'utf8');
    expect(src).toContain('AND ${SURFACED_SQL}) AS introductions_30d');
    expect(src).toMatch(/GROUP BY geo_country HAVING count\(\*\) >= \$2::int/);
    expect(src).toContain('[TOTALS_INTROS_WINDOW_DAYS, K_ANON]');
  });
});
