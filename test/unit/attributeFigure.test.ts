/**
 * A BUDGET IS NOT AN ATTRIBUTE.
 *
 * The hole this suite holds shut (20 September 2026). `attributes` on a want
 * or a have is free-form: any lower_snake_case key the assistant invents, with
 * a string, a number or a boolean under it. Every value on it CROSSES to the
 * counterparty at the details step (domain/matches.ts, buildAttributes reads
 * `card.attributes` straight onto the payload). The posting door's money check
 * read `kind` and nothing else, by a decision written into the check itself.
 *
 * So `{ budget: 25 }` on a want went up untouched and was handed to the seller
 * the moment both sides were keen: the buyer's ceiling, in front of the person
 * they were about to haggle with, before a single figure had been offered. It
 * is the best-offer floor leak of the same week (test/unit/bestOfferFloor.test
 * .ts) arriving by a different road — that one put the reserve in `ask`, this
 * one puts the ceiling in a key nobody thought to look at.
 *
 * WHAT WAS ACTUALLY FOUND BEFORE ANY OF THIS WAS BUILT, because the rule is
 * only worth what the evidence behind it is worth: no stored transcript shows
 * it happening. The realism, adversary and duet reports on disk carry nineteen
 * `attributes` objects between them and not one figure in any of them. But the
 * adversary suite, which plants a $412 ceiling and hunts for it, cannot see
 * the arguments of publish_intent or amend_intent at all (test/adversary/
 * grader.ts, OUTWARD_UNCOVERED), so it would never have caught this; and the
 * rehearsal checks already walk attributes for currency signs and price-shaped
 * keys (test/rehearsal/checks.ts, figuresOn) because somebody expected money
 * to land there. Unobserved, unobservable, and one line of an assistant's
 * judgement away. The amend door made it worse: it ran no money check of any
 * kind, and `attributes` is the one free-text thing an amend may change.
 *
 * THE RULE, AND IT IS NARROWER THAN THE ONE ON THE OPEN CONVERSATION. A
 * posting is full of honest numbers — `year: 2019`, `ram_gb: 16`,
 * `wheel_size_in: 29`, `shutter_count: 12500` — and refusing those would be a
 * nuisance with no leak behind it. So an attribute is a figure when the VALUE
 * names money ($25, 25 AUD, twenty five dollars, asking 450, 450 ono), or when
 * a number sits under a KEY that is named for money (`budget`, `max_price`,
 * `hourly_rate`). Both halves are asserted here, and so is everything the rule
 * must leave alone.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/aws.js', () => ({ bedrock: { send: vi.fn() }, sqs: { send: vi.fn() } }));
vi.mock('../../src/crypto.js', () => ({ encryptField: async () => Buffer.from('x') }));
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
import { PLACE_NOT_FULL } from '../../src/geo/normalise.js';
import { buildAttributes } from '../../src/domain/matches.js';
import {
  attributeFigureRule,
  figureInAttributeAction,
  moneyShapedKey,
} from '../../src/domain/moneyInWords.js';
import { ATTRIBUTE_FIELD_PREFIX, attributeFields } from '../../src/intake/checks/moneyFigure.js';
import { runIntake } from '../../src/intake/pipe.js';
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

/** Enough to describe the thing to a stranger; the detail gate is next door. */
const rich = { brand: 'trek', frame_size: 'medium', condition: 'good' };

// ---------------------------------------------------------------------------
// THE RULE ITSELF.
//
// Each case is named with the attribute as an assistant would have written it,
// so a failure reads as the attribute that was got wrong rather than as an
// index. The left column is the key, because the key is half the question:
// the same 25 is a number of seats under `seats` and a ceiling under `budget`.
// ---------------------------------------------------------------------------

/** Every attribute that is a figure, however it is dressed. */
const REFUSE: [group: string, key: string, value: unknown][] = [
  // The value says money out loud.
  ['a money sign', 'condition', 'good, worth $25'],
  ['a money sign', 'notes', 'A$420 for the pair'],
  ['a money sign', 'model', '420$'],
  ['a money code', 'notes', 'around 420 AUD'],
  ['a money code', 'notes', 'USD 25'],
  ['a money word', 'notes', 'twenty five dollars'],
  ['a money word', 'notes', 'about 400 bucks'],
  ['a money word', 'condition', 'a few grand of work in it'],
  ['a price opening', 'notes', 'asking 450'],
  ['a price opening', 'notes', 'would you take 400'],
  ['a price ending', 'notes', '450 ono'],
  ['a price ending', 'notes', '400 firm'],

  // The key says money, and a number of any kind is under it. This is the half
  // that catches the leak the suite is named for.
  ['a money key', 'budget', 25],
  ['a money key', 'budget', '25'],
  ['a money key', 'max_price', 'up to 25'],
  ['a money key', 'price_ceiling', 25],
  ['a money key', 'asking_price', 620],
  ['a money key', 'max_spend', 'twenty five'],
  ['a money key', 'cost', 40],
  ['a money key', 'reserve', 10],
  ['a money key', 'postage', 15],
  ['a money key', 'deposit', 200],
  ['a money key', 'aud_max', 25],
  // Two words that are a price only with a stretch of time beside them.
  ['a rate over time', 'hourly_rate', 40],
  ['a rate over time', 'day_rate', 350],
  ['a rate over time', 'per_hour', 40],
  ['a rate over time', 'rate_per_session', 60],
];

/** Every honest attribute, which must still go up. */
const ALLOW: [group: string, key: string, value: unknown][] = [
  // Specs: the bare numbers that fill a real posting.
  ['a spec', 'year', 2019],
  ['a spec', 'expiry_year', 2027],
  ['a spec', 'wheel_size_in', 29],
  ['a spec', 'frame_size', 'medium'],
  ['a spec', 'ram_gb', 16],
  ['a spec', 'storage_gb', 512],
  ['a spec', 'shutter_count', 12500],
  ['a spec', 'battery_wh', 500],
  ['a spec', 'screen_in', 13.3],
  ['a spec', 'duration_min', 90],
  ['a spec', 'seats', 3],
  ['a spec', 'group_size', 8],
  ['a spec', 'height_cm', 180],
  // A model number is two decimal places and a version, and no price at all.
  ['a model number', 'model', '1.10'],
  ['a model number', 'model', 'eos r10'],
  ['a model number', 'lens_mount', 'rf'],
  // The words that are not money on their own.
  ['a near-money key', 'frame_rate', 60],
  ['a near-money key', 'refresh_rate', 120],
  ['a near-money key', 'floor', 3],
  ['a near-money key', 'ceiling_height_cm', 240],
  // A money key with nothing to say is nothing to refuse.
  ['a money key with no number', 'budget', 'flexible'],
  ['a money key with no number', 'price', 'negotiable'],
  // Plain words, including money words with no number anywhere near them.
  ['plain words', 'condition', 'good'],
  ['plain words', 'condition', 'worth every dollar of it'],
  ['plain words', 'colour', 'black'],
  ['plain words', 'language', 'english'],
  ['plain words', 'notes', 'pickup at 4.20 on the 14th'],
  ['plain words', 'notes', 'about 8km away, size 10, two of them'],
  // A boolean is never a figure.
  ['a boolean', 'unlocked', true],
  ['a boolean', 'delivery', false],
];

describe('an attribute that carries a figure', () => {
  for (const [group, key, value] of REFUSE) {
    it(`${group}: ${key} = ${JSON.stringify(value)}`, () => {
      const rule = attributeFigureRule(key, value);
      expect(rule, `no rule fired on ${key} = ${JSON.stringify(value)}`).toBeTruthy();
    });
  }
});

describe('an attribute that carries none', () => {
  for (const [group, key, value] of ALLOW) {
    it(`${group}: ${key} = ${JSON.stringify(value)}`, () => {
      expect(attributeFigureRule(key, value)).toBeUndefined();
    });
  }

  it('reads nothing into an empty or missing value', () => {
    expect(attributeFigureRule('budget', '')).toBeUndefined();
    expect(attributeFigureRule('budget', undefined)).toBeUndefined();
    expect(attributeFigureRule('budget', null)).toBeUndefined();
  });

  it('reads the same value the same way whether it was typed or numbered', () => {
    expect(attributeFigureRule('budget', 25)).toBe(attributeFigureRule('budget', '25'));
    expect(attributeFigureRule('seats', 3)).toBe(attributeFigureRule('seats', '3'));
  });

  /**
   * The dodges the words rule already folds away (domain/moneyInWords.ts,
   * foldForMoney): a value is folded before any rule reads it, so fullwidth
   * digits and a zero-width space in the middle of a number are the number.
   */
  it('reads a figure spelled in another script or split by an invisible', () => {
    expect(attributeFigureRule('notes', 'I can do ４２０ dollars')).toBeTruthy();
    expect(attributeFigureRule('budget', '4​20')).toBeTruthy();
  });
});

describe('which keys are named for money', () => {
  it('reads whole words, in either order', () => {
    expect(moneyShapedKey('price')).toBe(true);
    expect(moneyShapedKey('max_price')).toBe(true);
    expect(moneyShapedKey('price_max')).toBe(true);
    expect(moneyShapedKey('buyer_budget_aud')).toBe(true);
  });

  it('leaves the words that are money only sometimes', () => {
    // Which storey, how tall, how fast, and what it is worth to somebody.
    expect(moneyShapedKey('floor')).toBe(false);
    expect(moneyShapedKey('ceiling')).toBe(false);
    expect(moneyShapedKey('rate')).toBe(false);
    expect(moneyShapedKey('value')).toBe(false);
    expect(moneyShapedKey('worth')).toBe(false);
  });

  /**
   * AND NOTHING IN THE CATALOGUE COLLIDES WITH THE LIST. Every attribute the
   * taxonomy defines for any category is condition, brand, model, a size, a
   * count or a year: not one of them is about money. So a key this rule fires
   * on was invented by an assistant on the spot, which is the whole case it is
   * for. A category that one day wants a money attribute will fail here first.
   */
  it('collides with nothing the catalogue defines', async () => {
    const { loadTaxonomy } = await import('../../src/protocol.js');
    const tx: any = loadTaxonomy();
    const keys = new Set<string>(Object.keys(tx.common_attributes ?? {}));
    for (const node of Object.values<any>(tx.nodes ?? {})) {
      for (const k of Object.keys(node.attributes ?? {})) keys.add(k);
    }
    expect(keys.size).toBeGreaterThan(20);
    expect([...keys].filter((k) => moneyShapedKey(k))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// What the assistant is told.
// ---------------------------------------------------------------------------

describe('the refusal', () => {
  const said = figureInAttributeAction('budget');

  it('names the attribute the assistant chose, so it knows which word to fix', () => {
    expect(said).toContain("'budget'");
    expect(figureInAttributeAction('max_price')).toContain("'max_price'");
  });

  it('says it was not posted, and what to do instead', () => {
    expect(said).toMatch(/has not gone up/);
    expect(said).toMatch(/limits stay private/);
    expect(said).toMatch(/Post it again/);
  });

  it('fits the cap and passes the copy lint, however long the key was', () => {
    for (const key of ['budget', 'b', 'a'.repeat(300)]) {
      const sentence = figureInAttributeAction(key);
      // human_action is capped at 300 characters by the published error schema.
      expect(sentence.length, key).toBeLessThanOrEqual(300);
      expect(lintHumanCopy(sentence), sentence).toEqual([]);
      // The machinery's own nouns stay out of anything an agent relays.
      for (const re of [/\b(index\s+)?cards?\b/i, /\bmatch(es)?\b/i, /\bstages?\b/i]) {
        expect(re.test(sentence), sentence).toBe(false);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The pipe: how an attribute reaches the check, and what the check answers.
// ---------------------------------------------------------------------------

describe('attributes on their way into the pipe', () => {
  it('carries strings and numbers under a prefix no key can collide with', () => {
    expect(attributeFields({ budget: 25, condition: 'good' })).toEqual({
      [`${ATTRIBUTE_FIELD_PREFIX}budget`]: '25',
      [`${ATTRIBUTE_FIELD_PREFIX}condition`]: 'good',
    });
    // A colon cannot appear in a key the schema admits, so `kind` and
    // `category` can never be read as attributes and vice versa.
    expect(Object.keys(attributeFields({ budget: 25 }))[0]).toContain(':');
  });

  it('leaves out what carries no figure by construction', () => {
    expect(attributeFields({ unlocked: true, missing: undefined, nested: { a: 1 } })).toEqual({});
    expect(attributeFields(undefined)).toEqual({});
  });
});

describe('the check at the posting and amendment doors', () => {
  beforeEach(() => {
    // A process with no database has no suspensions in it (safety/suspend.ts),
    // so the pipe here is the checks and nothing else.
    vi.spyOn(db, 'dbConfigured').mockReturnValue(false);
  });

  const item = (door: 'posting' | 'amendment', attributes: Record<string, unknown>, kind?: string) =>
    ({
      door,
      sender_account: ACCOUNT,
      fields: {
        category: 'goods.bicycle.mountain',
        ...(kind ? { kind } : {}),
        ...attributeFields(attributes),
      },
    }) as const;

  for (const door of ['posting', 'amendment'] as const) {
    it(`refuses a ceiling in an attribute at the ${door} door, and names the key`, async () => {
      const v = await runIntake(cfg, item(door, { ...rich, budget: 25 }));
      expect(v.outcome).toBe('refuse');
      expect(v.reason_code).toBe('money-figure-in-words');
      expect(v.plain_words).toBe(figureInAttributeAction('budget'));
      const money = v.checks.find((c) => c.name === 'moneyFigure')!;
      expect(money.field).toBe('attributes.budget');
      // The rule that fired stays internal, and it says which attribute it was
      // so a refusal is one a person can justify out loud.
      expect(money.detail).toMatch(/^attribute budget: /);
    });

    it(`takes an honest posting full of numbers at the ${door} door`, async () => {
      const v = await runIntake(
        cfg,
        item(door, { ...rich, year: 2019, wheel_size_in: 29, shutter_count: 12500 }),
      );
      expect(v.outcome).toBe('pass');
    });
  }

  it('answers for the words for the thing first, which is the older half', async () => {
    const v = await runIntake(cfg, item('posting', { budget: 25 }, 'mountain bike, $420'));
    const money = v.checks.find((c) => c.name === 'moneyFigure')!;
    expect(money.field).toBe('kind');
  });

  it('leaves the open conversation exactly as it was', async () => {
    // Every rule still runs on a message, including the shape rules that are
    // held back from attributes: this one is a bare number opening a sentence.
    const v = await runIntake(cfg, {
      door: 'message',
      sender_account: ACCOUNT,
      text: '450 and I will collect Saturday',
    });
    expect(v.outcome).toBe('refuse');
    expect(v.reason_code).toBe('money-figure-in-words');
  });
});

// ---------------------------------------------------------------------------
// The doors themselves, end to end.
// ---------------------------------------------------------------------------

interface World {
  sql: { text: string; params: any[] }[];
  /** Every figure-confirmation key this account has already been asked about. */
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
      if (/UPDATE cards/.test(sql)) return { rows: [{ id: CARD }], rowCount: 1 };
      // The figure gate's ten-minute memory: asked once, and the same posting
      // sent again goes up (domain/postingFigure.ts).
      const refs = world.refs.handle(sql, params);
      if (refs) return refs;
      if (/SELECT \* FROM cards WHERE id/.test(sql)) return { rows: [world.card], rowCount: 1 };
      if (/SELECT arrangement FROM accounts/.test(sql)) {
        return { rows: [{ arrangement: null }], rowCount: 1 };
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

const want = (attributes: Record<string, unknown>) => ({
  schema_version: SCHEMA_VERSION,
  type: 'looking_for',
  category: 'goods.bicycle.mountain',
  kind: 'mountain bike',
  attributes,
  geo: { bucket: 'r3gx', radius_km: 25, reach: 'country' },
  ttl_days: 60,
});

/** The error a door threw, whichever shape it wears. */
const refusal = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
    return undefined;
  } catch (e: any) {
    if (e instanceof OsbError) {
      return {
        human_action: e.payload.human_action,
        validation: [] as string[],
        reference: e.payload.reference,
      };
    }
    return { human_action: e.message, validation: e.validation ?? [], reference: undefined };
  }
};

describe('the posting door', () => {
  beforeEach(() => {
    world = {
      sql: [],
      refs: refsFake(),
      card: {
        id: CARD,
        account_id: ACCOUNT,
        schema_version: SCHEMA_VERSION,
        type: 'WANT',
        category: 'goods.bicycle.mountain',
        category_as_posted: 'goods.bicycle.mountain',
        kind: 'mountain bike',
        geo: { bucket: 'r3gx', radius_km: 25, reach: 'country' },
        attributes: rich,
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
        sale: null,
      },
    };
    vi.spyOn(db, 'getPool').mockReturnValue(fakePool());
    vi.spyOn(db, 'dbConfigured').mockReturnValue(false);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  const wentUp = () => world.sql.some((s) => /INSERT INTO cards/.test(s.text));

  it('comes back unposted, naming the attribute to fix', async () => {
    const r = (await refusal(() =>
      publishIntent(cfg, ACCOUNT, want({ ...rich, budget: 25 })),
    ))!;
    expect(r.human_action).toBe(figureInAttributeAction('budget'));
    expect(r.validation).toEqual(['attributes.budget']);
    // Nothing went up, and nothing was written down about the attempt.
    expect(wentUp()).toBe(false);
  });

  it('takes the same want with the ceiling in the private band', async () => {
    // Where a ceiling actually goes: encrypted on the row, read by the matcher
    // and by nobody else. The figure gate asks about it once, and the same
    // posting sent again goes up.
    const card = { ...want(rich), price: { band: { max: 25 }, ccy: 'AUD' } };
    const asked = (await refusal(() => publishIntent(cfg, ACCOUNT, card)))!;
    expect(asked.human_action).toMatch(/Nothing has gone up yet/i);
    const r: any = await publishIntent(cfg, ACCOUNT, card, { reference: asked.reference });
    expect(r.intent_id).toBe(asked.reference);
  });

  it('takes a posting whose numbers are all specs', async () => {
    const r: any = await publishIntent(
      cfg,
      ACCOUNT,
      want({ ...rich, year: 2019, wheel_size_in: 29 }),
    );
    expect(r.intent_id).toBe(CARD);
  });
});

describe('the amendment door, which ran no money check at all', () => {
  beforeEach(() => {
    world = {
      sql: [],
      refs: refsFake(),
      card: {
        id: CARD,
        account_id: ACCOUNT,
        schema_version: SCHEMA_VERSION,
        type: 'WANT',
        category: 'goods.bicycle.mountain',
        category_as_posted: 'goods.bicycle.mountain',
        kind: 'mountain bike',
        geo: { bucket: 'r3gx', radius_km: 25, reach: 'country' },
        attributes: rich,
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
        sale: null,
      },
    };
    vi.spyOn(db, 'getPool').mockReturnValue(fakePool());
    vi.spyOn(db, 'dbConfigured').mockReturnValue(false);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  const changed = () => world.sql.some((s) => /UPDATE cards/.test(s.text));

  it('refuses a ceiling an amend adds, exactly as the posting door would', async () => {
    const r = (await refusal(() =>
      amendIntent(cfg, ACCOUNT, CARD, { attributes: { ...rich, budget: 25 } }),
    ))!;
    expect(r.human_action).toBe(figureInAttributeAction('budget'));
    expect(r.validation).toEqual(['attributes.budget']);
    expect(changed()).toBe(false);
  });

  /**
   * The card AS IT WILL STAND is what is read, so a figure already on the row
   * is refused by the next amend that touches the posting. That is deliberate:
   * anything posted before this door existed is still carrying the leak, and
   * the amend is the moment it can be taken off.
   */
  it('refuses an amend about something else while a ceiling sits on the row', async () => {
    world.card.attributes = { ...rich, budget: 25 };
    const r = (await refusal(() =>
      amendIntent(cfg, ACCOUNT, CARD, { urgency: 'days' }),
    ))!;
    expect(r.validation).toEqual(['attributes.budget']);
    expect(changed()).toBe(false);
  });

  it('takes an amend that adds an honest attribute', async () => {
    const r: any = await amendIntent(cfg, ACCOUNT, CARD, {
      attributes: { ...rich, wheel_size_in: 29 },
    });
    expect(r.intent_id).toBe(CARD);
  });
  /**
   * 26 September 2026: a posting's place is taken only written in full. A
   * posting that went up as "Canberra" before that keeps its place through an
   * amend about something else — the stored centre is not re-resolved — and a
   * patch that sends a new place is held to today's rule.
   */
  it('keeps the place of a posting already up, and holds a new one to the full form', async () => {
    Object.assign(world.card, {
      geo: { place: 'Canberra', bucket: 'r3dp', radius_km: 25 },
      geo_lat: -35.2835,
      geo_lon: 149.1281,
      geo_radius_km: 25,
      geo_country: 'AU',
    });
    const r: any = await amendIntent(cfg, ACCOUNT, CARD, { urgency: 'days' });
    expect(r.intent_id).toBe(CARD);
    const update = world.sql.find((q) => /UPDATE cards/.test(q.text))!;
    expect(JSON.parse(update.params[1])).toEqual({ place: 'Canberra', bucket: 'r3dp', radius_km: 25 });
    expect(update.params.slice(8, 12)).toEqual([-35.2835, 149.1281, 25, 'AU']);

    world.sql = [];
    const bare = (await refusal(() =>
      amendIntent(cfg, ACCOUNT, CARD, { geo: { place: 'Hobart', radius_km: 25 } }),
    ))!;
    expect(bare.human_action).toBe(PLACE_NOT_FULL);
    expect(changed()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AND THE PLACE IT WOULD HAVE CROSSED.
//
// The door is the only thing standing between an attribute and the other side:
// buildAttributes copies the map over whole, by design, because attributes are
// what the details step is FOR. This is what the leak looked like.
// ---------------------------------------------------------------------------

describe('what the counterparty is handed at the details step', () => {
  const MATCH = 'dddddddd-4444-4444-8444-dddddddddddd';
  const SELLER = 'cccccccc-3333-4333-8333-cccccccccccc';
  const CARD_H = 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee';

  let theirs: any;

  const intro = () =>
    ({
      id: MATCH,
      card_want: CARD,
      card_have: CARD_H,
      account_want: ACCOUNT,
      account_have: SELLER,
      category: 'goods.bicycle.mountain',
      stage: 2,
      state: 'open',
    }) as any;

  beforeEach(() => {
    theirs = {
      id: CARD,
      account_id: ACCOUNT,
      type: 'WANT',
      category: 'goods.bicycle.mountain',
      kind: 'mountain bike',
      attributes: { ...rich, budget: 25 },
      ask: null,
      sale: null,
      price_enc: Buffer.from('sealed'),
      lifecycle_state: 'PUBLISHED',
    };
    vi.spyOn(db, 'getPool').mockReturnValue({
      query: async (sql: string) =>
        /FROM cards WHERE id/.test(sql) || /SELECT \* FROM cards/.test(sql)
          ? { rows: [theirs], rowCount: 1 }
          : { rows: [], rowCount: 0 },
    } as any);
  });

  it('hands over every attribute whole, which is why the door has to hold', async () => {
    const p: any = await buildAttributes(intro(), SELLER);
    expect(p.attributes).toEqual({ ...rich, budget: 25 });
    expect(JSON.stringify(p)).toContain('25');
  });

  it('carries nothing of the ceiling once the door has done its work', async () => {
    theirs.attributes = rich;
    const p: any = await buildAttributes(intro(), SELLER);
    const wire = JSON.stringify(p);
    expect(wire).not.toContain('budget');
    expect(wire).not.toContain('25');
  });
});
