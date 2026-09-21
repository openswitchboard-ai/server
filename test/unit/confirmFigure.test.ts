/**
 * A FIGURE COMES BACK ONCE, AND THE NOTE AFTER POSTING IS A FACT.
 *
 * Two slips from the automated rehearsal suite, both of them recurring while
 * the rule was already in front of the assistant:
 *
 *  (a) a human said "not sure what my budget is, what do these usually go
 *      for?" and their assistant searched the web and posted a private band of
 *      "up to $45 AUD". Nobody outside can ever see a band, so nobody could
 *      ever have corrected it;
 *  (b) an assistant said "I'll check back shortly and let you know the moment
 *      someone comes forward, no need to keep asking me" with nothing
 *      scheduled and no arrangement saved.
 *
 * So the door enforces both, the way NEEDS_DETAIL already enforces a thin
 * posting. A figure is read back once before it can decide anything, and the
 * sentence handed over after posting is read off what is actually saved on the
 * account rather than stated as a rule for the assistant to apply to itself.
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
import { amendIntent, publishIntent, whatHappensNextNote } from '../../src/domain/cards.js';
import { SENTENCES } from '../../src/domain/lanes.js';
import {
  figureAmountsKey,
  figureQuestions,
  figuresOnPosting,
} from '../../src/domain/postingFigure.js';
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
// The rule itself, read one posting at a time.
// ---------------------------------------------------------------------------
describe('which figures a posting carries', () => {
  it('reads the asking price and the band bound that belongs to the side', () => {
    expect(
      figuresOnPosting({ type: 'offering', ask: { amount: 620, ccy: 'AUD' } }),
    ).toEqual([{ what: 'asking price', amount: 620, currency: 'AUD' }]);
    // A want's band is a ceiling: the most they would pay.
    expect(figuresOnPosting({ type: 'looking_for', price: { band: { max: 45 }, ccy: 'AUD' } })).toEqual([
      { what: 'the most they will pay', amount: 45, currency: 'AUD' },
    ]);
    // A have's band is a floor, and a floor written as a point is one figure.
    expect(
      figuresOnPosting({ type: 'offering', price: { band: { min: 10, max: 10 }, ccy: 'AUD' } }),
    ).toEqual([{ what: 'the least they will take', amount: 10, currency: 'AUD' }]);
  });

  it('finds nothing on a posting that states no money', () => {
    expect(figuresOnPosting({ type: 'offering' })).toEqual([]);
    expect(figuresOnPosting({ type: 'offering', ask: null, price: null })).toEqual([]);
    expect(figuresOnPosting({ type: 'offering', price: { band: {}, ccy: 'AUD' } })).toEqual([]);
  });

  it('keys on the figures as they were read back, and never on the words', () => {
    const at = (max: number) =>
      figuresOnPosting({ type: 'looking_for', price: { band: { max }, ccy: 'AUD' } });
    expect(figureAmountsKey(at(45))).toBe('the most they will pay|45|AUD');
    // A changed number is a changed key, which is the whole of what the
    // read-back is for: nobody has confirmed forty dollars.
    expect(figureAmountsKey(at(45))).not.toBe(figureAmountsKey(at(40)));
    // So is a changed currency: "$45 AUD" and "$45 USD" are not one question.
    expect(figureAmountsKey(at(45))).not.toBe(
      figureAmountsKey(figuresOnPosting({ type: 'looking_for', price: { band: { max: 45 }, ccy: 'USD' } })),
    );
    // The order two figures arrive in is not a difference.
    const two = [
      { what: 'asking price', amount: 620, currency: 'AUD' },
      { what: 'the least they will take', amount: 500, currency: 'AUD' },
    ];
    expect(figureAmountsKey(two)).toBe(figureAmountsKey([...two].reverse()));
    // AND NOT ONE WORD OF THE THING IS IN IT. The detail gate beside this one
    // asks the assistant to say more exactly what the thing is, so the words
    // move between one attempt and the next; keying on them made the read-back
    // unanswerable and looped four times with nothing posted (21 September
    // 2026). Which posting this is, is the reference's job, not this key's.
    expect(figureAmountsKey(at(45))).not.toMatch(/spring|bike/i);
  });

  it('asks the human in their own words, one question per figure', () => {
    const qs = figureQuestions(
      figuresOnPosting({ type: 'looking_for', price: { band: { max: 45 }, ccy: 'AUD' } }),
    );
    expect(qs).toEqual([
      'Is $45 AUD the figure you gave as the most you would pay, or is it one I put there myself?',
    ]);
    for (const q of qs) {
      expect(q.endsWith('?'), q).toBe(true);
      expect(lintHumanCopy(q), q).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// The door.
// ---------------------------------------------------------------------------
interface World {
  sql: { text: string; params: any[] }[];
  logs: string[];
  /** The open posting attempts, and the gates that have asked on each. */
  refs: RefsFake;
  arrangement: Record<string, unknown> | null;
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
        return { rows: [{ arrangement: world.arrangement }], rowCount: 1 };
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

/** Enough to describe the thing to a stranger: this suite is about money. */
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
    logs: [],
    refs: refsFake(),
    arrangement: null,
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
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    world.logs.push(args.map(String).join(' '));
  });
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

const publishRefusal = (
  card: any,
  opts?: { detailUnknown?: boolean; reference?: unknown },
) => refusal(() => publishIntent(cfg, ACCOUNT, card, opts ?? {}));

describe('a figure on a posting is read back once', () => {
  it('comes back unposted, with the figure in words and the question to ask', async () => {
    const p = (await publishRefusal(listing({ price: { band: { min: 10 }, ccy: 'AUD' } })))!;
    expect(p.code).toBe('CONFIRM_FIGURE');
    expect(p.figures).toEqual([{ what: 'the least they will take', amount: 10, currency: 'AUD' }]);
    expect(p.questions![0]).toContain('$10 AUD');
    expect(p.human_action).toContain('post again only if those were their own words');
    expect(p.human_action).toContain('no figure');
    expect(lintHumanCopy(p.human_action!)).toEqual([]);
    expect(p.docs_url).toContain('CONFIRM_FIGURE');
    // Nothing went up.
    expect(world.sql.some((s) => /INSERT INTO cards/.test(s.text))).toBe(false);
  });

  it('lets the same figure through on the second attempt, untouched', async () => {
    const band = { band: { max: 45 }, ccy: 'AUD' };
    const want = listing({ type: 'looking_for', price: band, attributes: { brand: 'trek' } });
    const asked = (await publishRefusal(want))!;
    expect(asked.code).toBe('CONFIRM_FIGURE');
    const r: any = await publishIntent(cfg, ACCOUNT, want, { reference: asked.reference });
    // And it goes up under the number the question was asked under.
    expect(r.intent_id).toBe(asked.reference);
  });

  it('asks again on a posting that carries no reference back', async () => {
    // A fresh attempt is a fresh question, whatever the number on it. That is
    // the whole of the fallback: no reference, so nobody has been asked.
    const want = (max: number) =>
      listing({
        type: 'looking_for',
        attributes: { brand: 'trek' },
        price: { band: { max }, ccy: 'AUD' },
      });
    expect((await publishRefusal(want(45)))?.code).toBe('CONFIRM_FIGURE');
    const p = (await publishRefusal(want(40)))!;
    expect(p.code).toBe('CONFIRM_FIGURE');
    expect(p.figures![0].amount).toBe(40);
  });

  it('leaves a posting with no figure on it alone', async () => {
    const r: any = await publishIntent(cfg, ACCOUNT, listing());
    expect(r.intent_id).toBe(CARD);
    expect(world.sql.some((s) => /posting_references/.test(s.text))).toBe(false);
  });

  it('writes down the number, the account, the gate and the figure it read back', async () => {
    const p = (await publishRefusal(listing({ ask: { amount: 620, ccy: 'AUD' } })))!;
    const asked = world.sql.find((s) => /INSERT INTO posting_references/.test(s.text))!;
    expect(asked.params[0]).toBe(p.reference);
    expect(asked.params[1]).toBe(ACCOUNT);
    expect(asked.params[2]).toEqual(['figure']);
    // The figure as it was said to the human, so a changed one is asked about
    // again. The thing's own words are the one thing that is never in here.
    expect(asked.params[3]).toBe('asking price|620|AUD');
    expect(asked.params[3]).not.toContain('mountain bike');
    // And the amounts stay out of the log, wherever else they go.
    expect(world.logs.join('\n')).not.toContain('620');
  });
});

describe('an amend that moves the money', () => {
  it('asks about an asking price the patch adds, then takes it', async () => {
    const patch = { ask: { amount: 620, ccy: 'AUD' } };
    const p = (await refusal(() => amendIntent(cfg, ACCOUNT, CARD, patch)))!;
    expect(p.code).toBe('CONFIRM_FIGURE');
    expect(p.figures).toEqual([{ what: 'asking price', amount: 620, currency: 'AUD' }]);
    const r: any = await amendIntent(cfg, ACCOUNT, CARD, patch);
    expect(r.intent_id).toBe(CARD);
  });

  it('asks about a band the patch adds, because the stored one cannot be read', async () => {
    const p = (await refusal(() =>
      amendIntent(cfg, ACCOUNT, CARD, { price: { band: { min: 300 }, ccy: 'AUD' } }),
    ))!;
    expect(p.code).toBe('CONFIRM_FIGURE');
    expect(p.figures![0].what).toBe('the least they will take');
  });

  it('leaves an amend that touches no figure alone', async () => {
    const r: any = await amendIntent(cfg, ACCOUNT, CARD, { urgency: 'days' });
    expect(r.intent_id).toBe(CARD);
    expect(world.sql.some((s) => /INSERT INTO posting_references/.test(s.text))).toBe(false);
  });

  it('leaves an amend that resends the asking price it already had alone', async () => {
    world.card.ask = { amount: 620, ccy: 'AUD' };
    const r: any = await amendIntent(cfg, ACCOUNT, CARD, { ask: { amount: 620, ccy: 'AUD' } });
    expect(r.intent_id).toBe(CARD);
    expect(world.sql.some((s) => /INSERT INTO posting_references/.test(s.text))).toBe(false);
  });
});

/**
 * ONE REFUSAL PER ATTEMPT. The three cheap refusals run in a fixed order —
 * detail, then reach, then figure — so an assistant holding a posting that is
 * short on all three is never handed two different answers to the same call.
 */
describe('the order of the cheap refusals', () => {
  it('answers detail first, then reach, then the figure, one at a time', async () => {
    const thin = (over: Record<string, unknown> = {}) =>
      listing({
        attributes: {},
        geo: { bucket: 'r3gx', radius_km: 8, reach: 'radius' },
        price: { band: { min: 10 }, ccy: 'AUD' },
        ...over,
      });

    const first = (await publishRefusal(thin()))!;
    expect(first.code).toBe('NEEDS_DETAIL');
    expect(first.questions!.join(' ')).toContain('make and model');
    const reference = first.reference;
    expect(reference).toBeTruthy();

    // The detail answered: now the one question about how far it goes. Every
    // answer after the first carries the number the first one minted.
    const second = (await publishRefusal(thin({ attributes: rich }), { reference }))!;
    expect(second.code).toBe('NEEDS_DETAIL');
    expect(second.questions!.join(' ')).toContain('pick-up only');
    expect(second.reference).toBe(reference);

    // And only then the figure.
    const third = (await publishRefusal(thin({ attributes: rich }), { reference }))!;
    expect(third.code).toBe('CONFIRM_FIGURE');
    expect(third.reference).toBe(reference);

    const r: any = await publishIntent(cfg, ACCOUNT, thin({ attributes: rich }), { reference });
    // And the posting keeps the number it was asked about all along.
    expect(r.intent_id).toBe(reference);
  });
});

// ---------------------------------------------------------------------------
// The sentence after posting.
// ---------------------------------------------------------------------------
describe('what happens next, read off this account', () => {
  it('tells an account with nothing saved to promise nothing', async () => {
    const r: any = await publishIntent(cfg, ACCOUNT, listing());
    const text = r.what_happens_next_note.text;
    expect(r.what_happens_next_note.provenance).toBe('switchboard-system');
    expect(text).toContain('have not agreed how often you check');
    expect(text).toContain('the switchboard will email you');
    expect(text).toContain('standing_arrangement');
    expect(text).toContain('their own clock');
  });

  it('says the rhythm back where one is saved, as the thing already agreed', async () => {
    world.arrangement = { runs_on_its_own: true, check_every_minutes: 60 };
    for (const r of [
      (await publishIntent(cfg, ACCOUNT, listing())) as any,
      (await amendIntent(cfg, ACCOUNT, CARD, { urgency: 'days' })) as any,
    ]) {
      const text = r.what_happens_next_note.text;
      expect(text).toContain('already agreed you look every hour');
      expect(text).toContain('follow-up on this posting');
      expect(text).toContain('nothing to do with that rhythm');
      expect(text).toContain('their own clock');
      expect(text).not.toContain('email');
    }
  });

  it('holds a cadence with nobody to keep it to the unsaved note', async () => {
    // A cadence without runs_on_its_own is a schedule nobody keeps, and the
    // validator refuses one; a row that somehow holds it promises nothing.
    world.arrangement = { check_every_minutes: 60 };
    const r: any = await publishIntent(cfg, ACCOUNT, listing());
    expect(r.what_happens_next_note.text).toContain('have not agreed how often you check');
  });

  it('keeps every wording of it inside the house register and the budget', () => {
    for (const minutes of [30, 60, 120, 720, 1440, 10080, 45]) {
      const note = whatHappensNextNote({ runs_on_its_own: true, check_every_minutes: minutes });
      expect(lintHumanCopy(note.text), String(minutes)).toEqual([]);
      expect(note.text.length, String(minutes)).toBeLessThanOrEqual(
        SENTENCES.after_posting.budget,
      );
    }
    const none = whatHappensNextNote({});
    expect(lintHumanCopy(none.text)).toEqual([]);
    expect(none.text.length).toBeLessThanOrEqual(SENTENCES.after_posting.budget);
    // An agent that runs on its own with no cadence agreed has agreed nothing.
    expect(whatHappensNextNote({ runs_on_its_own: true }).text).toContain(
      'have not agreed how often you check',
    );
  });
});
