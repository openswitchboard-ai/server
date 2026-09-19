/**
 * A THIN POSTING COMES BACK WITH THE QUESTIONS.
 *
 * The rehearsal (19 September 2026). A human had an upgraded Fanatec pedal
 * spring going spare. Their assistant posted "upgraded Fanatec pedal spring"
 * with no attributes whatever — it never asked which pedal set, what condition,
 * or what was in the box — and left. Nobody reading that posting could have
 * told whether it was the thing they were after. The founder's words: "we need
 * the user's AI to ask questions until it understands everything fully,
 * something it is failing to do at present."
 *
 * The switchboard already refuses a place name several towns answer to, with a
 * question for the human (LOCATION_AMBIGUOUS). This suite holds the same
 * pattern over the thing itself:
 *
 *   - something offered under goods needs its own words, two identifying facts
 *     and a condition, or it comes back with the questions to ask;
 *   - something wanted is held lighter, because they are asking rather than
 *     telling;
 *   - an errand or something social is lighter still;
 *   - anything already rich goes straight up, untouched;
 *   - an amend is never refused for this, because an amend only ever adds;
 *   - and nobody is trapped: detail_unknown on a second attempt takes the
 *     posting as it stands.
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

import * as db from '../../src/db.js';
import { amendIntent, publishIntent } from '../../src/domain/cards.js';
import {
  DETAIL_UNKNOWN_WINDOW_MINUTES,
  MAX_QUESTIONS,
  detailKey,
  detailShortfall,
} from '../../src/domain/postingDetail.js';
import { OsbError, SCHEMA_VERSION } from '../../src/protocol.js';
import { lintHumanCopy } from '../../src/email/lint.js';
import type { Config } from '../../src/config.js';

const cfg = {
  quotas: { maxOpenCards: 20, maxPublishesPerDay: 20 },
  screeningQueueUrl: 'https://queue.test/screening',
} as unknown as Config;

const ACCOUNT = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const CARD = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

// ---------------------------------------------------------------------------
// The rule itself, read one posting at a time. No database, no suggester.
// ---------------------------------------------------------------------------
describe('what counts as enough to describe the thing to a stranger', () => {
  it('turns the rehearsal posting back, with questions and nothing invented', () => {
    const short = detailShortfall({
      category: 'goods.sim-racing.pedal-parts',
      type: 'offering',
      kind: 'upgraded Fanatec pedal spring',
      attributes: {},
    })!;
    expect(short).toBeDefined();
    expect(short.questions.length).toBeGreaterThan(0);
    expect(short.questions.length).toBeLessThanOrEqual(MAX_QUESTIONS);
    // The questions the assistant should have asked, and never a guess at the
    // thing past the poster's own words.
    const all = short.questions.join(' ');
    expect(all).toContain('make and model');
    expect(all).toContain('condition');
    expect(all).toContain('the upgraded Fanatec pedal spring');
    expect(all).not.toMatch(/pedal set|Logitech|Thrustmaster|load cell/i);
    for (const q of short.questions) {
      expect(q.endsWith('?'), q).toBe(true);
      expect(lintHumanCopy(q), q).toEqual([]);
    }
  });

  it('asks what the thing is where the posting never said', () => {
    const short = detailShortfall({
      category: 'goods.electronics.laptop',
      type: 'offering',
      attributes: {},
    })!;
    expect(short.questions[0]).toBe('What is it, in a few plain words?');
    // With no words of their own to echo, the questions say "it" rather than
    // inventing a noun for the thing.
    expect(short.questions.join(' ')).not.toMatch(/the undefined|the null/);
  });

  it('lets something offered through on its own words, two facts and a condition', () => {
    expect(
      detailShortfall({
        category: 'goods.bicycle.mountain',
        type: 'offering',
        kind: 'mountain bike',
        attributes: { brand: 'trek', frame_size: 'medium', condition: 'good' },
      }),
    ).toBeUndefined();
  });

  it('counts the condition separately, so "good" alone is never the two facts', () => {
    const short = detailShortfall({
      category: 'goods.bicycle.mountain',
      type: 'offering',
      kind: 'mountain bike',
      attributes: { condition: 'good' },
    });
    expect(short).toBeDefined();
    expect(short!.questions.join(' ')).not.toContain('condition');
  });

  it('asks for the condition of something offered that never said', () => {
    const short = detailShortfall({
      category: 'goods.bicycle.mountain',
      type: 'offering',
      kind: 'mountain bike',
      attributes: { brand: 'trek', frame_size: 'medium' },
    })!;
    expect(short.questions).toEqual(['What condition is the mountain bike in?']);
  });

  it('holds a want lighter, because they are asking rather than telling', () => {
    // One identifying fact and no condition: somebody hunting for a thing may
    // not know its condition, which is rather the point of asking.
    expect(
      detailShortfall({
        category: 'goods.bicycle.mountain',
        type: 'looking_for',
        kind: 'mountain bike',
        attributes: { frame_size: 'medium' },
      }),
    ).toBeUndefined();
    // And still refuses a want that says nothing at all.
    expect(
      detailShortfall({
        category: 'goods.bicycle.mountain',
        type: 'looking_for',
        kind: 'mountain bike',
        attributes: {},
      }),
    ).toBeDefined();
  });

  it('holds an errand and something social to their own words plus one fact', () => {
    for (const category of ['services.tutoring.maths', 'social.language-exchange']) {
      expect(
        detailShortfall({
          category,
          type: 'looking_for',
          kind: 'italian practice',
          attributes: { format: 'online' },
        }),
        category,
      ).toBeUndefined();
      const short = detailShortfall({
        category,
        type: 'looking_for',
        kind: 'italian practice',
        attributes: {},
      })!;
      expect(short.questions, category).toEqual([
        'Is this in person or online?',
        'How often, and when would suit?',
      ]);
    }
  });

  it('leaves a top level it has no rule for exactly as it was sent', () => {
    expect(detailShortfall({ category: 'intg-island.thing', type: 'offering' })).toBeUndefined();
  });

  it('reads a fact the way the embedding does: scalars, and nothing empty', () => {
    const emptyish = detailShortfall({
      category: 'goods.bicycle.mountain',
      type: 'looking_for',
      kind: 'mountain bike',
      attributes: { brand: '   ', model: null, colour: { hex: '#000' } },
    });
    expect(emptyish).toBeDefined();
    // A number and a boolean are facts, stated.
    expect(
      detailShortfall({
        category: 'goods.bicycle.mountain',
        type: 'looking_for',
        kind: 'mountain bike',
        attributes: { year: 2019 },
      }),
    ).toBeUndefined();
  });

  it('keys the escape hatch on the thing, in any spelling of it', () => {
    expect(detailKey('  Upgraded   FANATEC pedal spring ')).toBe('upgraded fanatec pedal spring');
    expect(DETAIL_UNKNOWN_WINDOW_MINUTES).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// The door, and what the assistant is handed
// ---------------------------------------------------------------------------
interface World {
  sql: { text: string; params: any[] }[];
  /** How long ago this account was asked about this thing, in minutes. */
  askedMinutesAgo: number | null;
  card: Record<string, any>;
}
let world: World;

function fakePool() {
  return {
    query: async (sql: string, params: any[] = []) => {
      world.sql.push({ text: sql.replace(/\s+/g, ' ').trim(), params });
      if (/INSERT INTO cards/.test(sql)) return { rows: [{ id: CARD }], rowCount: 1 };
      if (/FROM posting_detail_asks/.test(sql)) {
        const ago = world.askedMinutesAgo;
        const inside = ago !== null && ago < DETAIL_UNKNOWN_WINDOW_MINUTES;
        return { rows: inside ? [{ '?column?': 1 }] : [], rowCount: inside ? 1 : 0 };
      }
      if (/INSERT INTO posting_detail_asks/.test(sql)) {
        world.askedMinutesAgo = 0;
        return { rows: [], rowCount: 1 };
      }
      if (/SELECT \* FROM cards WHERE id/.test(sql)) return { rows: [world.card], rowCount: 1 };
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

const listing = (over: Record<string, unknown> = {}) => ({
  schema_version: SCHEMA_VERSION,
  type: 'offering',
  category: 'goods.bicycle.mountain',
  kind: 'mountain bike',
  geo: { bucket: 'r3gx', radius_km: 25, reach: 'country' },
  ttl_days: 60,
  ...over,
});

const rich = { brand: 'trek', frame_size: 'medium', condition: 'good' };

beforeEach(() => {
  world = {
    sql: [],
    askedMinutesAgo: null,
    card: {
      id: CARD,
      account_id: ACCOUNT,
      schema_version: SCHEMA_VERSION,
      type: 'HAVE',
      category: 'goods.bicycle.mountain',
      category_as_posted: 'goods.bicycle.mountain',
      kind: 'mountain bike',
      geo: { bucket: 'r3gx', radius_km: 25, reach: 'country' },
      // Deliberately as thin as the rehearsal's: an amend must not be refused
      // for what the posting already was.
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

const refusal = async (card: any, opts?: { detailUnknown?: boolean }) => {
  try {
    await publishIntent(cfg, ACCOUNT, card, opts ?? {});
    return undefined;
  } catch (e) {
    if (e instanceof OsbError) return e.payload;
    throw e;
  }
};

describe('the refusal an assistant is handed', () => {
  it('comes back as a protocol answer, unposted, with the questions on it', async () => {
    const p = (await refusal(listing({ attributes: {} })))!;
    expect(p.code).toBe('NEEDS_DETAIL');
    expect(p.questions!.length).toBeGreaterThan(0);
    expect(p.human_action).toContain('Ask your human these');
    expect(p.human_action).toContain('detail_unknown');
    expect(lintHumanCopy(p.human_action!)).toEqual([]);
    expect(p.docs_url).toContain('NEEDS_DETAIL');
    // Nothing was written and nothing was queued.
    expect(world.sql.some((s) => /INSERT INTO cards/.test(s.text))).toBe(false);
  });

  it('writes down that it asked, so the second attempt has something to see', async () => {
    await refusal(listing({ attributes: {} }));
    const asked = world.sql.find((s) => /INSERT INTO posting_detail_asks/.test(s.text))!;
    expect(asked).toBeDefined();
    // The account and the thing's own words, and nothing else about the posting.
    expect(asked.params).toEqual([ACCOUNT, 'mountain bike']);
  });

  it('lets a rich posting straight through, untouched', async () => {
    const r: any = await publishIntent(cfg, ACCOUNT, listing({ attributes: rich }));
    expect(r.intent_id).toBe(CARD);
    expect(world.sql.some((s) => /INSERT INTO posting_detail_asks/.test(s.text))).toBe(false);
  });

  it('refuses detail_unknown on a first attempt, because nobody has been asked yet', async () => {
    const p = await refusal(listing({ attributes: {} }), { detailUnknown: true });
    expect(p?.code).toBe('NEEDS_DETAIL');
  });

  it('takes the posting as it stands on a second attempt inside the window', async () => {
    expect((await refusal(listing({ attributes: {} })))?.code).toBe('NEEDS_DETAIL');
    const r: any = await publishIntent(cfg, ACCOUNT, listing({ attributes: {} }), {
      detailUnknown: true,
    });
    expect(r.intent_id).toBe(CARD);
  });

  it('asks again once the window has gone by', async () => {
    world.askedMinutesAgo = DETAIL_UNKNOWN_WINDOW_MINUTES + 1;
    const p = await refusal(listing({ attributes: {} }), { detailUnknown: true });
    expect(p?.code).toBe('NEEDS_DETAIL');
  });

  it('never refuses an amend, because an amend only ever adds', async () => {
    // The stored posting is as thin as anything this suite turns away, and
    // amending it widens the area rather than changing what it is.
    const r: any = await amendIntent(cfg, ACCOUNT, CARD, { urgency: 'days' });
    expect(r.intent_id).toBe(CARD);
    expect(r.state).toBe('PENDING_SCREENING');
  });
});

// ---------------------------------------------------------------------------
// How far it reaches is the human's answer, never a default.
// ---------------------------------------------------------------------------
describe('a thing on offer with no reach stated', () => {
  it('is what the posting door checks for, in the source', async () => {
    // The third rehearsal-suite run (19 September 2026): a parcel-sized spring
    // went up within 8 km because the assistant never asked whether its human
    // would post it, and a missing `reach` fell silently to a radius.
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../../src/domain/cards.ts', import.meta.url), 'utf8');
    expect(src).toContain('if (isGoods && !card.geo?.reach)');
    // A later run: the buyer's assistant did the same thing, and a want within
    // 8 km kept two postings that read 0.86 alike from ever meeting.
    expect(src).toContain('Are you happy to have it posted to you, or would you only collect it?');
    expect(src).toContain('Would you post it to someone, or is it pick-up only?');
    // And a radius somebody CHOSE is confirmed once, then taken as it stands.
    expect(src).toContain("card.geo?.reach === 'radius'");
    expect(src).toContain('Would you post it to someone further away, or is it pick-up only?');
  });
});
