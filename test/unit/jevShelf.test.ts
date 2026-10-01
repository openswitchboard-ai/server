/**
 * JEV HELPS CHOOSE THE SHELF AT THE DOOR (founder, 1 October 2026;
 * src/domain/jevShelf.ts).
 *
 * What this suite pins:
 *   - JEV_SHELF: on in dev and off in prod by default, anything else fails boot;
 *     prod by default never calls out for a shelf;
 *   - when the door asks (unclear, crossing the written top level, two branches
 *     level) and when it does not (a clear answer, an amend, the sweep);
 *   - what is offered: open shelves only, at most five, plus the written line;
 *   - a confident pick files it with how 'jev'; a confident "none of these"
 *     where the door would have asked is the shelf page; below the bar, a
 *     timeout, an error, an answer that is not an option or a closed shelf is
 *     the door's own answer;
 *   - what is sent is the kind and plain attributes and the options' label
 *     paths, and nothing else; what is logged is ids, decision, p and latency.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

let suggestions: any = null;
vi.mock('../../src/domain/categorySuggest.js', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    suggestCategories: async (...args: any[]) => suggestions ?? actual.suggestCategories(...args),
  };
});

/** Jev at the door, stubbed: what it answers and whether it is switched on. */
let shelfOn = false;
let jevAnswer: (state: any, questions: any) => Promise<any> = async () => ({ ok: false, reason: 'disabled' });
const jevAsked: { state: any; questions: any }[] = [];
vi.mock('../../src/shadow/jev.js', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    jevShelfEnabled: () => shelfOn,
    askJevForShelf: async (state: any, questions: any) => {
      jevAsked.push({ state, questions });
      return jevAnswer(state, questions);
    },
  };
});

vi.mock('../../src/aws.js', () => ({ bedrock: { send: vi.fn() }, sqs: { send: vi.fn() }, secretsManager: { send: vi.fn() } }));
vi.mock('../../src/crypto.js', () => ({ encryptField: async () => Buffer.from('x') }));
vi.mock('../../src/intake/pipe.js', () => ({ runIntake: async () => ({ outcome: 'allow' }) }));
vi.mock('../../src/domain/categoryMisses.js', () => ({ recordCategoryMiss: async () => {} }));
vi.mock('../../src/domain/quotas.js', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return { ...actual, checkPublishQuota: async () => {}, recordPublishWithinQuota: async () => {} };
});
vi.mock('../../src/domain/shelfPick.js', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    shelfPickLink: async () => ({ link: 'https://counter.test/a/tok', press_id: 'press-1', expires_in_minutes: 60 }),
  };
});

import * as db from '../../src/db.js';
import { jevShelfFrom, type Config } from '../../src/config.js';
import { categoryDenied, categoryStatus } from '../../src/denylist.js';
import { SHELF_BRANCH_MARGIN_LEAD, jevShelfOptions, jevShelfReasons, snapCategory } from '../../src/domain/categoryBackfill.js';
import { JEV_SHELF_MIN_P, JEV_SHELF_TIMEOUT_MS, chooseShelfWithJev, jevShelfQuestion } from '../../src/domain/jevShelf.js';
import { amendIntent, publishIntent } from '../../src/domain/cards.js';
import { OsbError, SCHEMA_VERSION } from '../../src/protocol.js';

const cfg = {
  quotas: { maxOpenCards: 20, maxPublishesPerDay: 20 },
  screeningQueueUrl: 'https://queue.test/screening',
  counterOrigin: 'https://counter.test',
} as unknown as Config;

const ACCOUNT = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const CARD = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

const at = (rows: [string, number, number][]) => ({
  categories: rows.map(([c]) => c),
  scored: rows.map(([category, score, lead]) => ({ category, score, lead })),
  source: 'embedding' as const,
});

/** Close but scattered: the door would ask. */
const SCATTERED = at([
  ['goods.motoring.parts', 0.3, 3.6],
  ['goods.bicycle.parts', 0.29, 3.4],
  ['goods.electronics.console.sim-racing', 0.28, 3.2],
]);
/** One clear answer on the written line: the door files it, Jev is not asked. */
const CLEAR = at([
  ['goods.bicycle.parts', 0.4, 6.5],
  ['goods.bicycle.mountain', 0.3, 5.9],
  ['goods.motoring.parts', 0.2, 3.0],
]);
/** The ladder: the best answer is under another top level than the one written. */
const CROSSING = at([
  ['services.events.equipment-loan', 0.4, 7.0],
  ['goods.tools.ladder', 0.2, 4.1],
]);

const choice = (choice: string, p: number) =>
  async () => ({
    ok: true,
    latencyMs: 180,
    answers: { shelf: { type: 'choice', choice, probabilities: { [choice]: p }, confidence: p } },
  });

const ask = (posting: any = { kind: 'upgraded Fanatec pedal spring', attributes: { brand: 'fanatec' } }) =>
  ({
    chooseShelf: (req: any) => chooseShelfWithJev(req, () => {}),
    posting,
  });

const door = (category: string, extra: any = {}) =>
  snapCategory(cfg, category, undefined, { fallbackToAncestor: true, askWhenUnsure: true, ...extra });

beforeEach(() => {
  suggestions = null;
  shelfOn = true;
  jevAsked.length = 0;
  jevAnswer = async () => ({ ok: false, reason: 'disabled' });
});

// ---------------------------------------------------------------------------
describe('JEV_SHELF', () => {
  it('is on in dev and OFF in prod by default; on/off win; anything else fails boot', () => {
    expect(jevShelfFrom(undefined, 'dev')).toBe(true);
    expect(jevShelfFrom('', 'dev')).toBe(true);
    expect(jevShelfFrom(undefined, 'prod')).toBe(false);
    expect(jevShelfFrom('', 'prod')).toBe(false);
    expect(jevShelfFrom('on', 'prod')).toBe(true);
    expect(jevShelfFrom(' OFF ', 'dev')).toBe(false);
    for (const v of ['true', '1', 'yes', 'maybe']) expect(() => jevShelfFrom(v, 'dev'), v).toThrow(/JEV_SHELF/);
  });

  it('switched off, Jev is never asked and the door answers as before', async () => {
    shelfOn = false;
    jevAnswer = choice('goods.bicycle.parts', 0.99);
    const v = await chooseShelfWithJev({ options: ['goods.bicycle.parts'], posting: {}, reasons: ['unclear'] });
    expect(v).toEqual({ decision: 'rules', reason: 'disabled' });
    expect(jevAsked).toHaveLength(0);
  });
});

describe('the real client, in prod by default', () => {
  it('never calls out for a shelf', async () => {
    const real = await vi.importActual<typeof import('../../src/shadow/jev.js')>('../../src/shadow/jev.js');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    real.initJev({
      envName: 'prod',
      jevSecretArn: 'arn:aws:secretsmanager:us-east-1:1:secret:osb/prod/jev',
      jevMatching: true,
      jevShelf: jevShelfFrom(undefined, 'prod'),
    } as unknown as Config);
    expect(real.jevShelfEnabled()).toBe(false);
    expect(await real.askJevForShelf({}, jevShelfQuestion(['goods.bicycle.parts']), { timeoutMs: 100 })).toEqual({
      ok: false,
      reason: 'disabled',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

// ---------------------------------------------------------------------------
describe('when the door asks', () => {
  it('asks where the door would answer SHELF_UNCLEAR, and files a confident pick', async () => {
    suggestions = SCATTERED;
    jevAnswer = choice('goods.electronics.console.sim-racing', 0.86);
    const d = await door('goods.sim-racing.pedal-parts', ask());
    expect(jevAsked).toHaveLength(1);
    expect(d.how).toBe('jev');
    expect(d.category).toBe('goods.electronics.console.sim-racing');
    expect(d.jev?.reasons).toContain('unclear');
    expect(d.jev?.verdict).toMatchObject({ decision: 'pick', p: 0.86 });
  });

  it('asks where the best shelf crosses the top level the assistant wrote', async () => {
    suggestions = CROSSING;
    jevAnswer = choice('goods.tools.ladder', 0.9);
    const d = await door('goods.ladder', ask({ kind: 'aluminium extension ladder to lend', attributes: {} }));
    expect(d.jev?.reasons).toContain('crosses-top');
    expect(d.how).toBe('jev');
    expect(d.category).toBe('goods.tools.ladder');
  });

  it('asks where the top two are from different branches within one margin', async () => {
    const reasons = jevShelfReasons(
      { category: 'goods.bicycle.parts', score: 0.4, lead: 6.0 },
      [
        { category: 'goods.bicycle.parts', score: 0.4, lead: 6.0 },
        { category: 'goods.motoring.parts', score: 0.39, lead: 6.0 - SHELF_BRANCH_MARGIN_LEAD / 2 },
      ],
      'goods.spares.brake-pads',
      false,
    );
    expect(reasons).toEqual(['close-branches']);
  });

  it('does not ask on a clear answer on the written line', async () => {
    suggestions = CLEAR;
    jevAnswer = choice('goods.motoring.parts', 0.99);
    const d = await door('goods.bicycle.replacement-spokes', ask());
    expect(jevAsked).toHaveLength(0);
    expect(d.how).toBe('suggestion');
    expect(d.category).toBe('goods.bicycle.parts');
  });

  it('never asks for the sweep or anything without askWhenUnsure (an amend)', async () => {
    suggestions = SCATTERED;
    jevAnswer = choice('goods.bicycle.parts', 0.99);
    const chooseShelf = vi.fn(async () => ({ decision: 'pick' as const, category: 'goods.bicycle.parts', p: 0.99, latencyMs: 1 }));
    await snapCategory(cfg, 'goods.sim-racing.pedal-parts', undefined, { fallbackToAncestor: true, chooseShelf });
    await snapCategory(cfg, 'goods.sim-racing.pedal-parts', undefined, { chooseShelf });
    expect(chooseShelf).not.toHaveBeenCalled();
  });

  it('never asks about a path the catalogue knows', async () => {
    suggestions = SCATTERED;
    const chooseShelf = vi.fn();
    const d = await door('goods.bicycle.parts', { chooseShelf });
    expect(d.how).toBe('as-posted');
    expect(chooseShelf).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
describe('what Jev is offered', () => {
  it('open shelves only, at most five from the door, plus the written line', () => {
    const offerable = ['goods.bicycle.parts', 'goods.bicycle.mountain', 'goods.motoring.parts', 'goods.sports.equestrian',
      'goods.electronics.console.sim-racing', 'goods.tools.hand'].map((category, i) => ({ category, score: 0.5 - i / 100, lead: 5 - i / 10 }));
    const opts = jevShelfOptions(offerable, 'goods.motoring.spares');
    expect(opts.slice(0, 5)).toEqual(offerable.slice(0, 5).map((s) => s.category));
    expect(opts).toContain('goods.motoring');
    expect(opts).toHaveLength(6);
    for (const c of opts) expect(categoryStatus(c).status === 'open' && !categoryDenied(c), c).toBe(true);
  });

  it('only the top level the assistant wrote, where the door has a plausible shelf there', () => {
    const offerable = [
      { category: 'services.home.pressure-washing', score: 0.4, lead: 6 },
      { category: 'goods.tools.power', score: 0.3, lead: 4 },
    ];
    expect(jevShelfOptions(offerable, 'goods.hire.pressure-washer')).toEqual(['goods.tools.power']);
    // Nothing plausible under the written top level: every top level, as before.
    expect(jevShelfOptions(offerable.slice(0, 1), 'goods.hire.pressure-washer')).toEqual(['services.home.pressure-washing']);
  });

  it('never a bare top level as the written line', () => {
    expect(jevShelfOptions([{ category: 'goods.bicycle.parts', score: 0.5, lead: 5 }], 'goods.whatever')).toEqual([
      'goods.bicycle.parts',
    ]);
  });

  it('a closed or reserved shelf is never offered and never picked', async () => {
    const closed = 'work.jobs';
    expect(categoryStatus(closed).status === 'open' && !categoryDenied(closed)).toBe(false);
    jevAnswer = choice(closed, 0.99);
    const v = await chooseShelfWithJev({ options: ['goods.bicycle.parts', closed], posting: {}, reasons: ['unclear'] });
    expect(Object.keys(jevAsked[0].questions.shelf.criteria)).not.toContain(closed);
    expect(v).toMatchObject({ decision: 'rules', reason: 'not-an-option' });
  });

  it('the kind and plain attributes, and label paths: no ids, prices, places, names, other words', async () => {
    jevAnswer = choice('goods.bicycle.parts', 0.9);
    await chooseShelfWithJev({
      options: ['goods.bicycle.parts'],
      posting: {
        kind: 'brake pads, $40, call 0412 345 678',
        also_called: ['stoppers'],
        not_these: ['rotors'],
        attributes: { brand: 'Shimano', price: 40, suburb: 'Braddon', owner_name: 'Tony', note: 'at 12 Smith Street' },
        id: CARD,
      } as any,
      reasons: ['unclear'],
    });
    const { state, questions } = jevAsked[0];
    expect(Object.keys(state).sort()).toEqual(['attributes', 'kind']);
    expect(state.attributes).toEqual({ brand: 'Shimano', note: 'at [removed]' });
    const json = JSON.stringify({ state, questions });
    for (const bad of ['$40', '0412', 'stoppers', 'rotors', 'Braddon', 'Tony', 'Smith', CARD, 'price']) {
      expect(json, bad).not.toContain(bad);
    }
    // Options by node, described by their label path in words.
    expect(questions.shelf.criteria['goods.bicycle.parts']).toMatch(/>/);
    expect(questions.shelf.criteria.none_of_these).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
describe('what it decides, and when the door decides instead', () => {
  const req = { options: ['goods.bicycle.parts', 'goods.motoring.parts'], posting: { kind: 'brake pads' }, reasons: ['unclear' as const] };

  it(`a pick at p >= ${JEV_SHELF_MIN_P}, the door's answer below it`, async () => {
    jevAnswer = choice('goods.motoring.parts', JEV_SHELF_MIN_P);
    expect(await chooseShelfWithJev(req)).toMatchObject({ decision: 'pick', category: 'goods.motoring.parts' });
    jevAnswer = choice('goods.motoring.parts', JEV_SHELF_MIN_P - 0.01);
    expect(await chooseShelfWithJev(req)).toMatchObject({ decision: 'rules', reason: 'low-p' });
  });

  it('none of these at p >= the bar', async () => {
    jevAnswer = choice('none_of_these', 0.8);
    expect(await chooseShelfWithJev(req)).toMatchObject({ decision: 'none', p: 0.8 });
    jevAnswer = choice('none_of_these', 0.5);
    expect(await chooseShelfWithJev(req)).toMatchObject({ decision: 'rules' });
  });

  it('an answer that is not an option is ignored', async () => {
    jevAnswer = choice('goods.tools.hand', 0.99);
    expect(await chooseShelfWithJev(req)).toMatchObject({ decision: 'rules', reason: 'not-an-option' });
  });

  it('a timeout, an error, a throw or a half answer is the door answering, within one timeout', async () => {
    const log = vi.fn();
    const cases: [string, () => Promise<any>][] = [
      ['timeout', () => new Promise(() => {})],
      ['http-500', async () => ({ ok: false, reason: 'http-500' })],
      ['error', async () => { throw new Error('boom'); }],
      ['incomplete', async () => ({ ok: true, latencyMs: 1, answers: {} })],
    ];
    for (const [reason, fn] of cases) {
      jevAnswer = fn;
      const started = Date.now();
      const v = await chooseShelfWithJev({ ...req, posting: { kind: 'secret words' } }, log, { timeoutMs: 50 });
      expect(v, reason).toMatchObject({ decision: 'rules', reason });
      expect(Date.now() - started).toBeLessThan(1000);
    }
    expect(JEV_SHELF_TIMEOUT_MS).toBeLessThanOrEqual(2000);
    // Ids, decision, p and latency: never the posting's words or the shelves.
    const logged = JSON.stringify(log.mock.calls);
    expect(logged).not.toContain('secret words');
    expect(logged).not.toContain('goods.');
  });

  it('on the door: a timeout leaves the door asking the human as before', async () => {
    suggestions = SCATTERED;
    jevAnswer = async () => ({ ok: false, reason: 'timeout' });
    const d = await door('goods.sim-racing.pedal-parts', ask());
    expect(d.how).toBe('unclear');
    expect(d.jev?.verdict.decision).toBe('rules');
  });

  it('on the door: a low-p pick on a crossing keeps the door filing on the written top level', async () => {
    // The 1 October ladder numbers: the door itself keeps the written top level.
    suggestions = at([
      ['services.events.equipment-loan', 0.25, 5.51],
      ['goods.tools.ladder', 0.204, 4.25],
    ]);
    jevAnswer = choice('services.events.equipment-loan', 0.6);
    const d = await door('goods.ladder', ask({ kind: 'ladder', attributes: {} }));
    expect(d.how).toBe('suggestion');
    expect(d.category).toBe('goods.tools.ladder');
  });

  it('on the door: none of these on a clear-enough answer leaves the door filing it', async () => {
    suggestions = CROSSING;
    jevAnswer = choice('none_of_these', 0.95);
    const d = await door('goods.ladder', ask({ kind: 'ladder', attributes: {} }));
    expect(d.how).toBe('suggestion');
  });
});

// ---------------------------------------------------------------------------
// At the publish door.
// ---------------------------------------------------------------------------
const sql: { text: string; params: any[] }[] = [];
function fakePool() {
  return {
    query: async (text: string, params: any[] = []) => {
      sql.push({ text: text.replace(/\s+/g, ' ').trim(), params });
      if (/INSERT INTO cards/.test(text)) return { rows: [{ id: CARD, content_version: 1 }], rowCount: 1 };
      if (/INSERT INTO shelf_attempts/.test(text)) return { rows: [{ attempt: 'att-1' }], rowCount: 1 };
      if (/UPDATE shelf_attempts SET none_at/.test(text)) return { rows: [{ attempt: 'att-1' }], rowCount: 1 };
      if (/FROM accounts/.test(text)) return { rows: [{ id: ACCOUNT, data_key_enc: Buffer.from('k'), timezone: null }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  } as any;
}
const listing = (over: Record<string, unknown> = {}) => ({
  schema_version: SCHEMA_VERSION,
  type: 'offering',
  category: 'goods.sim-racing.pedal-parts',
  kind: 'upgraded Fanatec pedal spring',
  attributes: { brand: 'fanatec', model: 'csl elite', condition: 'good' },
  geo: { bucket: 'r3gx', radius_km: 25, reach: 'country' },
  ttl_days: 60,
  ...over,
});
const outcomeOf = async (card: any) => {
  try {
    return { ok: await publishIntent(cfg, ACCOUNT, card) };
  } catch (e) {
    if (e instanceof OsbError) return { err: e.payload };
    throw e;
  }
};
const gapRows = () => sql.filter((s) => /INSERT INTO shelf_gaps/.test(s.text));

describe('at the publish door', () => {
  beforeEach(() => {
    sql.length = 0;
    suggestions = SCATTERED;
    vi.spyOn(db, 'getPool').mockReturnValue(fakePool());
  });

  it('files on the shelf Jev picked, and writes it down as jev with p', async () => {
    jevAnswer = choice('goods.electronics.console.sim-racing', 0.88);
    const r: any = await outcomeOf(listing());
    expect(r.ok?.category).toBe('goods.electronics.console.sim-racing');
    const gap = gapRows().find((g) => g.params.includes('jev_picked'))!;
    expect(gap.text).toContain("'jev'");
    expect(gap.params).toContain('goods.electronics.console.sim-racing');
    expect(gap.params).toContain(0.88);
  });

  it('hands over the shelf page when Jev is sure none of them fits', async () => {
    jevAnswer = choice('none_of_these', 0.9);
    const r: any = await outcomeOf(listing());
    expect(r.err?.code).toBe('SHELF_PICK');
    expect(r.err?.human_action).toContain('https://counter.test/a/tok');
    const gap = gapRows().find((g) => g.params.includes('none_of_these'))!;
    expect(gap.text).toContain("'jev'");
    expect(gap.params).toContain(0.9);
    expect(sql.some((s) => /INSERT INTO cards/.test(s.text))).toBe(false);
  });

  it('switched off, the door asks the human exactly as before', async () => {
    shelfOn = false;
    jevAnswer = choice('goods.electronics.console.sim-racing', 0.99);
    const r: any = await outcomeOf(listing());
    expect(r.err?.code).toBe('SHELF_UNCLEAR');
    expect(jevAsked).toHaveLength(0);
  });

  it('an amend is never put to Jev', async () => {
    jevAnswer = choice('goods.electronics.console.sim-racing', 0.99);
    vi.spyOn(db, 'getPool').mockReturnValue({
      query: async (text: string, params: any[] = []) =>
        /SELECT \* FROM cards WHERE id/.test(text)
          ? {
              rows: [{
                id: CARD, account_id: ACCOUNT, schema_version: SCHEMA_VERSION, type: 'HAVE',
                category: 'goods.sim-racing.pedal-parts', category_as_posted: 'goods.sim-racing.pedal-parts',
                kind: 'upgraded Fanatec pedal spring', geo: { bucket: 'r3gx', radius_km: 25, reach: 'country' },
                attributes: { brand: 'fanatec' }, ask: null, urgency: 'none', visibility: 'anonymous-until-match',
                protocol_status: 'active', lifecycle_state: 'PUBLISHED', price_enc: null, ttl_days: 60,
                expires_at: new Date('2026-11-01T00:00:00Z'), screening: null, slots: 1, sale: 'straight',
              }],
              rowCount: 1,
            }
          : fakePool().query(text, params),
    } as any);
    await amendIntent(cfg, ACCOUNT, CARD, { urgency: 'days' });
    expect(jevAsked).toHaveLength(0);
  });
});
