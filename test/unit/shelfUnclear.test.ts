/**
 * AN UNSURE SHELF BECOMES A QUESTION.
 *
 * Run 9 taught the switchboard to snap an invented path onto the nearest node
 * the catalogue knows, because an invented branch matches nothing at all
 * (test/unit/categorySnap.test.ts holds that). The 19 September rehearsal
 * taught the other half of it: snapping onto the nearest node is only right
 * where the switchboard actually knows which node.
 *
 * What happened. An assistant invented 'goods.sim-racing.pedal-parts' for an
 * upgraded Fanatec pedal spring. The snap filed it under goods.motoring at
 * 0.625, with the runners-up scattered over motoring, bicycle parts and
 * equestrian. Sim racing is not motoring; the want for the other half would
 * have gone up under electronics; and the category gate would have kept the
 * two apart in silence, which is the very defect the snap exists to close.
 *
 * So a top answer that close with a field that scattered is not a decision,
 * and the switchboard says so: nothing is filed, and the human whose thing it
 * is settles it from a few shelves in plain words. The same shape as the place
 * name several towns answer to.
 *
 * What is asserted here:
 *   - the rehearsal case is refused, with candidates from distinct branches;
 *   - a confident answer still snaps, and says so;
 *   - a bare top level is accepted exactly as it is today;
 *   - a node the catalogue knows is untouched;
 *   - the ops sweep answers the way it always has;
 *   - and an amend is never refused for this.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** The suggester, stubbed: this suite is about what is done with its answer. */
let suggestions: any = null;
vi.mock('../../src/domain/categorySuggest.js', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    suggestCategories: async (...args: any[]) => suggestions ?? actual.suggestCategories(...args),
  };
});

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
import {
  SHELF_BRANCH_MARGIN,
  SHELF_BRANCH_MARGIN_LEAD,
  SHELF_CANDIDATE_LIMIT,
  SHELF_CONFIDENT_LEAD,
  SHELF_CONFIDENT_MIN,
  SHELF_MIN_LEAD,
  SHELF_NONE_OPTION,
  categoryWords,
  snapCategory,
} from '../../src/domain/categoryBackfill.js';
import { amendIntent, publishIntent } from '../../src/domain/cards.js';
import { OsbError, SCHEMA_VERSION, type ShelfCandidate } from '../../src/protocol.js';
import { lintHumanCopy } from '../../src/email/lint.js';
import type { Config } from '../../src/config.js';

const cfg = {
  quotas: { maxOpenCards: 20, maxPublishesPerDay: 20 },
  screeningQueueUrl: 'https://queue.test/screening',
} as unknown as Config;

const ACCOUNT = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const CARD = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

/**
 * The rehearsal's own shortlist, in the shape the suggester answers in: a top
 * answer at 0.625 with three different branches close behind it.
 */
const SCATTERED = {
  categories: [
    'goods.motoring.parts',
    'goods.bicycle.parts',
    'goods.sports.equestrian',
    'goods.electronics.console.accessories',
  ],
  scored: [
    { category: 'goods.motoring.parts', score: 0.625 },
    { category: 'goods.bicycle.parts', score: 0.611 },
    { category: 'goods.sports.equestrian', score: 0.6 },
    { category: 'goods.electronics.console.accessories', score: 0.59 },
  ],
  source: 'embedding' as const,
};

/** The same shortlist with nothing to argue about: one branch, well clear. */
const CONFIDENT = {
  categories: ['goods.bicycle.parts', 'goods.bicycle.mountain'],
  scored: [
    { category: 'goods.bicycle.parts', score: 0.91 },
    { category: 'goods.bicycle.mountain', score: 0.83 },
  ],
  source: 'embedding' as const,
};

const door = (category: string, posting?: any) =>
  snapCategory(cfg, category, undefined, {
    fallbackToAncestor: true,
    askWhenUnsure: true,
    ...(posting ? { posting } : {}),
  });

// ---------------------------------------------------------------------------
describe('the decision, and when it is not one', () => {
  beforeEach(() => {
    suggestions = null;
  });

  it('refuses the rehearsal case rather than filing it under motoring', async () => {
    suggestions = SCATTERED;
    const d = await door('goods.sim-racing.pedal-parts', {
      kind: 'upgraded Fanatec pedal spring',
      attributes: { brand: 'fanatec', condition: 'good' },
    });
    expect(d.how).toBe('unclear');
    expect(d.changed).toBe(false);
    expect(d.category).toBe('goods.sim-racing.pedal-parts');
    expect(d.score).toBe(0.625);
  });

  it('offers one shelf per branch, in plain words, and a way of saying none', async () => {
    suggestions = SCATTERED;
    const d = await door('goods.sim-racing.pedal-parts');
    const candidates = d.candidates!;
    expect(candidates.length).toBeLessThanOrEqual(SHELF_CANDIDATE_LIMIT + 1);
    const real = candidates.filter((c) => c.category !== SHELF_NONE_OPTION);
    // One per second-level branch: four flavours of the same wrong branch is
    // not a choice, and the disagreement between branches is the whole reason
    // anybody is being asked.
    const branches = real.map((c) => c.category.split('.').slice(0, 2).join('.'));
    expect(new Set(branches).size).toBe(branches.length);
    for (const c of real) {
      expect(c.words, c.category).not.toContain('>');
      expect(c.words, c.category).not.toContain('.');
      expect(lintHumanCopy(c.words), c.category).toEqual([]);
    }
    expect(candidates[candidates.length - 1]).toEqual({
      category: SHELF_NONE_OPTION,
      words: 'none of these',
    });
  });

  it('snaps when the top answer is close and the field agrees about the branch', async () => {
    suggestions = CONFIDENT;
    const d = await door('goods.bicycle.replacement-spokes');
    expect(d.how).toBe('suggestion');
    expect(d.category).toBe('goods.bicycle.parts');
    expect(d.candidates).toBeUndefined();
  });

  it('asks when the top answer is close enough but another branch is level with it', async () => {
    suggestions = {
      categories: ['goods.bicycle.parts', 'goods.motoring.parts'],
      scored: [
        { category: 'goods.bicycle.parts', score: 0.9 },
        // Inside the margin, and from somewhere else entirely.
        { category: 'goods.motoring.parts', score: 0.9 - SHELF_BRANCH_MARGIN / 2 },
      ],
      source: 'embedding' as const,
    };
    expect((await door('goods.spares.brake-pads')).how).toBe('unclear');
  });

  it('snaps when the nearest other branch is beaten by the margin', async () => {
    suggestions = {
      categories: ['goods.bicycle.parts', 'goods.motoring.parts'],
      scored: [
        { category: 'goods.bicycle.parts', score: 0.9 },
        { category: 'goods.motoring.parts', score: 0.9 - SHELF_BRANCH_MARGIN - 0.01 },
      ],
      source: 'embedding' as const,
    };
    const d = await door('goods.spares.brake-pads');
    expect(d.how).toBe('suggestion');
    expect(d.category).toBe('goods.bicycle.parts');
  });

  it('asks whatever the field says, when the top answer is not close on its own terms', async () => {
    suggestions = {
      categories: ['goods.bicycle.parts', 'goods.bicycle.mountain'],
      scored: [
        { category: 'goods.bicycle.parts', score: SHELF_CONFIDENT_MIN - 0.01 },
        { category: 'goods.bicycle.mountain', score: 0.6 },
      ],
      source: 'embedding' as const,
    };
    expect((await door('goods.spares.brake-pads')).how).toBe('unclear');
  });

  it('holds both numbers where they can be read, and says they are one rehearsal old', () => {
    expect(SHELF_CONFIDENT_MIN).toBe(0.75);
    expect(SHELF_BRANCH_MARGIN).toBe(0.08);
    // 0.625 with scattered runners-up was the wrong answer, so the floor is
    // above it by a margin nobody has yet earned against real data.
    expect(SHELF_CONFIDENT_MIN).toBeGreaterThan(0.625);
  });

  it('says a node in the words a person would use for it', () => {
    expect(categoryWords('goods.bicycle.mountain')).toBe('mountain bikes');
    expect(categoryWords('goods')).not.toContain('>');
  });
});

// ---------------------------------------------------------------------------
/**
 * AND THE SAME DECISION ON THE RULER THAT ACTUALLY MEASURES SOMETHING.
 *
 * Twelve postings went up on dev on 19 September under paths the catalogue
 * does not hold, and every one of them was filed on the bare top level, in
 * silence, with no score in the log at all. Nothing was broken about the
 * embedding: it was reached every time. What was broken is that the floor it
 * was judged against — a raw cosine of 0.55 — had been set when the door asked
 * about the path alone, and a question with the posting's words in it scores
 * lower against everything. So nothing ever cleared the floor, no candidate was
 * ever chosen, the unclear branch (which can only be reached once one has been)
 * was never reached, and SHELF_UNCLEAR did not fire once in thirty live runs.
 *
 * The suggester now reports how far an answer leads the whole catalogue, in
 * standard deviations, and that is what the door decides on.
 *
 * What is asserted here:
 *   - the lead decides, and the raw score is carried through to the answer;
 *   - a clear lead snaps;
 *   - a lead that is real but short of confident ASKS;
 *   - nothing standing out from the catalogue ends on the posting's own line;
 *   - the assistant's path breaks a tie and never more than a tie.
 */
describe('the decision, on the lead over the field', () => {
  const at = (rows: [string, number, number][]) => ({
    categories: rows.map(([c]) => c),
    scored: rows.map(([category, score, lead]) => ({ category, score, lead })),
    source: 'embedding' as const,
  });

  beforeEach(() => {
    suggestions = null;
  });

  it('snaps on a clear lead, however low the raw cosine happens to be', async () => {
    // 0.278 was the real cosine for a PlayStation controller posted under
    // 'goods.gaming.accessories'. The old floor threw it away; it is the right
    // answer and it leads the catalogue by four and a half deviations.
    suggestions = at([
      ['goods.electronics.console.accessories', 0.278, 4.5],
      ['goods.electronics.console.playstation', 0.26, 4.21],
    ]);
    const d = await door('goods.gaming.accessories');
    expect(d.how).toBe('suggestion');
    expect(d.category).toBe('goods.electronics.console.accessories');
    // The real score is carried through, not lost on the way out.
    expect(d.score).toBe(0.278);
    expect(d.lead).toBe(4.5);
  });

  it('asks when the answer leads the field but not by enough to be a decision', async () => {
    // The Fanatec brake spring: 3.79 deviations, and a catalogue with no shelf
    // for sim racing on it. A person settles this in a sentence.
    suggestions = at([
      ['goods.bicycle.parts', 0.204, 3.79],
      ['goods.motoring.parts', 0.19, 3.1],
      ['goods.electronics.console.accessories', 0.17, 2.4],
    ]);
    const d = await door('goods.sim-racing.pedals');
    expect(d.how).toBe('unclear');
    expect(d.score).toBe(0.204);
    expect(d.lead).toBe(3.79);
    const real = d.candidates!.filter((c) => c.category !== SHELF_NONE_OPTION);
    expect(real.length).toBeGreaterThan(1);
    expect(d.candidates![d.candidates!.length - 1].category).toBe(SHELF_NONE_OPTION);
  });

  it('asks where another branch is level with the leader', async () => {
    suggestions = at([
      ['goods.bicycle.parts', 0.4, 6.0],
      ['goods.motoring.parts', 0.39, 6.0 - SHELF_BRANCH_MARGIN_LEAD / 2],
    ]);
    expect((await door('goods.spares.brake-pads')).how).toBe('unclear');
  });

  it('snaps where the nearest other branch is beaten by the margin', async () => {
    suggestions = at([
      ['goods.bicycle.parts', 0.4, 6.0],
      ['goods.motoring.parts', 0.3, 6.0 - SHELF_BRANCH_MARGIN_LEAD - 0.1],
    ]);
    const d = await door('goods.spares.brake-pads');
    expect(d.how).toBe('suggestion');
    expect(d.category).toBe('goods.bicycle.parts');
  });

  it('puts nothing to anybody when nothing stands out from the catalogue', async () => {
    // A shortlist exists — there is always a nearest node — but none of it is
    // a candidate, so there is no question worth asking and the posting goes
    // up on its own line.
    suggestions = at([
      ['goods.bicycle.parts', 0.09, SHELF_MIN_LEAD - 0.2],
      ['goods.sports.golf', 0.08, 1.2],
    ]);
    const d = await door('goods.made-up.nonsense');
    expect(d.how).toBe('ancestor');
    expect(d.category).toBe('goods');
    expect(d.candidates).toBeUndefined();
  });

  it('lets the path the assistant wrote break a tie, and only a tie', async () => {
    // Both answers are confident and in the same breath; one of them is on the
    // line the posting was already filed on, so that one wins.
    suggestions = at([
      ['goods.bicycle.parts', 0.4, 6.0],
      ['goods.motoring.parts', 0.399, 5.95],
    ]);
    const near = await snapCategory(cfg, 'goods.motoring.spares', undefined, {
      fallbackToAncestor: true,
    });
    expect(near.category).toBe('goods.motoring.parts');

    // Anything wider than a tie is left alone: the words are the evidence.
    suggestions = at([
      ['goods.bicycle.parts', 0.4, 6.0],
      ['goods.motoring.parts', 0.3, 3.0],
    ]);
    const clear = await snapCategory(cfg, 'goods.motoring.spares', undefined, {
      fallbackToAncestor: true,
    });
    expect(clear.category).toBe('goods.bicycle.parts');
  });

  /**
   * The sweep has nobody standing there to ask and it is moving a row that is
   * already up and already matching or not matching on its own. So it only
   * moves one where the door would have filed it without asking.
   */
  it('leaves the ops sweep to act only where the door would not have asked', async () => {
    suggestions = at([
      ['goods.bicycle.parts', 0.204, SHELF_CONFIDENT_LEAD - 0.2],
      ['goods.motoring.parts', 0.19, 3.1],
    ]);
    const sweep = await snapCategory(cfg, 'goods.sim-racing.pedals');
    expect(sweep.how).toBe('unmatched');
    expect(sweep.changed).toBe(false);
    // The same answer at the door is a question, not a silence.
    expect((await door('goods.sim-racing.pedals')).how).toBe('unclear');
  });

  it('holds the measured numbers where they can be read', () => {
    // Twelve realistic postings through the door against dev's catalogue,
    // 20 September: every answer that was right led the field by 4.22 or more,
    // the one that was wrong by 3.73, and the floor sits between them.
    expect(SHELF_CONFIDENT_LEAD).toBeGreaterThan(3.73);
    expect(SHELF_CONFIDENT_LEAD).toBeLessThan(4.22);
    expect(SHELF_MIN_LEAD).toBeLessThan(SHELF_CONFIDENT_LEAD);
    expect(SHELF_BRANCH_MARGIN_LEAD).toBeLessThan(1.29);
  });
});

describe('the words a shelf is offered in', () => {
  it('says a node in the words a person would use for it', () => {
    expect(categoryWords('goods.bicycle.mountain')).toBe('mountain bikes');
    expect(categoryWords('goods')).not.toContain('>');
  });

  it('leaves a node the catalogue knows exactly where it was sent', async () => {
    suggestions = SCATTERED;
    for (const c of ['goods.bicycle.mountain', 'services.repairs.bicycle']) {
      const d = await door(c);
      expect(d, c).toMatchObject({ category: c, changed: false, how: 'as-posted' });
    }
  });

  it('accepts a bare top level exactly as it does today', async () => {
    suggestions = SCATTERED;
    for (const c of ['goods', 'services', 'social']) {
      const d = await door(c);
      expect(d, c).toMatchObject({ category: c, changed: false, how: 'as-posted' });
    }
  });

  it('leaves the ops sweep answering the way it always has', async () => {
    // The sweep never passes the flag: it is reading rows that are already up,
    // and there is nobody standing there to ask.
    suggestions = SCATTERED;
    const d = await snapCategory(cfg, 'goods.sim-racing.pedal-parts');
    expect(d.how).toBe('suggestion');
    expect(d.category).toBe('goods.motoring.parts');
    expect(d.candidates).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The door, and what the assistant is handed
// ---------------------------------------------------------------------------
interface World {
  sql: { text: string; params: any[] }[];
  card: Record<string, any>;
}
let world: World;

function fakePool() {
  return {
    query: async (sql: string, params: any[] = []) => {
      world.sql.push({ text: sql.replace(/\s+/g, ' ').trim(), params });
      if (/INSERT INTO cards/.test(sql)) return { rows: [{ id: CARD }], rowCount: 1 };
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
  category: 'goods.sim-racing.pedal-parts',
  kind: 'upgraded Fanatec pedal spring',
  // Rich enough that the detail gate has nothing to say: this suite is about
  // the shelf.
  attributes: { brand: 'fanatec', model: 'csl elite', condition: 'good' },
  geo: { bucket: 'r3gx', radius_km: 25, reach: 'country' },
  ttl_days: 60,
  ...over,
});

beforeEach(() => {
  suggestions = SCATTERED;
  world = {
    sql: [],
    card: {
      id: CARD,
      account_id: ACCOUNT,
      schema_version: SCHEMA_VERSION,
      type: 'HAVE',
      category: 'goods.sim-racing.pedal-parts',
      category_as_posted: 'goods.sim-racing.pedal-parts',
      kind: 'upgraded Fanatec pedal spring',
      geo: { bucket: 'r3gx', radius_km: 25, reach: 'country' },
      attributes: { brand: 'fanatec' },
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

const refusal = async (card: any) => {
  try {
    await publishIntent(cfg, ACCOUNT, card);
    return undefined;
  } catch (e) {
    if (e instanceof OsbError) return e.payload;
    throw e;
  }
};

describe('what the assistant is handed, and what is written', () => {
  it('comes back unposted, with the shelves and the sentence to say', async () => {
    const p = (await refusal(listing()))!;
    expect(p.code).toBe('SHELF_UNCLEAR');
    const candidates = p.candidates as ShelfCandidate[];
    expect(candidates.length).toBeGreaterThan(1);
    expect(candidates.some((c) => c.category === SHELF_NONE_OPTION)).toBe(true);
    expect(p.human_action).toContain('Ask your human which of these is closest');
    // And the way out if they recognise none of them: since version 58 that is
    // its own answer, which hands over the searchable shelf page (SHELF_PICK).
    expect(p.human_action).toContain('post it again with category none_of_these');
    expect(lintHumanCopy(p.human_action!)).toEqual([]);
    expect(world.sql.some((s) => /INSERT INTO cards/.test(s.text))).toBe(false);
  });

  it('posts it where the human said, once they have chosen a shelf', async () => {
    const r: any = await publishIntent(
      cfg,
      ACCOUNT,
      listing({ category: 'goods.bicycle.parts' }),
    );
    expect(r.intent_id).toBe(CARD);
    expect(r.category).toBe('goods.bicycle.parts');
  });

  it('posts it under the top level when they recognise none of them', async () => {
    const r: any = await publishIntent(cfg, ACCOUNT, listing({ category: 'goods' }));
    expect(r.intent_id).toBe(CARD);
    expect(r.category).toBe('goods');
    expect(r.filed_under_note.text).not.toContain('nearest thing the catalogue knows');
  });

  it('never refuses an amend, and files it the way it always did', async () => {
    const r: any = await amendIntent(cfg, ACCOUNT, CARD, { urgency: 'days' });
    expect(r.intent_id).toBe(CARD);
    expect(r.category).toBe('goods.motoring.parts');
  });
});
