/**
 * A SELLER'S RESERVE IS NOT AN ASKING PRICE.
 *
 * The defect this suite holds shut (dev rehearsal, 20 September 2026). A man
 * was selling by BEST OFFER — everyone who fits puts in one sealed figure. His
 * assistant asked him the right question, "what's your floor, the minimum
 * you'd take?", was told ten dollars, and then told him, in its own words,
 * that "that becomes the asking price everyone's sealed offers get measured
 * against". It posted the ten dollars as the posting's `ask`, which is the one
 * money field on a want or a have that is DISCLOSABLE, so the switchboard
 * carried it across at the details step exactly as it is meant to, and the
 * buyer's assistant read it out: "Their asking price: $10 AUD. That's well
 * under your $25 ceiling."
 *
 * Nothing misbehaved. On a straight sale an asking price is a term the seller
 * chose to state and crossing early is the whole point of it. On a best offer
 * there is no asking price at all — the arrangement is that nobody sees a
 * number until the seller sees them all — so "where does the floor go?" was a
 * question nothing answered, and `ask` was a reasonable guess at it.
 *
 * So the door answers it. A best-offer sale may not carry an `ask`, on a
 * publish or on an amend, and the refusal says in one sentence where the
 * figure belongs and what happens to it there. The rules asserted here:
 *
 *  - a best offer posted with an asking price comes back unposted, under its
 *    own plain word, with the sentence that teaches the rule;
 *  - the same posting with the figure in the private band goes up;
 *  - a straight sale with an asking price is untouched, because that is what
 *    an asking price is for;
 *  - an amend cannot reach the same state from either side: adding the ask, or
 *    turning a straight sale into a best offer while an ask sits on the row;
 *  - the floor is refused before the figure gate, so nobody is asked to read
 *    "your asking price" back to a human on a posting that may not carry one;
 *  - AND THE END OF IT: a best-offer floor cannot reach the counterparty
 *    payload, which is where the ten dollars actually crossed.
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
import { FLOOR_IS_PRIVATE_ACTION, amendIntent, publishIntent } from '../../src/domain/cards.js';
import { buildAttributes } from '../../src/domain/matches.js';
import { EXPECTED_REFUSALS, protocolAnswer } from '../../src/mcp/tools.js';
import { OsbError, SCHEMA_VERSION, validatePayload } from '../../src/protocol.js';
import { lintHumanCopy } from '../../src/email/lint.js';
import type { Config } from '../../src/config.js';
import { refsFake, type RefsFake } from './postingRefsFake.js';

const cfg = {
  quotas: { maxOpenCards: 20, maxPublishesPerDay: 20 },
  screeningQueueUrl: 'https://queue.test/screening',
} as unknown as Config;

const ACCOUNT = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const CARD = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

// Enough to describe the thing to a stranger: this suite is about money, and
// the detail gate is next door with its own suite.
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

interface World {
  sql: { text: string; params: any[] }[];
  /** The open posting attempts, and the gates that have asked on each. */
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
      sale: 'straight',
    },
  };
  vi.spyOn(db, 'getPool').mockReturnValue(fakePool());
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

const refusal = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
    return undefined;
  } catch (e) {
    if (e instanceof OsbError) return e.payload;
    throw e;
  }
};

const wentUp = () => world.sql.some((s) => /INSERT INTO cards/.test(s.text));

// ---------------------------------------------------------------------------
// The door.
// ---------------------------------------------------------------------------
describe('a best offer carries no asking price', () => {
  it('comes back unposted, saying where the floor belongs and what happens there', async () => {
    const p = (await refusal(() =>
      publishIntent(cfg, ACCOUNT, listing({ sale: 'best-offer', ask: { amount: 10, ccy: 'AUD' } })),
    ))!;
    expect(p.code).toBe('FLOOR_IS_PRIVATE');
    expect(p.human_action).toBe(FLOOR_IS_PRIVATE_ACTION);
    // The four things the sentence has to say, because the assistant that got
    // this wrong had been told none of them.
    expect(p.human_action).toMatch(/floor is private/i);
    expect(p.human_action).toMatch(/nobody is ever shown it/i);
    expect(p.human_action).toMatch(/refused before it travels/i);
    expect(p.human_action).toMatch(/`price`/);
    // Nothing went up, and nothing was written down about the attempt.
    expect(wentUp()).toBe(false);
  });

  it('says it inside the cap, in words nobody would mind overhearing', () => {
    expect(FLOOR_IS_PRIVATE_ACTION.length).toBeLessThanOrEqual(300);
    expect(lintHumanCopy(FLOOR_IS_PRIVATE_ACTION)).toEqual([]);
  });

  it('is an answer rather than a failure, with a plain word of its own', () => {
    expect(EXPECTED_REFUSALS.FLOOR_IS_PRIVATE).toBe('floor_is_private');
    const r: any = protocolAnswer(
      new OsbError('FLOOR_IS_PRIVATE', { human_action: FLOOR_IS_PRIVATE_ACTION }).payload,
    );
    expect(r.isError).toBe(false);
    expect(r.structuredContent.what_happened).toBe('floor_is_private');
    expect(r.structuredContent.code).toBe('FLOOR_IS_PRIVATE');
  });

  it('takes the same posting with the figure in the private band', async () => {
    const card = listing({ sale: 'best-offer', price: { band: { min: 10 }, ccy: 'AUD' } });
    // The figure gate first, as it is for any posting carrying a number: the
    // assistant says it to its human and sends the same posting again.
    const asked = (await refusal(() => publishIntent(cfg, ACCOUNT, card)))!;
    expect(asked.code).toBe('CONFIRM_FIGURE');
    const r: any = await publishIntent(cfg, ACCOUNT, card, { reference: asked.reference });
    // The posting keeps the number the question was asked under.
    expect(r.intent_id).toBe(asked.reference);
    // And the band went to the encrypted column rather than to `ask`.
    const insert = world.sql.find((s) => /INSERT INTO cards/.test(s.text))!;
    expect(insert.params).toContain('best-offer');
    expect(insert.params.filter((v) => v === null).length).toBeGreaterThan(0);
  });

  it('leaves a straight sale with an asking price exactly as it was', async () => {
    const card = listing({ sale: 'straight', ask: { amount: 620, ccy: 'AUD' } });
    const asked = (await refusal(() => publishIntent(cfg, ACCOUNT, card)))!;
    expect(asked.code).toBe('CONFIRM_FIGURE');
    const r: any = await publishIntent(cfg, ACCOUNT, card, { reference: asked.reference });
    expect(r.intent_id).toBe(asked.reference);
  });

  it('holds a posting that says nothing about the sale, which is a straight one', async () => {
    const r: any = await publishIntent(cfg, ACCOUNT, listing());
    expect(r.intent_id).toBe(CARD);
  });

  /**
   * ONE REFUSAL PER ATTEMPT, and this one is first. The figure gate reads an
   * `ask` back to the human in the words "your asking price" — which is the
   * very sentence that started this, so it must not be the answer to a posting
   * whose asking price is not allowed to exist.
   */
  it('answers the floor before it reads any figure back', async () => {
    const p = (await refusal(() =>
      publishIntent(cfg, ACCOUNT, listing({ sale: 'best-offer', ask: { amount: 10, ccy: 'AUD' } })),
    ))!;
    expect(p.code).toBe('FLOOR_IS_PRIVATE');
    expect(p.figures).toBeUndefined();
    expect(p.questions).toBeUndefined();
    // The attempt has its number, as every refusal does — but NO gate is
    // written down against it, so answering the real question later is not
    // silently excused by this refusal.
    expect(p.reference).toBeTruthy();
    expect(world.refs.asked(p.reference)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The same state, reached the other ways.
// ---------------------------------------------------------------------------
describe('an amend cannot put the floor back in the open', () => {
  it('refuses an asking price added to a best offer', async () => {
    world.card.sale = 'best-offer';
    const p = (await refusal(() =>
      amendIntent(cfg, ACCOUNT, CARD, { ask: { amount: 10, ccy: 'AUD' } }),
    ))!;
    expect(p.code).toBe('FLOOR_IS_PRIVATE');
  });

  it('refuses a straight sale turned into a best offer with its ask still on it', async () => {
    world.card.sale = 'straight';
    world.card.ask = { amount: 620, ccy: 'AUD' };
    const p = (await refusal(() => amendIntent(cfg, ACCOUNT, CARD, { sale: 'best-offer' })))!;
    expect(p.code).toBe('FLOOR_IS_PRIVATE');
  });

  it('takes the two moves made together, which is the whole of the fix', async () => {
    world.card.sale = 'straight';
    world.card.ask = { amount: 620, ccy: 'AUD' };
    const r: any = await amendIntent(cfg, ACCOUNT, CARD, { sale: 'best-offer', ask: null });
    expect(r.intent_id).toBe(CARD);
  });

  it('leaves an amend on a straight sale alone', async () => {
    world.card.ask = { amount: 620, ccy: 'AUD' };
    const r: any = await amendIntent(cfg, ACCOUNT, CARD, { urgency: 'days' });
    expect(r.intent_id).toBe(CARD);
  });
});

// ---------------------------------------------------------------------------
// THE BUYER'S SIDE, which is where the ceiling lives.
// ---------------------------------------------------------------------------
describe('a budget ceiling has no route of its own', () => {
  /**
   * The mirror of the hole that was fixed. A want's ceiling cannot become a
   * public asking price because a want has no `ask` AT ALL: the protocol
   * document closes both `ask` and `sale` on looking_for, so there is no field
   * to guess wrong about. The only money a want carries is the private band,
   * which is encrypted on the row and read nowhere but inside the engine.
   */
  it('refuses an asking price on a want outright, at the schema', () => {
    const want = {
      schema_version: SCHEMA_VERSION,
      type: 'looking_for',
      category: 'goods.bicycle.mountain',
      geo: { bucket: 'r3gx', radius_km: 25, reach: 'country' },
      ask: { amount: 25, ccy: 'AUD' },
    };
    const v = validatePayload('intent-card', want);
    expect(v.valid).toBe(false);
    expect(v.plain.join(' ')).toMatch(/ask/);
  });

  it('refuses a kind of sale on one too, so there is nothing to carry a floor', () => {
    const want = {
      schema_version: SCHEMA_VERSION,
      type: 'looking_for',
      category: 'goods.bicycle.mountain',
      geo: { bucket: 'r3gx', radius_km: 25, reach: 'country' },
      sale: 'best-offer',
    };
    expect(validatePayload('intent-card', want).valid).toBe(false);
  });

  it('takes the ceiling in the private band, which is the only place it goes', async () => {
    const want = listing({
      type: 'looking_for',
      sale: undefined,
      price: { band: { max: 25 }, ccy: 'AUD' },
    });
    delete (want as any).sale;
    const asked = (await refusal(() => publishIntent(cfg, ACCOUNT, want)))!;
    expect(asked.code).toBe('CONFIRM_FIGURE');
    const r: any = await publishIntent(cfg, ACCOUNT, want, { reference: asked.reference });
    expect(r.intent_id).toBe(asked.reference);
    // It went to the encrypted column and to nothing else: `ask` on the insert
    // is null, and the band itself is a sealed buffer.
    const insert = world.sql.find((s) => /INSERT INTO cards/.test(s.text))!;
    expect(insert.params.some((v) => typeof v === 'string' && v.includes('"max":25'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AND THE PLACE IT ACTUALLY CROSSED.
// ---------------------------------------------------------------------------
describe('what the counterparty is handed at the details step', () => {
  const MATCH = 'dddddddd-4444-4444-8444-dddddddddddd';
  const BUYER = 'cccccccc-3333-4333-8333-cccccccccccc';
  const CARD_W = 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee';

  /** The seller's have, as the row holds it, for the buyer to be shown. */
  let theirs: any;

  const intro = () =>
    ({
      id: MATCH,
      card_want: CARD_W,
      card_have: CARD,
      account_want: BUYER,
      account_have: ACCOUNT,
      category: 'goods.bicycle.mountain',
      stage: 2,
      state: 'open',
    }) as any;

  beforeEach(() => {
    theirs = {
      id: CARD,
      account_id: ACCOUNT,
      type: 'HAVE',
      category: 'goods.bicycle.mountain',
      kind: 'mountain bike',
      attributes: rich,
      ask: null,
      sale: 'best-offer',
      // The seller's reserve, sealed on the row the way it always was.
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

  it('carries no asking price across on a best offer, and no floor anywhere in it', async () => {
    const p: any = await buildAttributes(intro(), BUYER);
    expect(p.ask).toBeUndefined();
    // The whole payload, read as the buyer's agent would read it: no figure of
    // the seller's is anywhere in it, under any name.
    const wire = JSON.stringify(p);
    expect(wire).not.toContain('"ask"');
    expect(wire).not.toContain('price');
    expect(wire).not.toContain('10');
    // What it does carry is what it is for: the other side's own words.
    expect(p.attributes).toEqual(rich);
  });

  it('still carries the asking price on a straight sale, which is what it is for', async () => {
    theirs.sale = 'straight';
    theirs.ask = { amount: 620, ccy: 'AUD' };
    const p: any = await buildAttributes(intro(), BUYER);
    expect(p.ask).toEqual({ amount: 620, ccy: 'AUD' });
  });

  /**
   * The belt under the braces. Even a row that somehow held both — one posted
   * before the door started refusing them — must not read its reserve out. The
   * reserve is the encrypted band and the payload has no slot for one: the
   * outbound document is additionalProperties:false and buildAttributes
   * validates against it, so this is structural rather than a habit.
   */
  it('has nowhere to put a price band even if something tried', async () => {
    const p: any = await buildAttributes(intro(), BUYER);
    expect(
      validatePayload('intro.attributes', { ...p, price: { band: { min: 10 }, ccy: 'AUD' } }).valid,
    ).toBe(false);
  });
});
