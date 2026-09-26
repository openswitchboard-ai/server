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
  CONDITION_KEY,
  DETAIL_AND_RADIUS_HUMAN_ACTION,
  DETAIL_HUMAN_ACTION,
  DETAIL_CONTEXT_HUMAN_ACTION,
  CONTEXT_KEYS,
  DETAIL_UNKNOWN_UNMATCHED,
  IDENTIFYING_KEYS,
  MAX_QUESTIONS,
  detailShortfall,
} from '../../src/domain/postingDetail.js';
import { OsbError, SCHEMA_VERSION } from '../../src/protocol.js';
import { lintHumanCopy } from '../../src/email/lint.js';
import type { Config } from '../../src/config.js';
import { refsFake, type RefsFake } from './postingRefsFake.js';

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

  /**
   * THE ITEM THE GATE WAS BUILT FOR, TOLD PROPERLY.
   *
   * The same Fanatec spring, with everything a seller who has no part number
   * can honestly say about it: who made it, what it goes on, and what state it
   * is in. That is a posting a stranger can recognise, and it must go straight
   * up. The 20 September rehearsals show assistants going round five times on
   * exactly this item, which is why it is written down as a passing case as
   * well as a refused one.
   */
  it('lets the Fanatec spring through on facts a seller with no part number has', () => {
    expect(
      detailShortfall({
        category: 'goods.sim-racing.pedal-parts',
        type: 'offering',
        kind: 'Fanatec ClubSport V3 brake performance spring',
        attributes: {
          brand: 'Fanatec',
          fits: 'Fanatec ClubSport V3 pedals',
          condition: 'used about a year, good, nothing bent or broken',
        },
      }),
    ).toBeUndefined();
    // And the same again with `type` standing in for `fits`, because the
    // refusal offers both and the count must honour both.
    expect(
      detailShortfall({
        category: 'goods.sim-racing.pedal-parts',
        type: 'offering',
        kind: 'brake performance spring',
        attributes: { brand: 'Fanatec', type: 'stiffer upgrade spring', condition: 'good' },
      }),
    ).toBeUndefined();
  });

  /**
   * WHAT THE ASSISTANT IS TOLD TO DO ABOUT IT.
   *
   * Three transcripts on 20 September (realism-reports/rehearsal) show the same
   * misreading: told only to post again "with their answers in attributes", the
   * seller's assistant went back to its human asking for a part number, a
   * spring rate or a colour code for a second-hand pedal spring, when the facts
   * that would have counted were already in the conversation. So the line names
   * the keys. Every key it names has to be one the rule counts: a refusal that
   * asks for a field the count ignores is the loop itself.
   */
  it('names, in the refusal, keys the rule actually counts', () => {
    expect(DETAIL_HUMAN_ACTION.length).toBeLessThanOrEqual(300);
    expect(lintHumanCopy(DETAIL_HUMAN_ACTION)).toEqual([]);
    // The escape hatch is still named at the point of refusal.
    expect(DETAIL_HUMAN_ACTION).toContain('detail_unknown');
    // And the part number that sent three assistants back to their humans for
    // something no seller has is ruled out in as many words.
    expect(DETAIL_HUMAN_ACTION).toContain('part number');

    // The keys it lists, read off the sentence itself: the comma list between
    // "`attributes`:" and the full stop that ends it.
    const listed = DETAIL_HUMAN_ACTION.split('`attributes`:')[1]
      .split('.')[0]
      .split(',')
      .map((w) => w.trim());
    expect(listed.length).toBeGreaterThanOrEqual(5);
    const counted = new Set<string>([...IDENTIFYING_KEYS, CONDITION_KEY]);
    for (const key of listed) expect(counted.has(key), key).toBe(true);
    // The two that decide a goods posting on offer are both on the list, so an
    // assistant reading it can satisfy the gate without guessing.
    expect(listed).toContain('brand');
    expect(listed).toContain(CONDITION_KEY);
  });

  // 25 September 2026, the first production run: a Spanish conversation
  // partner was told to ask for a brand, a model and a condition.
  it('asks a service or social posting for what counts there, not goods keys', () => {
    const s = detailShortfall({ category: 'social.language_exchange', type: 'looking_for', kind: 'Spanish conversation partner', attributes: {} })!;
    expect(s.human_action).toBe(DETAIL_CONTEXT_HUMAN_ACTION);
    expect(DETAIL_CONTEXT_HUMAN_ACTION.length).toBeLessThanOrEqual(300);
    expect(lintHumanCopy(DETAIL_CONTEXT_HUMAN_ACTION)).toEqual([]);
    expect(DETAIL_CONTEXT_HUMAN_ACTION).toContain('detail_unknown');
    expect(DETAIL_CONTEXT_HUMAN_ACTION).not.toMatch(/brand|model|condition/);
    const listed = DETAIL_CONTEXT_HUMAN_ACTION.split('`attributes`:')[1]
      .split('.')[0]
      .split(',')
      .map((w) => w.trim());
    for (const key of listed) expect(CONTEXT_KEYS.includes(key), key).toBe(true);
    const goods = detailShortfall({ category: 'goods.x', type: 'offering', attributes: {} })!;
    expect(goods.human_action).toBe(DETAIL_HUMAN_ACTION);
  });

});

// ---------------------------------------------------------------------------
// What the edge-case probe on dev posted (26 September 2026), read by the rule.
// ---------------------------------------------------------------------------
describe('the things people actually post', () => {
  it('lets rich attributes through under whatever keys the assistant chose', () => {
    const passes: Parameters<typeof detailShortfall>[0][] = [
      // A black adjustable office chair in good condition.
      {
        category: 'goods.furniture.office-chair',
        type: 'offering',
        kind: 'office chair',
        attributes: { condition: 'good', colour: 'black', adjustable: true },
      },
      // A Spanish want: every key in Spanish, and it says plainly what it is.
      {
        category: 'goods.bicycle',
        type: 'looking_for',
        kind: 'bicicleta usada',
        attributes: { tipo: 'bicicleta de paseo o híbrida', talla_cuadro: 'mediana' },
      },
      // Leftover pastries from a café: no condition asked of food.
      {
        category: 'goods.food.surplus',
        type: 'offering',
        kind: 'leftover pastries',
        attributes: { quantity: 10, types: 'croissants and danishes', pickup: 'at close' },
      },
      // A share of a bulk coffee order, filed somewhere else entirely.
      {
        category: 'goods.food.coffee-beans',
        type: 'offering',
        kind: 'share of bulk coffee order',
        attributes: { share_size: '1kg', roast: 'medium', order_closes: 'Friday' },
      },
      // A ladder to borrow for a day.
      {
        category: 'goods.tools.ladder',
        type: 'looking_for',
        kind: 'extension ladder to borrow',
        attributes: { arrangement: 'borrow', when: 'Saturday', min_height_m: 4 },
      },
    ];
    for (const card of passes) expect(detailShortfall(card), String(card.kind)).toBeUndefined();
  });

  it('still turns back a posting made only of the arrangement', () => {
    // When, how it changes hands and what it costs say nothing a stranger
    // could recognise the thing by.
    const short = detailShortfall({
      category: 'goods.tools.ladder',
      type: 'looking_for',
      kind: 'ladder',
      attributes: { when: 'Saturday', pickup: 'yes', free: true, budget_note: 'cheap' },
    });
    expect(short).toBeDefined();
  });

  it('never asks the make and model of food, a share, or something lent', () => {
    for (const card of [
      { category: 'goods.food.surplus', type: 'offering', kind: 'leftover pastries', attributes: {} },
      { category: 'goods.food.coffee-beans', type: 'looking_for', kind: 'share of bulk coffee order', attributes: {} },
      { category: 'goods.sports.water.surf', type: 'looking_for', kind: 'surfboard hire', attributes: {} },
      { category: 'goods.tools.ladder', type: 'looking_for', kind: 'extension ladder to borrow', attributes: {} },
      { category: 'goods.tools.ladder', type: 'offering', kind: 'extension ladder', attributes: { arrangement: 'lend' } },
    ]) {
      const short = detailShortfall(card)!;
      expect(short, card.kind).toBeDefined();
      const all = short.questions.join(' ');
      expect(all, card.kind).not.toContain('make and model');
      expect(all, card.kind).not.toContain('What comes with it');
      for (const q of short.questions) expect(lintHumanCopy(q), q).toEqual([]);
    }
    // Food and shares carry no condition either; something lent still does.
    const pastries = detailShortfall({
      category: 'goods.food.surplus',
      type: 'offering',
      kind: 'leftover pastries',
      attributes: {},
    })!;
    expect(pastries.questions.join(' ')).not.toContain('condition');
    const ladder = detailShortfall({
      category: 'goods.tools.ladder',
      type: 'offering',
      kind: 'extension ladder to lend',
      attributes: { height_m: 6, type: 'aluminium extension' },
    })!;
    expect(ladder.questions).toEqual(['What condition is the extension ladder to lend in?']);
  });

  it('asks only for the condition where the facts are already there', () => {
    // A pine bookshelf with five shelves was asked its make and model and
    // which one it was, when the only thing it had not said was its condition.
    const short = detailShortfall({
      category: 'goods.furniture.bookcase',
      type: 'offering',
      kind: 'bookshelf',
      attributes: { material: 'pine', shelves: 5 },
    })!;
    expect(short.questions).toEqual(['What condition is the bookshelf in?']);
  });

  it('asks an errand or something social nothing where it has said what it is', () => {
    // A dated hike and a lost dog were asked whether they were in person or
    // online, and how often.
    for (const card of [
      {
        category: 'social.activity-partner.hiking',
        type: 'offering',
        kind: 'Saturday hiking group',
        attributes: { date: '2026-10-04', start_time: '08:00', difficulty: 'moderate' },
      },
      {
        category: 'social.community.lost-and-found',
        type: 'looking_for',
        kind: 'lost dog',
        attributes: { breed: 'kelpie', colour: 'brown', collar: 'red' },
      },
    ]) {
      expect(detailShortfall(card), card.kind).toBeUndefined();
    }
    // A figure alone is still not a fact about what it is.
    expect(
      detailShortfall({
        category: 'services.tutoring.maths',
        type: 'looking_for',
        kind: 'maths tutoring',
        attributes: { budget: 'modest' },
      }),
    ).toBeDefined();
  });

  it('names, in the line with the radius on it, only keys the rule counts', () => {
    const listed = DETAIL_AND_RADIUS_HUMAN_ACTION.split('`attributes`:')[1]
      .split('.')[0]
      .split(',')
      .map((w) => w.trim());
    const counted = new Set<string>([...IDENTIFYING_KEYS, CONDITION_KEY]);
    for (const key of listed) expect(counted.has(key), key).toBe(true);
    expect(DETAIL_AND_RADIUS_HUMAN_ACTION.length).toBeLessThanOrEqual(300);
    expect(lintHumanCopy(DETAIL_AND_RADIUS_HUMAN_ACTION)).toEqual([]);
    expect(DETAIL_AND_RADIUS_HUMAN_ACTION).toContain('`reach`');
  });
});

// ---------------------------------------------------------------------------
// The door, and what the assistant is handed
// ---------------------------------------------------------------------------
interface World {
  sql: { text: string; params: any[] }[];
  /**
   * The open posting attempts, and the gates that have asked on each. Keyed on
   * the attempt's own reference and on nothing the poster wrote, which is the
   * whole of the escape hatch: a second attempt is recognised by the number the
   * first refusal handed over, however the words for the thing have moved.
   */
  refs: RefsFake;
  card: Record<string, any>;
}
let world: World;

function fakePool() {
  return {
    query: async (sql: string, params: any[] = []) => {
      world.sql.push({ text: sql.replace(/\s+/g, ' ').trim(), params });
      // The posting takes the attempt's own reference as its id where there is
      // one, which is the last thing the statement binds (domain/cards.ts).
      if (/INSERT INTO cards/.test(sql)) {
        return { rows: [{ id: params[params.length - 1] ?? CARD }], rowCount: 1 };
      }
      const refs = world.refs.handle(sql, params);
      if (refs) return refs;
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
    refs: refsFake(),
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

const refusal = async (
  card: any,
  opts?: { detailUnknown?: boolean; reference?: unknown },
) => {
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
    const p = (await refusal(listing({ attributes: {} })))!;
    const asked = world.sql.find((s) => /INSERT INTO posting_references/.test(s.text))!;
    expect(asked).toBeDefined();
    // The number, the account and the gate that asked — and nothing about the
    // posting at all, which is what makes the words free to change. The last
    // slot is for figures, and the detail gate reads none, so it stays null.
    expect(asked.params).toEqual([p.reference, ACCOUNT, ['detail'], null]);
    expect(JSON.stringify(asked.params)).not.toContain('mountain bike');
  });

  it('lets a rich posting straight through, untouched', async () => {
    const r: any = await publishIntent(cfg, ACCOUNT, listing({ attributes: rich }));
    expect(r.intent_id).toBe(CARD);
    expect(world.sql.some((s) => /INSERT INTO posting_references/.test(s.text))).toBe(false);
  });

  it('refuses detail_unknown on a first attempt, because nobody has been asked yet', async () => {
    const p = await refusal(listing({ attributes: {} }), { detailUnknown: true });
    expect(p?.code).toBe('NEEDS_DETAIL');
  });

  it('takes the posting as it stands on a second attempt with the reference', async () => {
    const asked = (await refusal(listing({ attributes: {} })))!;
    expect(asked.code).toBe('NEEDS_DETAIL');
    const r: any = await publishIntent(cfg, ACCOUNT, listing({ attributes: {} }), {
      detailUnknown: true,
      reference: asked.reference,
    });
    // And it goes up under the number it was asked about, never a second one.
    expect(r.intent_id).toBe(asked.reference);
  });

  // 26 September 2026: a Spanish want answered the questions under Spanish
  // keys, sent the reference back, and was handed the identical questions a
  // second time. Nothing is asked twice on one reference.
  it('never asks the same questions twice on one reference', async () => {
    const asked = (await refusal(listing({ attributes: {} })))!;
    expect(asked.code).toBe('NEEDS_DETAIL');
    const r: any = await publishIntent(
      cfg,
      ACCOUNT,
      listing({ attributes: { descripcion: 'bicicleta de montaña', estado: 'buen estado' } }),
      { reference: asked.reference },
    );
    expect(r.intent_id).toBe(asked.reference);
  });

  it('asks again where the reference belongs to somebody else', async () => {
    // THE ONLY THING THAT STOPS A BORROWED NUMBER. The read is by reference and
    // account together, so another account's reference matches nothing here and
    // the attempt reads as a first try, which is exactly right.
    const asked = (await refusal(listing({ attributes: {} })))!;
    expect(asked.code).toBe('NEEDS_DETAIL');
    // The same number, now standing against a different account.
    world.refs.rows.get(asked.reference!)!.account_id = 'cccccccc-3333-4333-8333-cccccccccccc';
    const again = await refusal(listing({ attributes: {} }), {
      detailUnknown: true,
      reference: asked.reference,
    });
    expect(again?.code).toBe('NEEDS_DETAIL');
    expect(again?.human_action).toBe(DETAIL_UNKNOWN_UNMATCHED);
  });

  it('asks again where no reference came back at all', async () => {
    expect((await refusal(listing({ attributes: {} })))?.code).toBe('NEEDS_DETAIL');
    const p = await refusal(listing({ attributes: {} }), { detailUnknown: true });
    expect(p?.code).toBe('NEEDS_DETAIL');
    expect(p?.human_action).toBe(DETAIL_UNKNOWN_UNMATCHED);
  });

  /**
   * THE LOOP NOBODY COULD SEE THE SHAPE OF, AND THE ONE WAY BACK INTO IT.
   *
   * The questions ask an assistant to pin down what the thing is, and a good
   * one comes back with sharper words for it — which used to be the one thing
   * that made the row stop recognising it. The reference ended that: nothing
   * the assistant writes is a key any more, so rewording cannot cost it the
   * escape hatch (see the reword test in postingReference.test.ts).
   *
   * What is left is an attempt that carries no reference at all — dropped by a
   * client, or a genuinely new posting. That one is a first try, and saying so
   * is the whole of this sentence: in the 20 September rehearsals the seller's
   * assistant sent detail_unknown, got the same four questions back with no
   * word that the flag had been read at all, and went round again.
   */
  it('says so when detail_unknown was sent with no reference', async () => {
    // Asked once, and the answer carried the number.
    const asked = (await refusal(listing({ attributes: {} })))!;
    expect(asked.code).toBe('NEEDS_DETAIL');
    // The assistant gives up on the rest but sends the flag on its own.
    const p = (await refusal(listing({ attributes: {} }), { detailUnknown: true }))!;
    expect(p.code).toBe('NEEDS_DETAIL');
    expect(p.human_action).toBe(DETAIL_UNKNOWN_UNMATCHED);
    expect(p.human_action).toContain('`reference`');
    expect(p.human_action!.length).toBeLessThanOrEqual(300);
    expect(lintHumanCopy(p.human_action!)).toEqual([]);
    // The questions still ride along, so answering them is still the road out.
    expect(p.questions!.length).toBeGreaterThan(0);
    // And a number rides along, so the way out it names is in the agent's hand.
    // It is a NEW one: an attempt that carried nothing back is a new attempt,
    // and the first number went nowhere because the agent did not send it.
    expect(p.reference).toBeTruthy();
    expect(p.reference).not.toBe(asked.reference);

    // The way out it names works — and the words for the thing may move as far
    // as the questions asked them to in the meantime.
    const r: any = await publishIntent(
      cfg,
      ACCOUNT,
      listing({ attributes: {}, kind: 'Fanatec ClubSport V3 brake performance spring' }),
      { detailUnknown: true, reference: p.reference },
    );
    expect(r.intent_id).toBe(p.reference);
  });

  it('keeps the ordinary questions where detail_unknown was never sent', async () => {
    const p = (await refusal(listing({ attributes: {} })))!;
    expect(p.human_action).toBe(DETAIL_HUMAN_ACTION);
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
