/**
 * TWO SHELVES WITH A RULE OF THEIR OWN (Lachlan, 26 September 2026).
 *
 *  - FOOD IS SHOP-BOUGHT ONLY. goods.food opened today; a posting there whose
 *    own words say it was made, cooked or baked at home is refused before it
 *    goes up, with one plain sentence. Shop food, a café's leftovers, a share
 *    of a bulk order and home-GROWN produce all go up. Food is asked no make,
 *    no model and no condition.
 *  - LOST AND FOUND PETS is the one place a live animal may appear. A lost pet
 *    (a want) and a found one (a have) can go up with no price, no asking
 *    price, no best offer and no reward; a posting there that reads as a sale,
 *    a rehoming or an adoption is refused as live-animals. The detail
 *    questions ask what the pet looks like and where it was lost or found.
 *
 * The rule itself is src/domain/shelfRules.ts; the door is domain/cards.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/aws.js', () => ({ bedrock: { send: vi.fn() }, sqs: { send: vi.fn() } }));
vi.mock('../../src/crypto.js', () => ({ encryptField: async () => Buffer.from('x') }));
vi.mock('../../src/intake/pipe.js', () => ({
  runIntake: vi.fn(async () => ({ outcome: 'allow', checks: [] })),
  decidingCheck: () => undefined,
}));
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
import { runIntake } from '../../src/intake/pipe.js';
import { amendIntent, publishIntent } from '../../src/domain/cards.js';
import {
  HOME_MADE_FOOD_SENTENCE,
  LOST_PET_NOT_A_SALE_SENTENCE,
  LOST_PET_NO_MONEY_SENTENCE,
  LOST_PET_SHELF,
  onLostPetShelf,
  shelfRuleRefusal,
} from '../../src/domain/shelfRules.js';
import { DETAIL_LOST_PET_HUMAN_ACTION, detailShortfall } from '../../src/domain/postingDetail.js';
import { screenCard, screeningReasonInPlainWords } from '../../src/domain/screening.js';
import { MODEL_SCREEN_SYSTEM_PROMPT } from '../../src/intake/checks/modelScreen.js';
import { categoryGate, categoryDenied } from '../../src/denylist.js';
import { lintHumanCopy } from '../../src/email/lint.js';
import { OsbError, SCHEMA_VERSION } from '../../src/protocol.js';
import type { Config } from '../../src/config.js';
import { refsFake, type RefsFake } from './postingRefsFake.js';

const cfg = {
  quotas: { maxOpenCards: 20, maxPublishesPerDay: 20 },
  screeningQueueUrl: 'https://queue.test/screening',
} as unknown as Config;

const ACCOUNT = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const CARD = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

// ---------------------------------------------------------------------------
describe('the shelves exist where the catalogue says', () => {
  it('opens the food leaves and the lost and found pets shelf, and keeps cooking to order closed', () => {
    for (const c of [
      'goods.food.produce',
      'goods.food.pantry',
      'goods.food.coffee-tea',
      'goods.food.bulk-buy',
      'goods.food.surplus',
      LOST_PET_SHELF,
    ]) {
      expect(categoryGate(c).ok, c).toBe(true);
      expect(categoryGate(c).known, c).toBe(true);
      expect(categoryDenied(c), c).toBeUndefined();
    }
    // The draft bread-and-pastries leaf was folded into surplus.
    expect(categoryGate('goods.food.baked').known).toBe(false);
    expect(categoryGate('services.food.home-cooked').ok).toBe(false);
    expect(categoryGate('services.food.baking').ok).toBe(false);
    // Animals as goods stay denied by path.
    expect(categoryDenied('goods.animals.dog')?.reason_code).toBe('live-animals');
    expect(onLostPetShelf('social.community.lost-pet')).toBe(true);
    expect(onLostPetShelf('social.community.local-group')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('food is shop-bought only', () => {
  const food = (kind: string, attributes: Record<string, unknown> = {}) => ({
    category: 'goods.food.surplus',
    kind,
    attributes,
  });

  it('refuses a food posting that says it was made at home, however it says so', () => {
    for (const card of [
      food('home-made lasagne'),
      food('homemade jam'),
      food('home cooked meals'),
      food('Home-baked sourdough'),
      food('banana bread', { made: 'baked at home this morning' }),
      food('curry', { note: 'cooked it myself' }),
      food('muffins', { about: 'I baked a double batch' }),
      food('kombucha', { type: 'home brewed' }),
    ]) {
      expect(shelfRuleRefusal(card), card.kind).toEqual({
        reason_code: 'home-made-food',
        human_action: HOME_MADE_FOOD_SENTENCE,
      });
    }
  });

  it('lets shop food, leftovers, bulk shares and home-grown produce through', () => {
    for (const card of [
      food('leftover pastries from the bakery', { quantity: 'a box' }),
      food('croissants and danishes left at close'),
      { category: 'goods.food.bulk-buy', kind: 'share of a bulk coffee order I made', attributes: {} },
      { category: 'goods.food.produce', kind: 'home-grown lemons', attributes: { quantity: 'a bag' } },
      { category: 'goods.food.pantry', kind: 'sealed tins of tomatoes' },
    ]) {
      expect(shelfRuleRefusal(card), card.kind).toBeUndefined();
    }
  });

  it('is only about the food shelf', () => {
    expect(shelfRuleRefusal({ category: 'goods.home.textiles', kind: 'home-made quilt' })).toBeUndefined();
    expect(
      shelfRuleRefusal({ category: 'social.activity-partner.cooking', kind: 'home cooking together' }),
    ).toBeUndefined();
  });

  it('asks food no make, no model and no condition', () => {
    const short = detailShortfall({
      category: 'goods.food.surplus',
      type: 'offering',
      kind: 'leftover pastries',
      attributes: {},
    })!;
    expect(short.questions.join(' ')).not.toMatch(/make and model|condition/i);
    expect(
      detailShortfall({
        category: 'goods.food.coffee-tea',
        type: 'offering',
        kind: 'coffee beans',
        attributes: { roast: 'medium', quantity: '1 kg' },
      }),
    ).toBeUndefined();
  });

  it('says it plainly, inside the cap', () => {
    expect(HOME_MADE_FOOD_SENTENCE).toMatch(/^Home-made food isn't open on the switchboard yet\./);
    expect(HOME_MADE_FOOD_SENTENCE.length).toBeLessThanOrEqual(300);
    expect(lintHumanCopy(HOME_MADE_FOOD_SENTENCE)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe('lost and found pets', () => {
  const pet = (over: Record<string, unknown> = {}) => ({
    category: LOST_PET_SHELF,
    kind: 'lost kelpie',
    attributes: { colour: 'red', collar: 'blue with a tag', where: 'near the oval' },
    ...over,
  });

  it('lets a lost or a found pet with no money on it through', () => {
    expect(shelfRuleRefusal(pet())).toBeUndefined();
    expect(shelfRuleRefusal(pet({ kind: 'found tabby cat' }))).toBeUndefined();
  });

  it('refuses any money on it: a band, an asking price, a best offer, a reward', () => {
    for (const [over, field] of [
      [{ price: { band: { max: 50 }, ccy: 'AUD' } }, 'price'],
      [{ ask: { amount: 100, ccy: 'AUD' } }, 'ask'],
      [{ sale: 'best-offer' }, 'sale'],
      [{ attributes: { colour: 'black', reward: 'yes' } }, 'attributes'],
      [{ kind: 'lost dog, reward offered' }, 'attributes'],
    ] as const) {
      expect(shelfRuleRefusal(pet(over as any))).toEqual({
        reason_code: 'no-money-on-lost-pets',
        human_action: LOST_PET_NO_MONEY_SENTENCE,
        field,
      });
    }
  });

  it('refuses a sale, a rehoming or an adoption as live animals', () => {
    for (const kind of ['kelpie puppies for sale', 'rehoming our cat', 'dog to adopt', 'selling a budgie']) {
      expect(shelfRuleRefusal(pet({ kind }))?.reason_code, kind).toBe('live-animals');
      expect(shelfRuleRefusal(pet({ kind }))?.human_action).toBe(LOST_PET_NOT_A_SALE_SENTENCE);
    }
    expect(
      shelfRuleRefusal(pet({ attributes: { note: 'free to a good home' } }))?.reason_code,
    ).toBe('live-animals');
  });

  it('asks what the pet looks like and where it went missing or turned up', () => {
    const lost = detailShortfall({ category: LOST_PET_SHELF, type: 'looking_for', kind: 'lost kelpie' })!;
    expect(lost.questions.join(' ')).toMatch(/look like/);
    expect(lost.questions.join(' ')).toMatch(/Where and when was it lost\?/);
    expect(lost.questions.join(' ')).not.toMatch(/condition|in person or online|how often/i);
    expect(lost.human_action).toBe(DETAIL_LOST_PET_HUMAN_ACTION);
    const found = detailShortfall({ category: LOST_PET_SHELF, type: 'offering', kind: 'found dog' })!;
    expect(found.questions.join(' ')).toMatch(/Where and when was it found\?/);
    // One fact of any kind is enough, as on the rest of social.
    expect(
      detailShortfall({ category: LOST_PET_SHELF, type: 'offering', kind: 'found dog', attributes: { colour: 'brown' } }),
    ).toBeUndefined();
    for (const q of [...lost.questions, ...found.questions]) expect(q.length).toBeLessThanOrEqual(120);
  });

  it('tells the screen that a pet going home is not an animal changing hands', () => {
    expect(MODEL_SCREEN_SYSTEM_PROMPT).toMatch(/lost pet being looked for, or a found pet waiting for its owner/);
    expect(MODEL_SCREEN_SYSTEM_PROMPT).toMatch(/sold, bought, given away, rehomed, adopted or bred/);
  });

  it('says every sentence plainly, inside the cap', () => {
    for (const s of [LOST_PET_NO_MONEY_SENTENCE, LOST_PET_NOT_A_SALE_SENTENCE, DETAIL_LOST_PET_HUMAN_ACTION]) {
      expect(s.length).toBeLessThanOrEqual(300);
      expect(lintHumanCopy(s)).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// The screening worker's backstop, and the sentences it stores.
// ---------------------------------------------------------------------------
describe('the screening worker applies the same rules to the row', () => {
  it('refuses a home-made food row and a priced lost pet without a model call', async () => {
    vi.mocked(runIntake).mockClear();
    const row: any = {
      id: CARD,
      account_id: ACCOUNT,
      category: 'goods.food.surplus',
      kind: 'home-made brownies',
      attributes: {},
      ask: null,
      sale: 'straight',
      price_enc: null,
    };
    expect(await screenCard(cfg, row)).toMatchObject({ pass: false, reason_code: 'home-made-food' });
    expect(
      await screenCard(cfg, { ...row, category: LOST_PET_SHELF, kind: 'lost dog', price_enc: Buffer.from('x') }),
    ).toMatchObject({ pass: false, reason_code: 'no-money-on-lost-pets' });
    expect(runIntake).not.toHaveBeenCalled();
    expect(screeningReasonInPlainWords('home-made-food')).toBe(HOME_MADE_FOOD_SENTENCE);
    expect(screeningReasonInPlainWords('no-money-on-lost-pets')).toBe(LOST_PET_NO_MONEY_SENTENCE);
    expect(screeningReasonInPlainWords('live-animals')).toMatch(/apart from lost and found pets/);
  });
});

// ---------------------------------------------------------------------------
// The door: publish and amend.
// ---------------------------------------------------------------------------
interface World {
  sql: { text: string; params: any[] }[];
  refs: RefsFake;
  card: Record<string, any>;
}
let world: World;

function fakePool() {
  return {
    query: async (sql: string, params: any[] = []) => {
      world.sql.push({ text: sql.replace(/\s+/g, ' ').trim(), params });
      if (/INSERT INTO cards/.test(sql)) {
        return { rows: [{ id: params[params.length - 1] ?? CARD }], rowCount: 1 };
      }
      const refs = world.refs.handle(sql, params);
      if (refs) return refs;
      if (/SELECT \* FROM cards WHERE id/.test(sql)) return { rows: [world.card], rowCount: 1 };
      if (/SELECT arrangement FROM accounts/.test(sql)) {
        return { rows: [{ arrangement: null }], rowCount: 1 };
      }
      if (/FROM accounts/.test(sql)) {
        return { rows: [{ id: ACCOUNT, data_key_enc: Buffer.from('k'), timezone: null }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  } as any;
}

const posting = (over: Record<string, unknown> = {}) => ({
  schema_version: SCHEMA_VERSION,
  type: 'looking_for',
  category: LOST_PET_SHELF,
  kind: 'lost kelpie',
  attributes: { colour: 'red', collar: 'blue' },
  geo: { bucket: 'r3gx', radius_km: 10, reach: 'radius' },
  ttl_days: 30,
  ...over,
});

const refusal = async (fn: () => Promise<unknown>): Promise<any> => {
  try {
    await fn();
    return undefined;
  } catch (e: any) {
    if (e instanceof OsbError) return e.payload;
    return { error: e.message, validation: e.validation };
  }
};

const wentUp = () => world.sql.some((s) => /INSERT INTO cards/.test(s.text));

describe('the door', () => {
  beforeEach(() => {
    world = {
      sql: [],
      refs: refsFake(),
      card: {
        id: CARD,
        account_id: ACCOUNT,
        schema_version: SCHEMA_VERSION,
        type: 'WANT',
        category: LOST_PET_SHELF,
        category_as_posted: LOST_PET_SHELF,
        kind: 'lost kelpie',
        geo: { bucket: 'r3gx', radius_km: 10, reach: 'radius' },
        attributes: { colour: 'red' },
        ask: null,
        urgency: 'none',
        visibility: 'anonymous-until-match',
        protocol_status: 'active',
        lifecycle_state: 'PUBLISHED',
        price_enc: null,
        ttl_days: 30,
        expires_at: new Date('2026-11-01T00:00:00Z'),
        screening: null,
        slots: 1,
        sale: 'straight',
      },
    };
    vi.spyOn(db, 'getPool').mockReturnValue(fakePool());
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('puts a lost pet up', async () => {
    const r: any = await publishIntent(cfg, ACCOUNT, posting());
    expect(r.intent_id).toBeTruthy();
    expect(wentUp()).toBe(true);
  });

  it('refuses a home-made food posting as the thing it is, before any question is asked', async () => {
    const p = await refusal(() =>
      publishIntent(
        cfg,
        ACCOUNT,
        posting({
          type: 'offering',
          category: 'goods.food.surplus',
          kind: 'home-baked banana bread',
          attributes: {},
          geo: { bucket: 'r3gx', radius_km: 10, reach: 'radius' },
        }),
      ),
    );
    expect(p.code).toBe('CATEGORY_PROHIBITED');
    expect(p.human_action).toBe(HOME_MADE_FOOD_SENTENCE);
    expect(p.questions).toBeUndefined();
    expect(wentUp()).toBe(false);
  });

  it('refuses a price on a lost pet as a field to take off, before any figure is read back', async () => {
    const p = await refusal(() =>
      publishIntent(cfg, ACCOUNT, posting({ price: { band: { max: 200 }, ccy: 'AUD' } })),
    );
    expect(p.error).toBe(LOST_PET_NO_MONEY_SENTENCE);
    expect(p.validation).toEqual(['price']);
    expect(wentUp()).toBe(false);
  });

  it('refuses a found pet offered for rehoming as live animals', async () => {
    const p = await refusal(() =>
      publishIntent(cfg, ACCOUNT, posting({ type: 'offering', kind: 'kitten needs rehoming' })),
    );
    expect(p.code).toBe('CATEGORY_PROHIBITED');
    expect(p.human_action).toBe(LOST_PET_NOT_A_SALE_SENTENCE);
    expect(wentUp()).toBe(false);
  });

  it('refuses an amend that adds a reward to a lost pet already up', async () => {
    const p = await refusal(() =>
      amendIntent(cfg, ACCOUNT, CARD, { attributes: { colour: 'red', reward: 'yes' } }),
    );
    expect(p.error).toBe(LOST_PET_NO_MONEY_SENTENCE);
    expect(p.validation).toEqual(['attributes']);
  });

  // 26 September 2026: a lost brown kelpie was refused as breeding stock
  // because its attributes named its breed.
  it('reads a breed as a description, and breeding as a trade', () => {
    const lost = {
      category: 'social.community.lost-pet',
      kind: 'lost dog',
      attributes: { animal: 'dog', breed: 'kelpie', colour: 'brown', collar: 'red' },
    };
    expect(shelfRuleRefusal(lost)).toBeUndefined();
    expect(shelfRuleRefusal({ ...lost, kind: 'kelpie pups from a breeder' })?.reason_code).toBe('live-animals');
    expect(shelfRuleRefusal({ ...lost, kind: 'kelpie for breeding' })?.reason_code).toBe('live-animals');
  });
});
