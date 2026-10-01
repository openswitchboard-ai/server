/**
 * THE ONE QUESTION EVERY NEW ACCOUNT IS ASKED (founder, 1 October 2026).
 *
 * After an account's first posting, the answer hands the assistant one
 * question to put to its human: "Anything you'd lend, give away or sell while
 * we're here?" Once per account, ever (domain/cards.ts supplyAskFor,
 * migration 065).
 *
 * What is asserted here:
 *   - it rides the answer to the account's first posting, want or have;
 *   - it is never handed over twice, in sequence or at once;
 *   - for a few minutes after, it is carried on the account's posting
 *     answers (publish, amend, refine), worded so it is not asked twice;
 *   - it is never handed over on a refusal, which is not up yet;
 *   - an account the migration marked, or one that was already posting, is
 *     never asked;
 *   - the wording comes from the lanes table, in the agent's own lane;
 *   - the manual carries the general rule about handed questions.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/aws.js', () => ({ bedrock: { send: vi.fn() }, sqs: { send: vi.fn() } }));
vi.mock('../../src/crypto.js', () => ({ encryptField: async () => Buffer.from('x') }));
vi.mock('../../src/intake/pipe.js', () => ({ runIntake: async () => ({ outcome: 'allow' }) }));
vi.mock('../../src/domain/categoryMisses.js', () => ({ recordCategoryMiss: async () => {} }));
vi.mock('../../src/domain/quotas.js', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    checkPublishQuota: async () => {},
    recordPublishWithinQuota: async () => {},
  };
});

import { readFileSync } from 'node:fs';

import * as db from '../../src/db.js';
import { publishIntent, supplyAskCarried, SUPPLY_ASK_CARRY_MINUTES } from '../../src/domain/cards.js';
import { ASKS, SUPPLY_QUESTION, sayAsk } from '../../src/domain/lanes.js';
import { MANUAL, MANUAL_CHANGELOG } from '../../src/mcp/instructions.js';
import { manualSection } from '../../src/mcp/instructions.js';
import { OsbError, SCHEMA_VERSION } from '../../src/protocol.js';
import { lintEmailCopy, lintHumanCopy } from '../../src/email/lint.js';
import type { Config } from '../../src/config.js';

const cfg = {
  quotas: { maxOpenCards: 20, maxPublishesPerDay: 20 },
  screeningQueueUrl: 'https://queue.test/screening',
} as unknown as Config;

const ACCOUNT = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';

/**
 * The account row and its postings, held the way Postgres would hold them for
 * the one statement that matters: the UPDATE that hands the question over.
 * The fake does its check-and-set inside one synchronous step, which is what
 * a single UPDATE ... WHERE supply_ask_at IS NULL is to Postgres.
 */
interface World {
  sql: { text: string; params: any[] }[];
  supplyAskAt: Date | null;
  /** Every posting on the account, in the order the rows were written. */
  cards: string[];
  /** When the account's earliest posting went up; null for none, or long ago. */
  firstPostedAt: Date | null;
  arrangement: Record<string, unknown> | null;
  /**
   * Whether the earliest-posting test sees postings written by a request
   * still in flight. Off, every posting looks like the first, so only the
   * null check stands between two racing requests and the question twice.
   */
  seeOthers: boolean;
  nextId: number;
}
let world: World;

const handOverSql = (sql: string) => /UPDATE accounts SET supply_ask_at/.test(sql);

function fakePool() {
  return {
    query: async (sql: string, params: any[] = []) => {
      world.sql.push({ text: sql.replace(/\s+/g, ' ').trim(), params });
      if (/INSERT INTO cards/.test(sql)) {
        const id = `cccccccc-0000-4000-8000-${String(world.nextId++).padStart(12, '0')}`;
        world.cards.push(id);
        world.firstPostedAt ??= world.cards.length === 1 ? new Date() : null;
        return { rows: [{ id }], rowCount: 1 };
      }
      if (handOverSql(sql)) {
        const [accountId, cardId] = params;
        const earliest = world.seeOthers ? world.cards[0] === cardId : true;
        if (accountId === ACCOUNT && world.supplyAskAt === null && earliest) {
          world.supplyAskAt = new Date();
          return { rows: [{ id: ACCOUNT }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
      if (/SELECT true AS carry/.test(sql)) {
        const [accountId, minutes] = params;
        const since = Date.now() - minutes * 60_000;
        const carry =
          accountId === ACCOUNT &&
          world.supplyAskAt !== null &&
          world.supplyAskAt.getTime() > since &&
          world.firstPostedAt !== null &&
          world.firstPostedAt.getTime() > since;
        return { rows: carry ? [{ carry: true }] : [], rowCount: carry ? 1 : 0 };
      }
      if (/SELECT arrangement FROM accounts/.test(sql)) {
        return { rows: [{ arrangement: world.arrangement }], rowCount: 1 };
      }
      if (/SELECT hears_via FROM accounts/.test(sql)) {
        return { rows: [{ hears_via: 'email' }], rowCount: 1 };
      }
      if (/FROM accounts/.test(sql)) {
        return {
          rows: [{ id: ACCOUNT, data_key_enc: Buffer.from('k'), timezone: null }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    },
  } as any;
}

const rich = { brand: 'trek', frame_size: 'medium', condition: 'good' };

const listing = (over: Record<string, unknown> = {}) => ({
  schema_version: SCHEMA_VERSION,
  type: 'offering',
  category: 'goods.bicycle.mountain',
  kind: 'mountain bike',
  attributes: rich,
  geo: { bucket: 'r3gx', radius_km: 25, reach: 'country' },
  ttl_days: 60,
  ...over,
});

beforeEach(() => {
  world = {
    sql: [],
    supplyAskAt: null,
    cards: [],
    firstPostedAt: null,
    arrangement: null,
    seeOthers: true,
    nextId: 1,
  };
  vi.spyOn(db, 'getPool').mockReturnValue(fakePool());
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

/** The hand-over and the first posting, moved back past the carry window. */
const minutesPass = () => {
  const then = new Date(Date.now() - (SUPPLY_ASK_CARRY_MINUTES + 1) * 60_000);
  if (world.supplyAskAt) world.supplyAskAt = then;
  if (world.firstPostedAt) world.firstPostedAt = then;
};
const handed = (r: any) => r.supply_ask_note?.text === sayAsk('supply_ask', 'prompted', {});
const carried = (r: any) => r.supply_ask_note?.text === sayAsk('supply_ask_carried', 'prompted', {});

const refusal = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
    return undefined;
  } catch (e) {
    if (e instanceof OsbError) return e.payload;
    throw e;
  }
};

// ---------------------------------------------------------------------------
describe('the first posting carries the question', () => {
  it('rides the answer to a first have, in the prompted lane', async () => {
    const r: any = await publishIntent(cfg, ACCOUNT, listing());
    expect(r.state).toBe('PENDING_SCREENING');
    expect(r.supply_ask_note).toEqual({
      text: sayAsk('supply_ask', 'prompted', {}),
      provenance: 'switchboard-system',
    });
    expect(r.supply_ask_note.text).toContain(SUPPLY_QUESTION);
    expect(world.supplyAskAt).not.toBeNull();
  });

  it('rides the answer to a first want just the same', async () => {
    const r: any = await publishIntent(cfg, ACCOUNT, listing({ type: 'looking_for' }));
    expect(r.supply_ask_note?.text).toContain(SUPPLY_QUESTION);
  });

  it('is said in the lane the agent is in', async () => {
    world.arrangement = { runs_on_its_own: true, check_every_minutes: 60 };
    const r: any = await publishIntent(cfg, ACCOUNT, listing());
    expect(r.supply_ask_note.text).toBe(
      sayAsk('supply_ask', 'autonomous', { runs_on_its_own: true, check_every_minutes: 60 }),
    );
    expect(r.supply_ask_note.text).toMatch(/next time they are with you/);
  });

  it('adds the one field and leaves every other field on the answer as it was', async () => {
    const first: any = await publishIntent(cfg, ACCOUNT, listing());
    minutesPass();
    const second: any = await publishIntent(cfg, ACCOUNT, listing());
    expect(Object.keys(first).filter((k) => k !== 'supply_ask_note').sort()).toEqual(
      Object.keys(second).sort(),
    );
    expect(Object.keys(second)).toContain('what_happens_next_note');
    expect(Object.keys(second)).toContain('filed_under_note');
    expect(Object.keys(second)).not.toContain('supply_ask_note');
  });

  it('hands it over in one statement that sets the mark only where it is unset', async () => {
    const r: any = await publishIntent(cfg, ACCOUNT, listing());
    const update = world.sql.filter((s) => handOverSql(s.text));
    expect(update).toHaveLength(1);
    expect(update[0].text).toContain('supply_ask_at IS NULL');
    expect(update[0].text).toContain('RETURNING');
    // And only on the account's earliest posting.
    expect(update[0].text).toContain('(earlier.created_at, earlier.id) < (posted.created_at, posted.id)');
    expect(update[0].params).toEqual([ACCOUNT, r.intent_id]);
  });
});

// ---------------------------------------------------------------------------
describe('never twice', () => {
  it('is absent from a second posting once the carry window has passed', async () => {
    const first: any = await publishIntent(cfg, ACCOUNT, listing());
    minutesPass();
    const second: any = await publishIntent(cfg, ACCOUNT, listing({ kind: 'road bike' }));
    expect(handed(first)).toBe(true);
    expect(second.supply_ask_note).toBeUndefined();
  });

  it('lands on exactly one of two first postings sent at once', async () => {
    const both: any[] = await Promise.all([
      publishIntent(cfg, ACCOUNT, listing()),
      publishIntent(cfg, ACCOUNT, listing({ type: 'looking_for', kind: 'road bike' })),
    ]);
    expect(both.filter(handed)).toHaveLength(1);
    // The other one is still inside the window, so it carries the
    // already-asked wording and never the first.
    expect(both.filter(carried)).toHaveLength(1);
  });

  it('lands on exactly one even where each request sees only its own posting', async () => {
    // The earliest-posting rule cannot tell the two apart here, so this is the
    // null check alone: one UPDATE changes the row, and the other finds it set.
    world.seeOthers = false;
    const all: any[] = await Promise.all(
      [1, 2, 3, 4].map((n) => publishIntent(cfg, ACCOUNT, listing({ kind: `bike ${n}` }))),
    );
    expect(all.filter(handed)).toHaveLength(1);
    expect(all.filter(carried)).toHaveLength(3);
  });

  it('is absent where the question has already been handed over, or the migration marked it', async () => {
    world.supplyAskAt = new Date('2026-09-30T00:00:00Z');
    const r: any = await publishIntent(cfg, ACCOUNT, listing());
    expect(r.supply_ask_note).toBeUndefined();
  });

  it('is absent for an account that was already posting before it existed', async () => {
    // Never marked, but this is not its first posting.
    world.cards.push('cccccccc-0000-4000-8000-ffffffffffff');
    const r: any = await publishIntent(cfg, ACCOUNT, listing());
    expect(r.supply_ask_note).toBeUndefined();
    expect(world.supplyAskAt).toBeNull();
  });

  it('costs the posting nothing where the statement fails', async () => {
    const pool = fakePool();
    const inner = pool.query;
    pool.query = async (sql: string, params: any[]) => {
      if (handOverSql(sql)) throw new Error('the database is not there');
      return inner(sql, params);
    };
    vi.spyOn(db, 'getPool').mockReturnValue(pool);
    const r: any = await publishIntent(cfg, ACCOUNT, listing());
    expect(r.state).toBe('PENDING_SCREENING');
    expect(r.supply_ask_note).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
describe('carried for a few minutes after (rehearsal, 1 October 2026)', () => {
  it('rides a second posting straight after, worded so it is not asked twice', async () => {
    const first: any = await publishIntent(cfg, ACCOUNT, listing());
    const second: any = await publishIntent(cfg, ACCOUNT, listing({ kind: 'road bike' }));
    expect(handed(first)).toBe(true);
    expect(carried(second)).toBe(true);
    expect(second.supply_ask_note.text).toContain(SUPPLY_QUESTION);
    expect(second.supply_ask_note.text).toMatch(/^If you have not asked your human this yet/);
    expect(second.supply_ask_note.text).toContain('If you already did, leave it.');
  });

  it('is what refine and amend reach for, in the agent\'s own lane', async () => {
    world.arrangement = { runs_on_its_own: true, check_every_minutes: 60 };
    await publishIntent(cfg, ACCOUNT, listing());
    const r = await supplyAskCarried(ACCOUNT, world.arrangement);
    expect(r.supply_ask_note?.text).toBe(
      sayAsk('supply_ask_carried', 'autonomous', { runs_on_its_own: true, check_every_minutes: 60 }),
    );
  });

  it('stops once the window has passed', async () => {
    await publishIntent(cfg, ACCOUNT, listing());
    minutesPass();
    expect(await supplyAskCarried(ACCOUNT, {})).toEqual({});
  });

  it('never reaches an account the migration marked, whose postings are old', async () => {
    // Marked at deploy time, so inside the window, but its first posting is not.
    world.supplyAskAt = new Date();
    world.cards.push('cccccccc-0000-4000-8000-ffffffffffff');
    world.firstPostedAt = new Date('2026-09-01T00:00:00Z');
    expect(await supplyAskCarried(ACCOUNT, {})).toEqual({});
    const r: any = await publishIntent(cfg, ACCOUNT, listing());
    expect(r.supply_ask_note).toBeUndefined();
  });

  it('never reaches an account that was not handed the question', async () => {
    expect(await supplyAskCarried(ACCOUNT, {})).toEqual({});
  });

  it('asks the window and the first posting of Postgres in one read', async () => {
    await supplyAskCarried(ACCOUNT, {});
    const read = world.sql.find((q) => /SELECT true AS carry/.test(q.text))!;
    expect(read.text).toContain('supply_ask_at > now() - make_interval(mins => $2)');
    expect(read.text).toContain('(SELECT min(created_at) FROM cards WHERE account_id = $1) > now() - make_interval(mins => $2)');
    expect(read.params).toEqual([ACCOUNT, SUPPLY_ASK_CARRY_MINUTES]);
  });

  it('costs the answer nothing where the read fails', async () => {
    const pool = fakePool();
    pool.query = async () => {
      throw new Error('the database is not there');
    };
    vi.spyOn(db, 'getPool').mockReturnValue(pool);
    expect(await supplyAskCarried(ACCOUNT, {})).toEqual({});
  });
});

// ---------------------------------------------------------------------------
describe('never on a refusal', () => {
  it('is not handed over when a thin posting comes back with questions', async () => {
    const p = await refusal(() =>
      publishIntent(cfg, ACCOUNT, listing({ kind: 'thing', attributes: {} })),
    );
    expect(p?.code).toBe('NEEDS_DETAIL');
    expect(world.sql.some((s) => handOverSql(s.text))).toBe(false);
    expect(world.supplyAskAt).toBeNull();
  });

  it('is not handed over when a figure comes back to be read out', async () => {
    const p = await refusal(() =>
      publishIntent(cfg, ACCOUNT, listing({ price: { band: { min: 10 }, ccy: 'AUD' } })),
    );
    expect(p?.code).toBe('CONFIRM_FIGURE');
    expect(world.sql.some((s) => handOverSql(s.text))).toBe(false);
    expect(world.supplyAskAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe('the wording', () => {
  const wordings = () => [
    sayAsk('supply_ask', 'prompted', {}),
    sayAsk('supply_ask', 'autonomous', { runs_on_its_own: true }),
    sayAsk('supply_ask', 'autonomous', { runs_on_its_own: true, check_every_minutes: 60 }),
  ];

  it('asks the question word for word, once, and lets a no stand', () => {
    expect(SUPPLY_QUESTION).toBe("Anything you'd lend, give away or sell while we're here?");
    for (const text of wordings()) {
      expect(text).toContain(`"${SUPPLY_QUESTION}"`);
      expect(text).toMatch(/\bonce\b/);
      expect(text).toContain('If they say no, drop it.');
      expect(text).toMatch(/post it as a have the usual way/);
      expect(text).toMatch(/^Once you have told your human what happens next/);
    }
  });

  const carriedWordings = () => [
    sayAsk('supply_ask_carried', 'prompted', {}),
    sayAsk('supply_ask_carried', 'autonomous', { runs_on_its_own: true }),
    sayAsk('supply_ask_carried', 'autonomous', { runs_on_its_own: true, check_every_minutes: 60 }),
  ];

  it('carries the same question, and lets one already asked stand', () => {
    for (const text of carriedWordings()) {
      expect(text).toContain(`"${SUPPLY_QUESTION}"`);
      expect(text).toMatch(/\bonce\b/);
      expect(text).toContain('If you already did, leave it.');
      expect(text).toContain('If they say no, drop it.');
      expect(lintHumanCopy(text)).toEqual([]);
      expect(text.length).toBeLessThanOrEqual(ASKS.supply_ask_carried.budget);
    }
  });

  it('is in the house register and inside its budget', () => {
    for (const text of wordings()) {
      expect(lintHumanCopy(text)).toEqual([]);
      expect(text.length).toBeLessThanOrEqual(ASKS.supply_ask.budget);
      expect(text).not.toMatch(/\blisting\b|\bcard\b|\bmatch(es|ed|ing)?\b/i);
    }
  });

  it('reads the same whatever the rhythm, and whatever the human hears by', () => {
    const [, notYet, agreed] = wordings();
    expect(notYet).toBe(agreed);
    expect(sayAsk('supply_ask', 'prompted', {}, { hearsVia: 'assistant' })).toBe(
      sayAsk('supply_ask', 'prompted', {}, { hearsVia: 'email' }),
    );
  });
});

// ---------------------------------------------------------------------------
describe('the manual', () => {
  it('is at version 82, and that entry says the general rule', () => {
    expect(MANUAL.version).toBe(82);
    const note = MANUAL_CHANGELOG.find((c) => c.version === 82)!.note;
    expect(note).toMatch(/ask it once, with its meaning unchanged, and take no for an answer/);
    expect(lintEmailCopy(note)).toEqual([]);
  });

  it('carries the rule in the body as a rule about handed questions, with no subject in it', () => {
    const text = manualSection('talking_to_your_human')!.text;
    expect(text).toContain(
      'When the switchboard hands you a question to put to your human, ask it once, with its meaning unchanged, and take no for an answer.',
    );
    // General, by the house rule: nothing about lending, giving or selling.
    const line = text.split('. ').find((s) => s.includes('hands you a question'))!;
    expect(line).not.toMatch(/lend|give away|sell|supply/i);
  });

  it('and the public copy is rendered from it', () => {
    const rendered = readFileSync('docs/manual.md', 'utf8');
    expect(rendered).toContain(`version ${MANUAL.version}`);
    expect(rendered).toContain('hands you a question to put to your human');
  });
});
