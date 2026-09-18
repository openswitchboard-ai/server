/**
 * NEAR MISSES REACH THE ASSISTANT.
 *
 * A pair that scored between the near-miss floor and the create threshold has
 * passed every hard rule and is simply not close enough to put two people
 * together over. Until now those rows were written down and seen by nobody:
 * the weekly digest counted them and the count was the whole of it, so an
 * assistant sweeping for its human heard the same silence whether nine people
 * had come close or none had.
 *
 * What is asserted here:
 *   - they come back in their own list, never among the introductions;
 *   - each one carries the side, the thing in plain words, and one sentence;
 *   - the other poster's own words wear the counterparty label;
 *   - nothing identifying travels: no account, no name, no area, no
 *     attributes, no figure, no identifier of the other posting, no closeness;
 *   - the list is capped and deduped, and the count still tells the truth;
 *   - a posting that has since been taken down is not offered for a look.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/aws.js', () => ({ bedrock: { send: vi.fn() }, sqs: { send: vi.fn() } }));

import * as db from '../../src/db.js';
import {
  NEAR_MISS_LIMIT,
  NEAR_MISS_WINDOW_DAYS,
  nearMissesForCards,
} from '../../src/domain/nearMisses.js';
import { lintHumanCopy } from '../../src/email/lint.js';

const ACCOUNT = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const MINE = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

/**
 * Words no sentence written for a human may carry: the machinery's own names
 * for things. "want" and "have" are ordinary English, so only the shouted
 * protocol spellings are matched.
 */
const MACHINERY = [
  /\b(cards?|channels?|match(es)?|stages?|connections?|scores?)\b/i,
  /\bWANT\b/,
  /\bHAVE\b/,
];

interface Row {
  card_id: string;
  other_id: string;
  other_type: 'WANT' | 'HAVE';
  other_category: string;
  other_kind: string | null;
  created_at: Date;
}

let rows: Row[];
/** Every statement the call made, so the extra work can be counted. */
let sql: string[];

const row = (over: Partial<Row> = {}): Row => ({
  card_id: MINE,
  other_id: 'cccccccc-3333-4333-8333-cccccccccccc',
  other_type: 'HAVE',
  other_category: 'goods.bicycle.mountain',
  other_kind: null,
  created_at: new Date('2026-09-17T10:00:00Z'),
  ...over,
});

beforeEach(() => {
  rows = [row()];
  sql = [];
  vi.spyOn(db, 'getPool').mockReturnValue({
    query: async (text: string) => {
      sql.push(text.replace(/\s+/g, ' ').trim());
      return { rows, rowCount: rows.length };
    },
  } as any);
});

const forMine = async () => (await nearMissesForCards(ACCOUNT, [MINE])).get(MINE);

// ---------------------------------------------------------------------------
describe('what a near miss says', () => {
  it('names the side, the thing, and the line to say', async () => {
    const e = (await forMine())!;
    expect(e.intent_id).toBe(MINE);
    expect(e.count).toBe(1);
    expect(e.items).toHaveLength(1);
    expect(e.items[0].they).toBe('have');
    expect(e.items[0].what).toBe('Mountain bikes');
    expect(e.items[0].note.text).toContain('Not quite a fit');
    expect(e.items[0].note.text).toContain('Mountain bikes');
    expect(e.items[0].note.provenance).toBe('switchboard-system');
  });

  it('says wants when the other side is the one looking', async () => {
    rows = [row({ other_type: 'WANT' })];
    const e = (await forMine())!;
    expect(e.items[0].they).toBe('want');
    expect(e.items[0].note.text).toContain('wants');
  });

  it('offers a look and promises nothing', async () => {
    const e = (await forMine())!;
    expect(e.items[0].note.text).toContain('Want me to try that?');
    expect(e.note.text).toContain('Nobody has been introduced');
    expect(e.note.text).toContain('nothing has crossed');
  });

  it('writes both sentences in words a human can hear', async () => {
    const e = (await forMine())!;
    for (const text of [e.note.text, e.items[0].note.text]) {
      expect(lintHumanCopy(text), text).toEqual([]);
      for (const re of MACHINERY) expect(re.test(text), text).toBe(false);
    }
  });

  it('counts one of them and several of them the way a person says it', async () => {
    expect((await forMine())!.note.text).toContain('One near miss this week');
    rows = [row(), row({ other_id: 'd1' }), row({ other_id: 'd2' })];
    expect((await forMine())!.note.text).toContain('3 near misses this week');
  });
});

// ---------------------------------------------------------------------------
describe('the poster own words', () => {
  it('come back under the counterparty label, trimmed', async () => {
    rows = [row({ other_category: 'goods.gaming.sim-racing', other_kind: '  sim racing rig  ' })];
    const e = (await forMine())!;
    expect(e.items[0].their_words).toEqual({
      text: 'sim racing rig',
      provenance: 'counterparty-untrusted',
    });
    // And they are what the sentence names the thing by, because the
    // catalogue has no word to lend for a leaf it has never heard of.
    expect(e.items[0].what).toBe('sim racing rig');
  });

  it('are left out entirely where the poster wrote none', async () => {
    const e = (await forMine())!;
    expect(e.items[0].their_words).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
describe('what never travels', () => {
  it('carries no account, no identifier, no area, no figure and no closeness', async () => {
    rows = [row({ other_kind: 'sim racing rig' })];
    const e = (await forMine())!;
    const keys = Object.keys(e.items[0]).sort();
    expect(keys).toEqual(['at', 'note', 'their_words', 'they', 'what']);
    const whole = JSON.stringify(e);
    for (const leak of ['account', 'other_id', 'cccccccc', 'score', 'geo', 'bucket', 'attributes']) {
      expect(whole.includes(leak), leak).toBe(false);
    }
  });

  it('asks the database for nothing it would have to leave out', async () => {
    await forMine();
    const q = sql[0];
    expect(q).not.toMatch(/o\.account_id AS|o\.geo|o\.attributes|nm\.score/);
    // The other posting's id is read, and only so that a pair seen twice is
    // counted once. It is never put in the answer.
    expect(q).toContain('t.other AS other_id');
  });
});

// ---------------------------------------------------------------------------
describe('how many come back', () => {
  it('counts one per other posting, however many rows name it', async () => {
    rows = [row(), row(), row()];
    const e = (await forMine())!;
    expect(e.count).toBe(1);
    expect(e.items).toHaveLength(1);
  });

  it('caps the list and still says how many there are', async () => {
    rows = Array.from({ length: NEAR_MISS_LIMIT + 4 }, (_, i) =>
      row({ other_id: `other-${i}`, other_kind: `thing ${i}` }),
    );
    const e = (await forMine())!;
    expect(e.count).toBe(NEAR_MISS_LIMIT + 4);
    expect(e.items).toHaveLength(NEAR_MISS_LIMIT);
    // Newest first: the rows arrive in that order and the cap takes the front.
    expect(e.items[0].their_words!.text).toBe('thing 0');
  });

  it('leaves a posting with nothing near it out of the answer altogether', async () => {
    rows = [];
    expect(await forMine()).toBeUndefined();
  });

  it('asks for nothing at all when there are no postings to ask about', async () => {
    const found = await nearMissesForCards(ACCOUNT, []);
    expect(found.size).toBe(0);
    expect(sql).toEqual([]);
  });

  it('holds the window and the cap where the manual can describe them', () => {
    expect(NEAR_MISS_WINDOW_DAYS).toBe(7);
    expect(NEAR_MISS_LIMIT).toBe(5);
  });
});

// ---------------------------------------------------------------------------
describe('what the statement itself refuses to fetch', () => {
  it('keeps to the window, to what is still up, and to somebody else', async () => {
    await forMine();
    const q = sql[0];
    expect(q).toContain("o.lifecycle_state = 'PUBLISHED'");
    expect(q).toContain('o.expires_at > now()');
    expect(q).toContain('NOT o.paused_by_kill_switch');
    expect(q).toContain('o.account_id <> $2::uuid');
    expect(q).toContain('make_interval(days => $3::int)');
  });

  it('asks once for the whole sweep, however many postings are on the board', async () => {
    await nearMissesForCards(ACCOUNT, [MINE, 'e1', 'e2', 'e3', 'e4']);
    expect(sql).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// And where the assistant actually reads them
// ---------------------------------------------------------------------------
describe('on the list of a human own wants and haves', () => {
  const CATEGORY = 'goods.bicycle.mountain';

  /** Enough PostgreSQL for listIntents, plus the near misses it now asks for. */
  const routingPool = () =>
    ({
      query: async (text: string) => {
        const q = text.replace(/\s+/g, ' ').trim();
        sql.push(q);
        if (q.startsWith('SELECT timezone FROM accounts')) {
          return { rows: [{ timezone: null }], rowCount: 1 };
        }
        if (q.startsWith('SELECT id, schema_version, type, category')) {
          return {
            rows: [
              {
                id: MINE,
                schema_version: '0.16.0',
                type: 'WANT',
                category: CATEGORY,
                kind: null,
                geo: { bucket: 'r3gx', radius_km: 25 },
                attributes: {},
                ask: null,
                urgency: 'none',
                visibility: 'anonymous-until-match',
                protocol_status: 'active',
                lifecycle_state: 'PUBLISHED',
                ttl_days: 60,
                expires_at: new Date('2026-11-01T00:00:00Z'),
                created_at: new Date('2026-09-01T00:00:00Z'),
                updated_at: new Date('2026-09-01T00:00:00Z'),
                screening: null,
                slots: 1,
                sale: 'straight',
              },
            ],
            rowCount: 1,
          };
        }
        if (q.startsWith('SELECT t.mine AS card_id')) return { rows, rowCount: rows.length };
        return { rows: [], rowCount: 0 };
      },
    }) as any;

  it('rides beside the people who have come forward, in its own field', async () => {
    vi.spyOn(db, 'getPool').mockReturnValue(routingPool());
    const { listIntents } = await import('../../src/domain/cards.js');
    const entry: any = (await listIntents(ACCOUNT))[0];
    // Nobody has come forward, and that stays true and separate.
    expect(entry.people_here).toBe(0);
    expect(entry.in_line).toBe(0);
    expect(entry.near_misses.count).toBe(1);
    expect(entry.near_misses.items[0].they).toBe('have');
    // The lead sentence is still the one about who is there. A near miss never
    // gets in front of it, because nobody is there on account of one.
    expect(entry.note.text).toContain('Nothing yet');
  });

  it('is left off entirely when nothing came close', async () => {
    rows = [];
    vi.spyOn(db, 'getPool').mockReturnValue(routingPool());
    const { listIntents } = await import('../../src/domain/cards.js');
    const entry: any = (await listIntents(ACCOUNT))[0];
    expect(entry.near_misses).toBeUndefined();
  });
});
