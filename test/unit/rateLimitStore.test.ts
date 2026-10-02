/**
 * N11: the abuse limiters count in one shared
 * store, so several tasks share one window; keys are hashed before they are
 * stored; rows go once their window closes; and a store that fails never
 * locks anybody out — the hit is counted in this task alone, as before.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as db from '../../src/db.js';
import {
  makeIpLimiter,
  useLocalLimiterStore,
  useSharedLimiterStore,
  type LimiterStore,
} from '../../src/abuseLimit.js';
import {
  RATE_LIMIT_COUNT_SQL,
  RATE_LIMIT_HIT_SQL,
  postgresLimiterStore,
  rateLimitKeyHash,
  sweepRateLimitWindows,
} from '../../src/rateLimitStore.js';
import { initCounterKeys } from '../../src/counter/keys.js';

const root = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

beforeAll(async () => {
  process.env.COUNTER_LINK_HMAC_KEY ??= randomBytes(32).toString('hex');
  process.env.COUNTER_COOKIE_KEY ??= randomBytes(32).toString('hex');
  await initCounterKeys({} as any);
});

afterEach(() => {
  useLocalLimiterStore();
  vi.restoreAllMocks();
});

/**
 * A pool that answers RATE_LIMIT_HIT_SQL the way Postgres would: one row per
 * (limiter, key_hash), a window that opens at the first hit and runs for the
 * window, and a fresh count once it has closed. The clock is ours to move.
 */
function fakeRateLimitPool() {
  let now = 1_000_000;
  const rows = new Map<string, { window_start: number; expires_at: number; n: number }>();
  const seen: { sql: string; params: unknown[] }[] = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    seen.push({ sql, params });
    if (sql === RATE_LIMIT_HIT_SQL) {
      const [limiter, keyHash, windowMs] = params as [string, string, number];
      const k = `${limiter}|${keyHash}`;
      const r = rows.get(k);
      if (!r || r.expires_at <= now) {
        rows.set(k, { window_start: now, expires_at: now + Number(windowMs), n: 1 });
      } else {
        r.n = Math.min(r.n + 1, 1_000_000);
      }
      return { rows: [{ n: rows.get(k)!.n }], rowCount: 1 };
    }
    if (/^DELETE FROM rate_limit_windows WHERE expires_at <= now\(\)$/.test(sql)) {
      let n = 0;
      for (const [k, r] of rows) if (r.expires_at <= now) (rows.delete(k), n++);
      return { rows: [], rowCount: n };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  });
  return {
    pool: { query } as any,
    rows,
    seen,
    advance(ms: number) {
      now += ms;
    },
  };
}

describe('the shared store', () => {
  it('two tasks share one window: the cap is the cap, not the cap times the tasks', async () => {
    const f = fakeRateLimitPool();
    vi.spyOn(db, 'getPool').mockReturnValue(f.pool);
    useSharedLimiterStore(postgresLimiterStore, () => {});
    // Two limiters built the same way are what two ECS tasks each hold.
    const taskA = makeIpLimiter(3, 60_000, 'test-shared');
    const taskB = makeIpLimiter(3, 60_000, 'test-shared');
    expect(await taskA.limited('1.1.1.1')).toBe(false);
    expect(await taskB.limited('1.1.1.1')).toBe(false);
    expect(await taskA.limited('1.1.1.1')).toBe(false);
    expect(await taskB.limited('1.1.1.1')).toBe(true);
    expect(await taskA.limited('1.1.1.1')).toBe(true);
    // Another IP is its own window.
    expect(await taskB.limited('2.2.2.2')).toBe(false);
  });

  it('a fresh window opens once the old one has run out, and a deploy resets nothing', async () => {
    const f = fakeRateLimitPool();
    vi.spyOn(db, 'getPool').mockReturnValue(f.pool);
    useSharedLimiterStore(postgresLimiterStore, () => {});
    const before = makeIpLimiter(1, 60_000, 'test-window');
    expect(await before.limited('1.1.1.1')).toBe(false);
    expect(await before.limited('1.1.1.1')).toBe(true);
    // A new process (a deploy) still sees the live window.
    const after = makeIpLimiter(1, 60_000, 'test-window');
    after.reset();
    expect(await after.limited('1.1.1.1')).toBe(true);
    // Both clocks move on: the database's and this task's.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 60_000);
      f.advance(60_000);
      expect(await after.limited('1.1.1.1')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a task already over the limit on its own refuses without asking the store', async () => {
    const f = fakeRateLimitPool();
    vi.spyOn(db, 'getPool').mockReturnValue(f.pool);
    useSharedLimiterStore(postgresLimiterStore, () => {});
    const lim = makeIpLimiter(2, 60_000, 'test-short');
    for (let i = 0; i < 2; i++) expect(await lim.limited('1.1.1.1')).toBe(false);
    expect(await lim.limited('1.1.1.1')).toBe(true); // the store said 3
    const asked = f.seen.length;
    for (let i = 0; i < 50; i++) expect(await lim.limited('1.1.1.1')).toBe(true);
    expect(f.seen.length).toBe(asked);
  });

  it('peek reads the shared count without recording, for the ops page failure check', async () => {
    const f = fakeRateLimitPool();
    vi.spyOn(db, 'getPool').mockReturnValue(f.pool);
    // The fake answers the count query from the same rows.
    const inner = f.pool.query;
    f.pool.query = vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql === RATE_LIMIT_COUNT_SQL) {
        const r = f.rows.get(`${params[0]}|${params[1]}`);
        return { rows: r ? [{ n: r.n }] : [], rowCount: r ? 1 : 0 };
      }
      return inner(sql, params);
    });
    useSharedLimiterStore(postgresLimiterStore, () => {});
    const taskA = makeIpLimiter(10, 60_000, 'test-peek');
    const taskB = makeIpLimiter(10, 60_000, 'test-peek');
    expect(await taskB.peek('1.1.1.1')).toBe(0);
    for (let i = 0; i < 4; i++) await taskA.limited('1.1.1.1');
    expect(await taskB.peek('1.1.1.1')).toBe(4);
    expect(await taskB.peek('1.1.1.1')).toBe(4);
  });

  it('never stores the IP: the key is an HMAC, bound to the limiter', async () => {
    const f = fakeRateLimitPool();
    vi.spyOn(db, 'getPool').mockReturnValue(f.pool);
    useSharedLimiterStore(postgresLimiterStore, () => {});
    await makeIpLimiter(5, 60_000, 'test-hash').limited('203.0.113.7');
    const [limiter, keyHash, windowMs] = f.seen[0].params as string[];
    expect(limiter).toBe('test-hash');
    expect(windowMs).toBe(60_000);
    expect(keyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(f.seen)).not.toContain('203.0.113.7');
    expect(keyHash).toBe(rateLimitKeyHash('test-hash', '203.0.113.7'));
    expect(rateLimitKeyHash('other', '203.0.113.7')).not.toBe(keyHash);
  });

  it('the upsert is one atomic statement that replaces an expired window whole', () => {
    expect(RATE_LIMIT_HIT_SQL).toMatch(/^INSERT INTO rate_limit_windows/);
    expect(RATE_LIMIT_HIT_SQL).toMatch(/ON CONFLICT \(limiter, key_hash\) DO UPDATE/);
    expect(RATE_LIMIT_HIT_SQL.match(/rate_limit_windows\.expires_at <= now\(\)/g)).toHaveLength(3);
    expect(RATE_LIMIT_HIT_SQL).toMatch(/RETURNING n$/);
  });

  it('the sweep deletes every window that has closed, and only those', async () => {
    const f = fakeRateLimitPool();
    vi.spyOn(db, 'getPool').mockReturnValue(f.pool);
    useSharedLimiterStore(postgresLimiterStore, () => {});
    await makeIpLimiter(5, 1_000, 'test-sweep').limited('1.1.1.1');
    await makeIpLimiter(5, 60_000, 'test-sweep-long').limited('1.1.1.1');
    f.advance(1_000);
    expect(await sweepRateLimitWindows()).toEqual({ rate_limit_windows: 1 });
    expect(f.rows.size).toBe(1);
  });

  it('the ttl-expiry tick runs the sweep, and boot switches the store on', () => {
    const w = read('src/workers/opsWorker.ts');
    const tick = w.slice(w.indexOf("case 'ttl-expiry'"), w.indexOf("case 'sequencer-tick'"));
    expect(tick).toMatch(/await sweepRateLimitWindows\(\)/);
    const idx = read('src/index.ts');
    expect(idx).toMatch(/useSharedLimiterStore\(postgresLimiterStore/);
    // After the keys it hashes with.
    expect(idx.indexOf('useSharedLimiterStore(')).toBeGreaterThan(idx.indexOf('await initCounterKeys(cfg)'));
  });

  it('the table the store writes exists, keyed by limiter and hash', () => {
    const sql = read('migrations/062_rate_limit_windows.sql');
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS rate_limit_windows/);
    expect(sql).toMatch(/PRIMARY KEY \(limiter, key_hash\)/);
  });
});

describe('when the store fails', () => {
  const broken: LimiterStore = {
    hit: vi.fn(async () => {
      throw new Error('connection terminated');
    }),
    count: vi.fn(async () => {
      throw new Error('connection terminated');
    }),
  };

  it('fails open to this task\'s own count — never everyone refused, never no limit', async () => {
    const logs: unknown[] = [];
    useSharedLimiterStore(broken, (msg, extra) => logs.push({ msg, extra }));
    const lim = makeIpLimiter(2, 60_000, 'test-broken');
    expect(await lim.limited('1.1.1.1')).toBe(false);
    expect(await lim.limited('1.1.1.1')).toBe(false);
    expect(await lim.limited('1.1.1.1')).toBe(true);
    expect(await lim.limited('2.2.2.2')).toBe(false);
    // Logged, throttled to one line a minute per limiter, and never the key.
    expect(logs).toHaveLength(1);
    expect(JSON.stringify(logs)).toMatch(/fail-open/);
    expect(JSON.stringify(logs)).toMatch(/connection terminated/);
    expect(JSON.stringify(logs)).not.toContain('1.1.1.1');
  });

  it('treats an answer with no count as a failure too', async () => {
    const logs: unknown[] = [];
    useSharedLimiterStore({ hit: async () => NaN, count: async () => NaN }, (msg) => logs.push(msg));
    const lim = makeIpLimiter(1, 60_000, 'test-nan');
    expect(await lim.limited('1.1.1.1')).toBe(false);
    expect(await lim.limited('1.1.1.1')).toBe(true);
    expect(logs).toHaveLength(1);
  });

  it('peek falls back to this task\'s own count', async () => {
    useSharedLimiterStore(broken, () => {});
    const lim = makeIpLimiter(10, 60_000, 'test-peek-broken');
    await lim.limited('1.1.1.1');
    await lim.limited('1.1.1.1');
    expect(await lim.peek('1.1.1.1')).toBe(2);
  });

  it('a logger that throws does not take the request with it', async () => {
    useSharedLimiterStore(broken, () => {
      throw new Error('logger down');
    });
    expect(await makeIpLimiter(1, 60_000, 'test-logger').limited('1.1.1.1')).toBe(false);
  });
});

describe('the limiters themselves', () => {
  it('every shipped limiter has its own name, and the limits are unchanged', () => {
    const src = read('src/abuseLimit.ts');
    const made = [...src.matchAll(/makeIpLimiter\((\d+), ([\d *]+), '([a-z-]+)'\)/g)].map((m) => [
      m[3],
      Number(m[1]),
      eval(m[2]) as number,
    ]);
    expect(Object.fromEntries(made.map(([n, max, w]) => [n, [max, w]]))).toEqual({
      'client-registration': [5, 3_600_000],
      'verification-email': [15, 3_600_000],
      'area-suggest': [60, 60_000],
      'kill-switch': [5, 3_600_000],
      'assistant-disconnect': [20, 3_600_000],
      'pin-attempt': [10, 60_000],
      'anonymous-session': [10, 60_000],
    });
    expect(src).toMatch(/ACCOUNTLESS_VERIFICATIONS_PER_HOUR,\s+60 \* 60 \* 1000,\s+'accountless-verification'/);
  });

  it('an unnamed limiter never touches the store', async () => {
    const hit = vi.fn(async () => 1);
    useSharedLimiterStore({ hit, count: hit }, () => {});
    await makeIpLimiter(1, 60_000).limited('1.1.1.1');
    expect(hit).not.toHaveBeenCalled();
  });

  it('the public API and the ops page failure count use the shared store too', () => {
    expect(read('src/publicApi.ts')).toMatch(/makeIpLimiter\(RATE_LIMIT, RATE_WINDOW_MS, 'public-api'\)/);
    const ops = read('src/opsMetrics.ts');
    expect(ops).toMatch(/makeIpLimiter\(FAIL_LIMIT, FAIL_WINDOW_MS, 'ops-metrics-auth-failure'\)/);
    expect(ops).toMatch(/await failures\.peek\(ip\)\) >= FAIL_LIMIT/);
    expect(ops).not.toMatch(/new Map<string, \{ windowStart/);
    expect(read('src/publicApi.ts')).not.toMatch(/new Map<string, \{ windowStart/);
  });

  it('the bypass is still checked first on every per-IP door, so a bypassed hit is never counted', () => {
    for (const f of ['src/counter/routes.ts', 'src/auth/oauth.ts']) {
      const lines = read(f).split('\n').filter((l) => /\.limited\(req\.ip\)/.test(l));
      expect(lines.length).toBeGreaterThan(0);
      for (const l of lines) expect(l).toMatch(/!rateLimitBypassed\([^)]*\) && await \w+\.limited\(req\.ip\)/);
    }
  });
});
