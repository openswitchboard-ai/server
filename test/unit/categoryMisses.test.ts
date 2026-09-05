/**
 * What the taxonomy was asked for and did not have.
 *
 * The gap this closes: the category gate refuses a card naming a node the
 * taxonomy does not open, and until now that refusal was the whole of it. The
 * string the agent actually wanted — the one piece of evidence about what the
 * taxonomy is missing — went back over the wire and was never written down, so
 * the only way to grow the taxonomy was to guess what was absent from it.
 *
 * What is asserted here:
 *  - a refusal parks the requested string, the nodes offered against it, and
 *    the account that asked;
 *  - a LOGGING FAILURE CHANGES NOTHING. The agent gets byte-identical
 *    CATEGORY_PROHIBITED whether the row was written or the table is on fire;
 *  - an open category is not a miss, and writes nothing;
 *  - the digest groups by the requested string, counts, names the suggestion
 *    most often offered against it, and keeps a string nothing was ever
 *    suggested for rather than dropping it;
 *  - the window is a whole number of days, floored at one, and the same
 *    statement serves the server and the ops CLI.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Bedrock is not reachable from a unit test, so the suggester falls back to its
// lexical answer — deterministic, and the path a real refusal takes whenever
// the corpus is cold.
vi.mock('../../src/aws.js', () => ({
  bedrock: { send: vi.fn() },
  sqs: { send: vi.fn() },
  kms: { send: vi.fn() },
  s3: { send: vi.fn() },
  secretsManager: { send: vi.fn() },
  sesv2: { send: vi.fn() },
}));

import * as db from '../../src/db.js';
import { assertCategoryOpen } from '../../src/domain/cards.js';
import {
  CATEGORY_MISS_DIGEST_SQL,
  categoryMissDigest,
  recordCategoryMiss,
} from '../../src/domain/categoryMisses.js';
import { resetCategoryCorpus } from '../../src/domain/categorySuggest.js';
import { OsbError } from '../../src/protocol.js';
import type { Config } from '../../src/config.js';

const cfg = { bedrockEmbedModelId: 'test-embed' } as unknown as Config;
const ACCOUNT = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';

interface MissRow {
  requested: string;
  suggestions: string[] | null;
  account_id: string;
  created_at: Date;
}

/** A pool that stores misses for real and answers the digest from them. */
let misses: MissRow[];
let insertFails: boolean;
let lastDigest: { sql: string; params: any[] } | undefined;

function fakePool() {
  return {
    query: async (sql: string, params: any[] = []) => {
      if (/INSERT INTO category_misses/.test(sql)) {
        if (insertFails) throw new Error('relation "category_misses" does not exist');
        misses.push({
          requested: params[0],
          suggestions: params[1],
          account_id: params[2],
          created_at: new Date(),
        });
        return { rows: [], rowCount: 0 };
      }
      if (/FROM category_misses/.test(sql)) {
        lastDigest = { sql, params };
        // The digest as Postgres would answer it, computed in TS over the rows
        // the fake actually holds: grouped by the requested string, counted,
        // with the suggestion most often offered against it, commonest first.
        const cutoff = Date.now() - Number(params[0]) * 86_400_000;
        const recent = misses.filter((m) => +m.created_at > cutoff);
        const byRequested = new Map<string, MissRow[]>();
        for (const m of recent) {
          byRequested.set(m.requested, [...(byRequested.get(m.requested) ?? []), m]);
        }
        const rows = [...byRequested.entries()].map(([requested, group]) => {
          const tally = new Map<string, number>();
          for (const m of group) {
            for (const s of m.suggestions ?? []) tally.set(s, (tally.get(s) ?? 0) + 1);
          }
          const top = [...tally.entries()].sort(
            (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
          )[0];
          return {
            requested,
            count: group.length,
            top_suggestion: top ? top[0] : null,
            last_seen: new Date(Math.max(...group.map((m) => +m.created_at))),
          };
        });
        rows.sort((a, b) => b.count - a.count || a.requested.localeCompare(b.requested));
        return { rows, rowCount: rows.length };
      }
      return { rows: [], rowCount: 0 };
    },
  } as any;
}

beforeEach(() => {
  misses = [];
  insertFails = false;
  lastDigest = undefined;
  resetCategoryCorpus();
  vi.spyOn(db, 'getPool').mockReturnValue(fakePool());
});

// ---------------------------------------------------------------------------
describe('a refused category is written down', () => {
  it('parks what was asked for, what was offered, and who asked', async () => {
    await expect(assertCategoryOpen(cfg, 'goods.pushbike', ACCOUNT)).rejects.toBeInstanceOf(
      OsbError,
    );
    expect(misses).toHaveLength(1);
    expect(misses[0]).toMatchObject({ requested: 'goods.pushbike', account_id: ACCOUNT });
    // The suggestions stored are the ones the agent was actually offered.
    expect(misses[0].suggestions?.length).toBeGreaterThan(0);
    expect(misses[0].suggestions!.every((s) => s.startsWith('goods.bicycle'))).toBe(true);
  });

  it('an open category is not a miss, and writes nothing', async () => {
    await expect(assertCategoryOpen(cfg, 'goods.bicycle.mountain', ACCOUNT)).resolves.toBeUndefined();
    expect(misses).toHaveLength(0);
  });

  it('a reserved top level is a miss too — it is still demand', async () => {
    // 'work' is in the taxonomy but held back, so the agent is refused and the
    // string is exactly the kind of thing the digest exists to surface.
    await expect(assertCategoryOpen(cfg, 'work.freelance', ACCOUNT)).rejects.toBeInstanceOf(
      OsbError,
    );
    expect(misses.map((m) => m.requested)).toEqual(['work.freelance']);
  });

  it('recordCategoryMiss stores an empty offer list rather than refusing', async () => {
    await recordCategoryMiss(ACCOUNT, 'goods.nothing-like-this');
    expect(misses).toHaveLength(1);
    expect(misses[0].suggestions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe('a logging failure changes nothing the agent sees', () => {
  const refusalPayload = async () => {
    try {
      await assertCategoryOpen(cfg, 'goods.pushbike', ACCOUNT);
      throw new Error('the category gate did not refuse');
    } catch (e) {
      if (!(e instanceof OsbError)) throw e;
      return e.payload;
    }
  };

  it('the refusal is byte-identical whether or not the row was written', async () => {
    const withLog = await refusalPayload();
    expect(misses).toHaveLength(1);

    insertFails = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const withoutLog = await refusalPayload();

    expect(withoutLog).toEqual(withLog);
    expect(withoutLog.code).toBe('CATEGORY_PROHIBITED');
    expect(withoutLog.suggestions?.length).toBeGreaterThan(0);
    // Nothing new was stored, and the failure was said out loud exactly once.
    expect(misses).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('the refusal stands');
    warn.mockRestore();
  });

  it('recordCategoryMiss itself never rejects', async () => {
    insertFails = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(recordCategoryMiss(ACCOUNT, 'goods.pushbike', ['goods.bicycle'])).resolves
      .toBeUndefined();
    warn.mockRestore();
  });
});

// ---------------------------------------------------------------------------
describe('the digest', () => {
  const miss = (requested: string, suggestions: string[], agoDays = 0) =>
    misses.push({
      requested,
      suggestions,
      account_id: ACCOUNT,
      created_at: new Date(Date.now() - agoDays * 86_400_000),
    });

  it('groups by what was asked for, commonest first', async () => {
    miss('goods.pushbike', ['goods.bicycle.parts']);
    miss('goods.pushbike', ['goods.bicycle.parts']);
    miss('goods.pushbike', ['goods.bicycle.bmx']);
    miss('goods.espresso-machine', ['goods.appliances.kitchen.coffee']);

    const rows = await categoryMissDigest(14);
    expect(rows.map((r) => r.requested)).toEqual(['goods.pushbike', 'goods.espresso-machine']);
    expect(rows[0].count).toBe(3);
    // The mode, not whichever one happened to be stored first or last.
    expect(rows[0].top_suggestion).toBe('goods.bicycle.parts');
    expect(rows[0].last_seen).toBeInstanceOf(Date);
    expect(rows[1]).toMatchObject({
      count: 1,
      top_suggestion: 'goods.appliances.kitchen.coffee',
    });
  });

  it('keeps a string nothing was ever suggested for', async () => {
    miss('goods.nothing-like-this', []);
    const rows = await categoryMissDigest(14);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ requested: 'goods.nothing-like-this', count: 1 });
    expect(rows[0].top_suggestion).toBeNull();
  });

  it('only counts misses inside the window', async () => {
    miss('goods.pushbike', ['goods.bicycle.parts']);
    miss('goods.pushbike', ['goods.bicycle.parts'], 30);
    expect((await categoryMissDigest(7))[0].count).toBe(1);
    expect((await categoryMissDigest(60))[0].count).toBe(2);
  });

  it('asks for a whole number of days, floored at one', async () => {
    await categoryMissDigest(0.5);
    expect(lastDigest?.params).toEqual([1]);
    await categoryMissDigest(-9);
    expect(lastDigest?.params).toEqual([1]);
    await categoryMissDigest(30.7);
    expect(lastDigest?.params).toEqual([30]);
  });
});

// ---------------------------------------------------------------------------
describe('the statement the server and the ops CLI share', () => {
  it('windows on the parameter, groups by the requested string, and ranks by count', () => {
    expect(CATEGORY_MISS_DIGEST_SQL).toContain('FROM category_misses');
    expect(CATEGORY_MISS_DIGEST_SQL).toContain('make_interval(days => $1::int)');
    expect(CATEGORY_MISS_DIGEST_SQL).toContain('GROUP BY requested');
    expect(CATEGORY_MISS_DIGEST_SQL).toContain('ORDER BY t.count DESC, t.requested ASC');
    // A LEFT JOIN, so a string nothing was suggested for still has a row.
    expect(CATEGORY_MISS_DIGEST_SQL).toContain('LEFT JOIN top x USING (requested)');
    // The window is the ONLY thing interpolated: no other placeholder exists,
    // which is what lets the CLI rewrite $1 to a named parameter safely.
    expect(CATEGORY_MISS_DIGEST_SQL.match(/\$\d+/g)).toEqual(['$1']);
  });

  it('names the four columns the digest promises', () => {
    for (const col of ['requested', 'count', 'top_suggestion', 'last_seen']) {
      expect(CATEGORY_MISS_DIGEST_SQL).toContain(col);
    }
  });
});
