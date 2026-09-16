/**
 * What the taxonomy was asked for and did not have — a GROWTH LIST now.
 *
 * The catalogue is a deny list since 17 September 2026, so an unknown leaf is
 * no longer refused: the posting goes up and the string is written down after
 * it does. These rows are what is live on the board under a name nobody has
 * written yet, which is as clean a statement of what the next taxonomy release
 * should contain as this network is going to get.
 *
 * What is asserted here:
 *  - the gate LETS AN UNKNOWN LEAF THROUGH and says the taxonomy did not know
 *    it, so the caller can write it down after the posting is up;
 *  - an unknown leaf has to say in plain words what the thing is, and the gate
 *    refuses one that does not;
 *  - a reserved family is still refused, and is NOT written down: that is a
 *    policy decision already taken rather than a gap in the catalogue;
 *  - a LOGGING FAILURE CHANGES NOTHING. recordCategoryMiss resolves whatever
 *    happens, because the posting is already up;
 *  - the digest groups by the requested string, counts, names the suggestion
 *    most often offered against it and the words agents most often used for
 *    it, and keeps a string nothing was ever suggested for rather than
 *    dropping it;
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
  kind?: string | null;
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
          kind: params[3] ?? null,
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
          const named = new Map<string, number>();
          for (const m of group) {
            if (m.kind) named.set(m.kind, (named.get(m.kind) ?? 0) + 1);
          }
          const topKind = [...named.entries()].sort(
            (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
          )[0];
          return {
            requested,
            count: group.length,
            top_suggestion: top ? top[0] : null,
            top_kind: topKind ? topKind[0] : null,
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
describe('the gate lets an unknown leaf through and says so', () => {
  it('an unknown leaf with plain words for the thing goes up', async () => {
    // The whole change: 'goods.pushbike' is not in the taxonomy, the top level
    // is open, nothing on the path is reserved, so it goes up. The gate says
    // the taxonomy did not know it, which is what the caller writes down after
    // the posting lands — and nothing is written here.
    await expect(assertCategoryOpen(cfg, 'goods.pushbike', ACCOUNT, 'old push bike')).resolves.toEqual(
      { known: false },
    );
    expect(misses).toHaveLength(0);
  });

  it('an unknown leaf with no plain words for the thing is refused', async () => {
    // Not CATEGORY_PROHIBITED: the category was fine and the posting is short
    // of a field, so it comes back the way any validation refusal does.
    await expect(assertCategoryOpen(cfg, 'goods.pushbike', ACCOUNT)).rejects.toMatchObject({
      validation: ['kind'],
    });
    await expect(
      assertCategoryOpen(cfg, 'goods.pushbike', ACCOUNT, 'push bike for $200'),
    ).rejects.toMatchObject({ validation: ['kind'] });
    await expect(
      assertCategoryOpen(cfg, 'goods.pushbike', ACCOUNT, 'a really rather nice old second-hand push bike'),
    ).rejects.toMatchObject({ validation: ['kind'] });
    expect(misses).toHaveLength(0);
  });

  it('a known open category needs no plain words and writes nothing', async () => {
    await expect(assertCategoryOpen(cfg, 'goods.bicycle.mountain', ACCOUNT)).resolves.toEqual({
      known: true,
    });
    expect(misses).toHaveLength(0);
  });

  it('a reserved top level is still refused, and is NOT demand', async () => {
    // 'work' is in the taxonomy and held back on purpose. That is a policy
    // decision already taken, and counting it as demand would put "open the
    // jobs vertical" at the top of a list whose job is to say what to build.
    await expect(assertCategoryOpen(cfg, 'work.freelance', ACCOUNT)).rejects.toBeInstanceOf(
      OsbError,
    );
    expect(misses).toHaveLength(0);
  });

  it('an unknown child of a reserved family is reserved, not unknown', async () => {
    // The ordering the old gate got wrong: social.dating is reserved, so
    // everything under it is, whether or not the leaf itself was written down.
    await expect(
      assertCategoryOpen(cfg, 'social.dating.speed-dating-nights', ACCOUNT, 'speed dating'),
    ).rejects.toBeInstanceOf(OsbError);
    expect(misses).toHaveLength(0);
  });

  it('a top level the taxonomy has no name for is refused', async () => {
    await expect(assertCategoryOpen(cfg, 'nonsense.thing', ACCOUNT, 'a thing')).rejects.toBeInstanceOf(
      OsbError,
    );
    expect(misses).toHaveLength(0);
  });

  it('recordCategoryMiss stores an empty offer list rather than refusing', async () => {
    await recordCategoryMiss(ACCOUNT, 'goods.nothing-like-this');
    expect(misses).toHaveLength(1);
    expect(misses[0].suggestions).toEqual([]);
    expect(misses[0].kind).toBeNull();
  });

  it('recordCategoryMiss keeps the words the agent used for the thing', async () => {
    await recordCategoryMiss(ACCOUNT, 'goods.pushbike', ['goods.bicycle'], 'old push bike');
    expect(misses[0]).toMatchObject({
      requested: 'goods.pushbike',
      account_id: ACCOUNT,
      kind: 'old push bike',
    });
  });
});

// ---------------------------------------------------------------------------
describe('a logging failure changes nothing the agent sees', () => {
  it('the posting stands whether or not the row was written', async () => {
    await recordCategoryMiss(ACCOUNT, 'goods.pushbike', ['goods.bicycle'], 'old push bike');
    expect(misses).toHaveLength(1);

    insertFails = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(
      recordCategoryMiss(ACCOUNT, 'goods.pushbike', ['goods.bicycle'], 'old push bike'),
    ).resolves.toBeUndefined();

    // Nothing new was stored, and the failure was said out loud exactly once.
    expect(misses).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('the posting stands');
    warn.mockRestore();
  });

  it('a refused category still refuses with the closest open ones beside it', async () => {
    const payload = await assertCategoryOpen(cfg, 'work.freelance', ACCOUNT).then(
      () => {
        throw new Error('the category gate did not refuse');
      },
      (e) => {
        if (!(e instanceof OsbError)) throw e;
        return e.payload;
      },
    );
    expect(payload.code).toBe('CATEGORY_PROHIBITED');
    expect(payload.suggestions?.length).toBeGreaterThan(0);
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
  const miss = (requested: string, suggestions: string[], agoDays = 0, kind: string | null = null) =>
    misses.push({
      requested,
      suggestions,
      account_id: ACCOUNT,
      kind,
      created_at: new Date(Date.now() - agoDays * 86_400_000),
    });

  it('names the words agents most often used for the thing', () => {
    miss('goods.pushbike', ['goods.bicycle'], 0, 'old push bike');
    miss('goods.pushbike', ['goods.bicycle'], 0, 'old push bike');
    miss('goods.pushbike', ['goods.bicycle'], 0, 'pushie');
    return categoryMissDigest(14).then((rows) => {
      expect(rows[0].top_kind).toBe('old push bike');
    });
  });

  it('keeps a row whose postings never said what the thing was', () =>
    categoryMissDigest(14).then(() => {
      miss('goods.mystery', []);
      return categoryMissDigest(14).then((rows) => {
        expect(rows[0].top_kind).toBeNull();
      });
    }));

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
