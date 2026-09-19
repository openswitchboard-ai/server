/**
 * SNAP AT THE DOOR.
 *
 * Run 9 on dev put two postings for the same object on the same switchboard
 * and never showed them to each other. The have went up under
 * 'goods.gaming.sim-racing', which is a branch nobody has ever written down,
 * and the want went up under 'goods.electronics'. Nothing was refused —
 * the catalogue is a deny list and an unwritten leaf goes up — but the matcher
 * reads the category as a hard gate: equal, ancestor, descendant, or siblings
 * under a shared parent. There is no goods.gaming node for a sibling rule to
 * reach, so each side's candidate pool came out empty and stayed empty.
 *
 * What is asserted here:
 *   - a path the catalogue knows is left exactly as it was sent;
 *   - an invented leaf under a known parent lands on a node near it;
 *   - an invented branch lands under its top level rather than somewhere the
 *     lexical fallback merely shares trigrams with;
 *   - a family somebody closed is never where a posting is snapped TO;
 *   - the assistant's own path is kept on the row, and the answer says where
 *     the posting actually went;
 *   - an amend faces the same decision again.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The suggester, real by default. One test needs to see what happens when the
 * closest answer is a family somebody closed, and there is no such pair in
 * today's catalogue to provoke it with, so that test hands the answer over.
 */
let suggestions: any = null;
vi.mock('../../src/domain/categorySuggest.js', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    suggestCategories: async (...args: any[]) =>
      suggestions ?? actual.suggestCategories(...args),
  };
});

vi.mock('../../src/aws.js', () => ({ bedrock: { send: vi.fn() }, sqs: { send: vi.fn() } }));
vi.mock('../../src/crypto.js', () => ({ encryptField: async () => Buffer.from('x') }));
vi.mock('../../src/intake/pipe.js', () => ({ runIntake: async () => ({ outcome: 'allow' }) }));
vi.mock('../../src/domain/categoryMisses.js', () => ({ recordCategoryMiss: async () => {} }));
// The board and the day's count are somebody else's suite; here they are open.
vi.mock('../../src/domain/quotas.js', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    checkPublishQuota: async () => {},
    recordPublishWithinQuota: async () => {},
  };
});

import * as db from '../../src/db.js';
import { DOOR_MIN_SCORE, snapCategory } from '../../src/domain/categoryBackfill.js';
import { amendIntent, publishIntent } from '../../src/domain/cards.js';
import { categoryDenied, categoryStatus } from '../../src/denylist.js';
import { SCHEMA_VERSION } from '../../src/protocol.js';
import { lintHumanCopy } from '../../src/email/lint.js';
import type { Config } from '../../src/config.js';

const cfg = {
  quotas: { maxOpenCards: 20, maxPublishesPerDay: 20 },
  screeningQueueUrl: 'https://queue.test/screening',
} as unknown as Config;

const ACCOUNT = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const CARD = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

/** True where the taxonomy holds the node and nobody has closed it. */
const open = (c: string) => categoryStatus(c).status === 'open' && !categoryDenied(c);

// ---------------------------------------------------------------------------
// The decision itself
// ---------------------------------------------------------------------------
describe('where a posting is filed', () => {
  beforeEach(() => {
    suggestions = null;
  });

  const door = (category: string) =>
    snapCategory(cfg, category, undefined, { fallbackToAncestor: true });

  it('leaves a path the catalogue knows exactly where it was sent', async () => {
    for (const c of ['goods.bicycle.mountain', 'services.repairs.bicycle', 'social.language-exchange']) {
      const d = await door(c);
      expect(d, c).toMatchObject({ category: c, from: c, changed: false, how: 'as-posted' });
    }
  });

  it('moves an invented leaf onto the node beside it', async () => {
    const d = await door('goods.electronics.laptop.framework-13');
    expect(d.changed).toBe(true);
    expect(d.how).toBe('suggestion');
    expect(d.category).toBe('goods.electronics.laptop');
    expect(d.from).toBe('goods.electronics.laptop.framework-13');
  });

  it('files the run 9 branch under goods rather than under a stranger', async () => {
    // The whole defect in one line. There is no goods.gaming node, and the
    // lexical fallback's nearest answer is goods.clothing on shared trigrams
    // alone — which is worse for everybody than "this is a good".
    const d = await door('goods.gaming.sim-racing');
    expect(d.category).toBe('goods');
    expect(d.how).toBe('ancestor');
    expect(d.changed).toBe(true);
    expect(d.from).toBe('goods.gaming.sim-racing');
  });

  it('never leaves an invented path standing as the matching key', async () => {
    for (const c of [
      'goods.gaming.sim-racing',
      'goods.pushbike',
      'services.repairs.vintage-synthesiser',
      'social.bouldering-partner',
    ]) {
      const d = await door(c);
      expect(open(d.category), `${c} -> ${d.category}`).toBe(true);
      expect(d.category, c).not.toBe(c);
    }
  });

  it('walks past a family somebody closed and takes the next open answer', async () => {
    // social.dating is reserved. However close it scores, a posting may never
    // be snapped into it.
    suggestions = {
      categories: ['social.dating', 'social.activity-partner.climbing'],
      scored: [
        { category: 'social.dating', score: 0.99 },
        { category: 'social.activity-partner.climbing', score: 0.9 },
      ],
      source: 'lexical',
    };
    const d = await door('social.dating-ish-thing');
    expect(d.category).toBe('social.activity-partner.climbing');
  });

  it('falls all the way back to the top level when every answer is closed', async () => {
    suggestions = {
      categories: ['social.dating'],
      scored: [{ category: 'social.dating', score: 0.99 }],
      source: 'lexical',
    };
    const d = await door('social.dating.speed-nights');
    expect(d.category).toBe('social');
    expect(d.how).toBe('ancestor');
  });

  it('walks up past a reserved ancestor on the posting own line', async () => {
    // services.trades is reserved, so the walk cannot stop there.
    suggestions = { categories: [], scored: [], source: 'lexical' };
    const d = await door('services.trades.solar-battery-install');
    expect(d.category).toBe('services');
    expect(open(d.category)).toBe(true);
  });

  it('leaves the ops sweep answering the way it always has', async () => {
    // The sweep does NOT walk up the path: a posting already up with nothing
    // near it is left for an operator to look at.
    suggestions = { categories: [], scored: [], source: 'lexical' };
    const d = await snapCategory(cfg, 'goods.gaming.sim-racing');
    expect(d.how).toBe('unmatched');
    expect(d.changed).toBe(false);
    expect(d.category).toBe('goods.gaming.sim-racing');
  });

  it('sets the door floor above the sweep own', async () => {
    expect(DOOR_MIN_SCORE.lexical).toBeGreaterThan(0.2);
    expect(DOOR_MIN_SCORE.lexical).toBeLessThan(1);
  });
});

// ---------------------------------------------------------------------------
// The row, and what the assistant is told
// ---------------------------------------------------------------------------
interface World {
  /** Every statement, with the parameters it carried. */
  sql: { text: string; params: any[] }[];
  card: Record<string, any>;
}
let world: World;

/**
 * What the INSERT actually put in one named column.
 *
 * The statement names its columns and then SELECTs a placeholder for each, so
 * pairing the two lists resolves a column to the $n that fills it, and $n to
 * the parameter that was bound. Reading the parameter array by eye would pass
 * on a value that happened to appear somewhere else in it, which is exactly
 * the mistake these assertions exist to catch.
 */
const splitTop = (list: string): string[] => {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of list) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((c) => c.trim());
};

const stored = (column: string): unknown => {
  const insert = world.sql.find((s) => /INSERT INTO cards/.test(s.text))!;
  const cols = splitTop(/INTO cards \(([\s\S]*?)\)\s*SELECT/.exec(insert.text)![1]);
  const exprs = splitTop(/\)\s*SELECT ([\s\S]*?) WHERE /.exec(insert.text)![1]);
  const at = cols.indexOf(column);
  expect(at, `column ${column}`).toBeGreaterThan(-1);
  const n = Number(/^\$(\d+)/.exec(exprs[at])![1]);
  return insert.params[n - 1];
};

function fakePool() {
  return {
    query: async (sql: string, params: any[] = []) => {
      world.sql.push({ text: sql.replace(/\s+/g, ' ').trim(), params });
      if (/INSERT INTO cards/.test(sql)) return { rows: [{ id: CARD }], rowCount: 1 };
      if (/SELECT \* FROM cards WHERE id/.test(sql)) return { rows: [world.card], rowCount: 1 };
      if (/FROM accounts/.test(sql)) {
        return { rows: [{ id: ACCOUNT, data_key_enc: Buffer.from('k'), timezone: null }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  } as any;
}

const listing = (over: Record<string, unknown> = {}) => ({
  schema_version: SCHEMA_VERSION,
  type: 'offering',
  category: 'goods.gaming.sim-racing',
  kind: 'sim racing rig',
  // Enough to describe the thing to a stranger. The door asks for that before
  // it asks anything about shelves (domain/postingDetail.ts), and this suite
  // is about the shelves.
  attributes: { brand: 'fanatec', model: 'csl dd', condition: 'good' },
  geo: { bucket: 'r3gx', radius_km: 25, reach: 'country' },
  ttl_days: 60,
  ...over,
});

beforeEach(() => {
  suggestions = null;
  world = {
    sql: [],
    card: {
      id: CARD,
      account_id: ACCOUNT,
      schema_version: SCHEMA_VERSION,
      type: 'HAVE',
      category: 'goods.gaming.sim-racing',
      category_as_posted: 'goods.gaming.sim-racing',
      kind: 'sim racing rig',
      geo: { bucket: 'r3gx', radius_km: 25, reach: 'country' },
      attributes: {},
      ask: null,
      urgency: 'none',
      visibility: 'anonymous-until-match',
      protocol_status: 'active',
      lifecycle_state: 'PUBLISHED',
      price_enc: null,
      ttl_days: 60,
      expires_at: new Date('2026-11-01T00:00:00Z'),
      screening: null,
      slots: 1,
      sale: 'straight',
    },
  };
  vi.spyOn(db, 'getPool').mockReturnValue(fakePool());
});

describe('what the row carries and what the assistant hears', () => {
  it('writes the snapped node as the category and keeps the path that was sent', async () => {
    await publishIntent(cfg, ACCOUNT, listing());
    // The matching key is the switchboard's decision.
    expect(stored('category')).toBe('goods');
    // And the assistant's own path is on the row, untouched.
    expect(stored('category_as_posted')).toBe('goods.gaming.sim-racing');
  });

  it('says where the posting went, in a field and in a sentence', async () => {
    const r: any = await publishIntent(cfg, ACCOUNT, listing());
    expect(r.filed_under).toBe('goods');
    expect(r.filed_under_note.provenance).toBe('switchboard-system');
    expect(r.filed_under_note.text).toContain('Filed under');
    expect(lintHumanCopy(r.filed_under_note.text)).toEqual([]);
  });

  it('gives the shelf in words even when it is the one that was asked for', async () => {
    // An assistant handed only a dotted path reads the dotted path aloud, and
    // one did (first rehearsal-suite run, 19 September 2026).
    const r: any = await publishIntent(cfg, ACCOUNT, listing({ category: 'goods.bicycle.mountain' }));
    expect(r.filed_under).toBe('goods.bicycle.mountain');
    expect(r.filed_under_note.text).toMatch(/^Filed under /);
    expect(r.filed_under_note.text).not.toContain('goods.bicycle');
    expect(r.filed_under_note.text).not.toContain('nearest thing the catalogue knows');
  });

  it('leaves the poster own words for the thing exactly as they were sent', async () => {
    await publishIntent(cfg, ACCOUNT, listing());
    expect(stored('kind')).toBe('sim racing rig');
  });

  it('faces the decision again on an amend, and never overwrites the original path', async () => {
    const r: any = await amendIntent(cfg, ACCOUNT, CARD, { urgency: 'days' });
    expect(r.filed_under).toBe('goods');
    expect(r.filed_under_note.text).toContain('Filed under');
    const update = world.sql.find((s) => /UPDATE cards SET geo/.test(s.text))!;
    expect(update.text).toContain('category_as_posted = COALESCE(category_as_posted,');
    expect(update.params).toContain('goods');
    expect(update.params).toContain('goods.gaming.sim-racing');
  });

  // Manual 52. Screening takes seconds and the first person often comes
  // forward straight away, so an agent that can wake itself is told to look
  // again a few minutes after it posts or amends. One follow-up on this
  // posting, so the cadence floor has nothing to say about it.
  it('says what happens next, and who does the telling', async () => {
    for (const r of [
      (await publishIntent(cfg, ACCOUNT, listing())) as any,
      (await amendIntent(cfg, ACCOUNT, CARD, { urgency: 'days' })) as any,
    ]) {
      expect(r.what_happens_next_note.provenance).toBe('switchboard-system');
      // Who tells the human, and the one condition under which the agent may
      // say it will be the one doing it. In the 19 September rehearsal an
      // assistant said it would, with nothing scheduled and nothing saved.
      expect(r.what_happens_next_note.text).toContain('the switchboard will email them');
      expect(r.what_happens_next_note.text).toContain(
        'Only say you will tell them yourself if you have scheduled a check and saved the arrangement',
      );
      expect(r.what_happens_next_note.text).toContain('look again in a few minutes');
      expect(r.what_happens_next_note.text).toContain('nothing to do with your checking cadence');
      expect(lintHumanCopy(r.what_happens_next_note.text)).toEqual([]);
    }
  });

  it('changes nothing on an amend of a posting already on a known shelf', async () => {
    world.card.category = 'goods.bicycle.mountain';
    world.card.category_as_posted = 'goods.bicycle.mountain';
    const r: any = await amendIntent(cfg, ACCOUNT, CARD, { urgency: 'days' });
    expect(r.filed_under).toBe('goods.bicycle.mountain');
    expect(r.filed_under_note.text).not.toContain('nearest thing the catalogue knows');
  });
});
