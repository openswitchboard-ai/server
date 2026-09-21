/**
 * THE LOOP THAT MADE A POSTING IMPOSSIBLE, AND THE NUMBER THAT ENDED IT.
 *
 * Three times in one day of rehearsals (21 September 2026). A posting that came
 * back with a question was remembered by a fingerprint built out of the agent's
 * own prose — the poster's words for the thing, and the amounts on it — while
 * the other questions in the same flow asked the agent to reword that very
 * thing. So:
 *
 *   the agent posts "upgraded Fanatec pedal spring, $10";
 *   the switchboard asks whether the ten dollars is the human's own figure;
 *   the agent asks its human, is told yes, and posts again — now worded
 *     "Fanatec ClubSport V3 brake performance spring, $10", because the detail
 *     question beside it asked for exactly that;
 *   the switchboard does not recognise it and asks the same question again.
 *
 * Four rounds, and then the agent told its human the thing was posted when
 * nothing had gone up at all.
 *
 * What this suite holds the door to:
 *
 *   - the reword above goes through, and NOTHING is asked twice;
 *   - the reference is minted on the FIRST thing said back about an attempt,
 *     and every later answer about that attempt carries the same one;
 *   - it is the only key: no words, no amounts, no time window;
 *   - it becomes the posting's own id, so there is never a second number;
 *   - somebody else's reference reads as no reference at all;
 *   - the row is forgotten the moment the attempt succeeds, on a publish and
 *     on an amend alike;
 *   - nothing about the thing or its money is written into the row.
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
import { POSTING_REF_SWEEP_DAYS, referenceOf } from '../../src/domain/postingRef.js';
import { OsbError, SCHEMA_VERSION } from '../../src/protocol.js';
import type { Config } from '../../src/config.js';
import { refsFake, type RefsFake } from './postingRefsFake.js';

const cfg = {
  quotas: { maxOpenCards: 20, maxPublishesPerDay: 20 },
  screeningQueueUrl: 'https://queue.test/screening',
} as unknown as Config;

const ACCOUNT = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const STRANGER = 'cccccccc-3333-4333-8333-cccccccccccc';
const CARD = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

interface World {
  sql: { text: string; params: any[] }[];
  logs: string[];
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
      if (/SELECT arrangement FROM accounts/.test(sql)) return { rows: [{ arrangement: null }], rowCount: 1 };
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

/**
 * The spring itself, exactly as the rehearsal's assistant first wrote it: a
 * have, thin on attributes, with ten dollars on it as a private floor.
 */
const spring = (over: Record<string, unknown> = {}) => ({
  schema_version: SCHEMA_VERSION,
  type: 'offering',
  category: 'goods.electronics.console.sim-racing',
  kind: 'upgraded Fanatec pedal spring',
  attributes: {},
  geo: { bucket: 'r3gx', radius_km: 25, reach: 'country' },
  price: { band: { min: 10 }, ccy: 'AUD' },
  ttl_days: 60,
  ...over,
});

/**
 * What the assistant knows once it has asked: the sharper words, and the facts.
 * Not one word of the first attempt's `kind` survives except the brand, which
 * is the whole point — this is the reword that used to end the conversation.
 */
const REWORDED = 'Fanatec ClubSport V3 brake performance spring';
const KNOWN = { brand: 'fanatec', fits: 'ClubSport V3 pedals', condition: 'good' };

beforeEach(() => {
  world = {
    sql: [],
    logs: [],
    refs: refsFake(),
    card: {
      id: CARD,
      account_id: ACCOUNT,
      schema_version: SCHEMA_VERSION,
      type: 'HAVE',
      category: 'goods.electronics.console.sim-racing',
      category_as_posted: 'goods.electronics.console.sim-racing',
      kind: 'upgraded Fanatec pedal spring',
      geo: { bucket: 'r3gx', radius_km: 25, reach: 'country' },
      attributes: KNOWN,
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

const post = async (card: any, opts: Record<string, unknown> = {}) => {
  try {
    return { posted: (await publishIntent(cfg, ACCOUNT, card, opts)) as any, refusal: undefined };
  } catch (e) {
    if (e instanceof OsbError) return { posted: undefined, refusal: e.payload };
    throw e;
  }
};

// ---------------------------------------------------------------------------
// The rehearsal, run again.
// ---------------------------------------------------------------------------
describe('the pedal spring, posted the way the rehearsal posted it', () => {
  it('asks each question once, through a total reword, and puts the thing up', async () => {
    // ROUND ONE. Thin, so the detail gate answers first, and the answer carries
    // the number this whole attempt will be known by.
    const first = (await post(spring())).refusal!;
    expect(first.code).toBe('NEEDS_DETAIL');
    const reference = first.reference!;
    expect(referenceOf(reference)).toBe(reference);

    // ROUND TWO. The assistant asks its human, learns what the thing actually
    // is, and does the one thing that used to end the conversation: it REWORDS
    // the thing entirely. Same attempt, same number.
    const second = (
      await post(spring({ kind: REWORDED, attributes: KNOWN }), { reference })
    ).refusal!;
    expect(second.code).toBe('CONFIRM_FIGURE');
    expect(second.reference).toBe(reference);
    // And the detail question is not asked a second time.
    expect(second.questions!.join(' ')).not.toContain('make and model');

    // ROUND THREE. The human confirms the ten dollars. The words move again —
    // an assistant is free to keep sharpening them — and it goes up.
    const third = await post(spring({ kind: `${REWORDED} OEM`, attributes: KNOWN }), {
      reference,
    });
    expect(third.refusal?.code).toBeUndefined();

    // THE WHOLE POINT: the same question was never asked twice, and the thing
    // is actually up. Two refusals, then a posting.
    expect(third.posted.state).toBe('PENDING_SCREENING');
    // And it went up under the number it was asked about from the first word.
    expect(third.posted.intent_id).toBe(reference);
  });

  it('asks the same questions again where nothing carried the number back', async () => {
    // The fallback, and the whole of it: no reference, so this is a new
    // attempt and every question is put again. No time window softens it.
    const first = (await post(spring())).refusal!;
    expect(first.code).toBe('NEEDS_DETAIL');
    const second = (await post(spring({ kind: REWORDED, attributes: KNOWN }))).refusal!;
    expect(second.code).toBe('CONFIRM_FIGURE');
    const third = (await post(spring({ kind: REWORDED, attributes: KNOWN }))).refusal!;
    expect(third.code).toBe('CONFIRM_FIGURE');
    expect(third.reference).not.toBe(second.reference);
  });
});

// ---------------------------------------------------------------------------
// The number itself.
// ---------------------------------------------------------------------------
describe('the reference', () => {
  it('is minted on the first thing said back, whatever the first thing is', async () => {
    // A best offer with an asking price on it never reaches the three gates —
    // it is refused before them — and it still comes back with a number, so
    // the attempt has one from the very first word.
    const p = (
      await post(spring({ sale: 'best-offer', ask: { amount: 10, ccy: 'AUD' }, price: undefined }))
    ).refusal!;
    expect(p.code).toBe('FLOOR_IS_PRIVATE');
    expect(referenceOf(p.reference)).toBe(p.reference);
    // But no gate is marked, because no gate asked anything.
    expect(world.refs.asked(p.reference)).toEqual([]);
  });

  it('holds nothing about the thing and nothing about the money', async () => {
    const p = (await post(spring())).refusal!;
    const writes = world.sql.filter((s) => /INTO posting_references/.test(s.text));
    expect(writes.length).toBeGreaterThan(0);
    for (const w of writes) {
      // The number, the account, and the gates that asked. That is the row.
      expect(w.params).toEqual([p.reference, ACCOUNT, ['detail']]);
    }
    // The old row carried the poster's own words for the thing, because the
    // words WERE the key. Nothing here does, and nothing here ever sees a price.
    const text = JSON.stringify(writes.map((w) => w.params));
    expect(text).not.toMatch(/spring|Fanatec|pedal/i);
    expect(world.logs.join('\n')).not.toMatch(/Fanatec/i);
  });

  it('reads as no reference at all when it is somebody else’s', async () => {
    const mine = (await post(spring())).refusal!.reference!;
    // The same number, now standing against another account. The read is by
    // reference AND account, so this matches nothing and the gate asks again.
    world.refs.rows.get(mine)!.account_id = STRANGER;
    const p = (await post(spring({ kind: REWORDED }), { reference: mine })).refusal!;
    expect(p.code).toBe('NEEDS_DETAIL');
    expect(p.reference).not.toBe(mine);
  });

  it('ignores anything that is not one', async () => {
    for (const junk of ['', '  ', 'mountain bike', '1234', null, 42, {}]) {
      expect(referenceOf(junk)).toBeUndefined();
    }
    // Case and surrounding space are forgiven; the number is the number.
    expect(referenceOf(`  ${CARD.toUpperCase()} `)).toBe(CARD);
  });

  it('is forgotten the moment the posting goes up', async () => {
    const asked = (await post(spring())).refusal!.reference!;
    expect(world.refs.rows.has(asked)).toBe(true);
    await post(spring({ kind: REWORDED, attributes: KNOWN }), { reference: asked });
    await post(spring({ kind: REWORDED, attributes: KNOWN }), { reference: asked });
    // The number lives on as the posting's id; the memory of what was asked
    // does not, so it can never excuse a question on something else.
    expect(world.refs.rows.has(asked)).toBe(false);
  });

  it('is kept for a week for an attempt nobody came back to finish', () => {
    expect(POSTING_REF_SWEEP_DAYS).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// An amend, which needs no number of its own.
// ---------------------------------------------------------------------------
describe('an amend shares the posting’s number', () => {
  it('reads a figure back under the posting’s own id, and asks the next one again', async () => {
    const patch = { ask: { amount: 620, ccy: 'AUD' } };
    const asked = (
      await (async () => {
        try {
          await amendIntent(cfg, ACCOUNT, CARD, patch);
          return { refusal: undefined as any };
        } catch (e) {
          if (e instanceof OsbError) return { refusal: e.payload };
          throw e;
        }
      })()
    ).refusal!;
    expect(asked.code).toBe('CONFIRM_FIGURE');
    // The number IS the posting's id: nothing new to send, nothing new to hold.
    expect(asked.reference).toBe(CARD);
    expect(world.refs.asked(CARD)).toEqual(['figure']);

    // Said to the human, sent again, through it goes.
    const done: any = await amendIntent(cfg, ACCOUNT, CARD, patch);
    expect(done.intent_id).toBe(CARD);
    // And the memory is cleared with it, so the NEXT figure is asked about.
    expect(world.refs.rows.has(CARD)).toBe(false);
    await expect(amendIntent(cfg, ACCOUNT, CARD, { ask: { amount: 700, ccy: 'AUD' } })).rejects.toThrow(
      'CONFIRM_FIGURE',
    );
  });
});
