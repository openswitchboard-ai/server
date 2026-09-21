/**
 * OPTIONS FIRST, THEN A SEARCHABLE LIST, and the gap log beside it.
 *
 * Lachlan, 20 September 2026. SHELF_UNCLEAR's options in chat stay the first
 * step. "None of these" used to file the posting under the top level at once;
 * now it is answered with SHELF_PICK, a one-time link to a page where the human
 * searches every open shelf the catalogue has and taps one. And every time the
 * door is unsure, a row goes into shelf_gaps saying so, with no account id, no
 * attribute and no figure in it.
 *
 * What is asserted here:
 *   - SHELF_UNCLEAR writes an 'asked' row, once per question;
 *   - none_of_these comes back as SHELF_PICK: an ordinary answer, a link, a
 *     press_id, a 'none_of_these' row, and a live link handed back again
 *     rather than a second one minted;
 *   - the page filters server-side on ?q=, never lists a reserved or denied
 *     shelf, needs no PIN, survives being viewed, and burns on the press;
 *   - the press records the shelf and a 'picked_from_list' row, and
 *     wait_for_press hands the shelf back in `picked`;
 *   - the link is single-use and runs out;
 *   - posting again with the picked shelf goes up there, keeps the first path
 *     as the one the assistant sent, and closes the question;
 *   - a shelf chosen from the options in chat writes 'human_picked';
 *   - a bare top level sent after the question is read as "none of these";
 *   - a silent top-level filing writes 'top_level';
 *   - none of the rows carries an attribute value or a figure;
 *   - every new sentence passes the house lint.
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
vi.mock('../../src/crypto.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  encryptField: vi.fn(async () => Buffer.from('enc')),
  writeConsentEvent: vi.fn(async () => 'consent-events/x'),
  writeDecryptAudit: vi.fn(async () => 'decrypt-audit/x'),
}));
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

import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { sqs } from '../../src/aws.js';
import * as db from '../../src/db.js';
import { refsFake, type RefsFake } from './postingRefsFake.js';
import { initCounterKeys } from '../../src/counter/keys.js';
import { publishIntent } from '../../src/domain/cards.js';
import { waitForPress } from '../../src/domain/humanLinks.js';
import { SHELF_NONE_OPTION } from '../../src/domain/categoryBackfill.js';
import {
  SHELF_PICK_ACTION,
  foldForSearch,
  openLeaves,
  pickable,
  searchShelves,
  searchWords,
  shelfPickedNote,
} from '../../src/domain/shelfPick.js';
import {
  normaliseKind,
  shelfGapLine,
  summariseShelfGaps,
  type ShelfGapRow,
} from '../../src/domain/shelfGaps.js';
import { shelfCountLine } from '../../src/counter/pages.js';
import { protocolAnswer } from '../../src/mcp/tools.js';
import { OsbError, SCHEMA_VERSION } from '../../src/protocol.js';
import { lintHumanCopy } from '../../src/email/lint.js';
import { categoryDenied, categoryStatus } from '../../src/denylist.js';
import type { Config } from '../../src/config.js';

const cfg = {
  envName: 'dev',
  port: 0,
  publicOrigin: 'https://mcp.test',
  counterOrigin: 'https://my.test',
  legacyCounterHosts: ['counter.test'],
  sesFrom: 'x',
  sesReplyTo: 'x',
  sesConfigurationSet: 'x',
  emailEventsQueueUrl: 'x',
  dbSecretArn: 'x',
  screeningQueueUrl: 'https://queue.test/screening',
  matchingQueueUrl: 'x',
  opsQueueUrl: '',
  consentLogBucket: 'x',
  identityKeyArn: 'x',
  bedrockModelId: 'x',
  registrationMode: 'dev-bootstrap',
  region: 'us-east-1',
  quotas: { maxOpenCards: 20, maxPublishesPerDay: 20, maxOffersPerHour: 6 },
  docsBase: 'https://openswitchboard.ai/docs',
  settlementFeePercent: 0,
  settlementFeeFlatMinor: 100,
} as unknown as Config;

const ANA = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const CARD = 'cccccccc-3333-4333-8333-cccccccccccc';
const SID = 'osb_cs_testsessionvaluetestsessionvalue';
const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex');

/** The rehearsal's scattered shortlist: close, and across four branches. */
const SCATTERED = {
  categories: [
    'goods.motoring.parts',
    'goods.bicycle.parts',
    'goods.sports.equestrian',
    'goods.electronics.console.accessories',
  ],
  scored: [
    { category: 'goods.motoring.parts', score: 0.625, lead: 3.1 },
    { category: 'goods.bicycle.parts', score: 0.611, lead: 3.0 },
    { category: 'goods.sports.equestrian', score: 0.6, lead: 2.9 },
    { category: 'goods.electronics.console.accessories', score: 0.59, lead: 2.8 },
  ],
  source: 'embedding' as const,
};

/** Values that must never reach a gap row: attribute values and a figure. */
const SECRET_MODEL = 'zq-secret-model-771';
const SECRET_AMOUNT = 987654;

const listing = (over: Record<string, unknown> = {}) => ({
  schema_version: SCHEMA_VERSION,
  type: 'offering',
  category: 'goods.sim-racing.pedal-parts',
  kind: 'upgraded Fanatec pedal spring',
  attributes: { brand: 'fanatec', model: SECRET_MODEL, condition: 'good' },
  geo: { bucket: 'r3gx', radius_km: 25, reach: 'country' },
  ttl_days: 60,
  ...over,
});

interface LinkRow {
  id: string;
  token_hash: string;
  account_id: string;
  action: string;
  ref_id: string;
  amount: string | null;
  ccy: string | null;
  counterparty_account: string;
  payload: string | null;
  created_at: Date;
  expires_at: Date;
  used_at: Date | null;
  decision: string | null;
}
interface Attempt {
  account_id: string;
  kind_key: string;
  attempt: string;
  as_posted: string;
  kind: string | null;
  asked_at: Date;
  none_at: Date | null;
  picked: string | null;
}
interface World {
  sql: { text: string; params: any[] }[];
  links: LinkRow[];
  attempts: Attempt[];
  gaps: { attempt: string | null; as_posted: string; kind: string | null; shortlist: any[]; outcome: string; picked: string | null }[];
  inserted: any[][];
  /** The open posting attempts (domain/postingRef.ts), kept honestly so the
   *  figure gate behaves here exactly as it does at the real door. */
  refs: RefsFake;
}
let world: World;
let seq = 0;
const uuid = (n: number) => `11111111-0000-4000-8000-${String(n).padStart(12, '0')}`;

function fakePool() {
  return {
    query: async (sql: string, params: any[] = []) => {
      world.sql.push({ text: sql.replace(/\s+/g, ' ').trim(), params });
      const rows = (r: any[]) => ({ rows: r, rowCount: r.length });
      // The posting attempt's own number, which this suite only has to carry:
      // the reference itself is tested in postingReference.test.ts.
      const refs = world.refs.handle(sql, params);
      if (refs) return refs;
      // ---- shelf_attempts ----
      if (/INSERT INTO shelf_attempts/.test(sql)) {
        const existing = world.attempts.find((a) => a.account_id === params[0] && a.kind_key === params[1]);
        const attempt = uuid(++seq);
        if (existing) world.attempts.splice(world.attempts.indexOf(existing), 1);
        world.attempts.push({
          account_id: params[0],
          kind_key: params[1],
          attempt,
          as_posted: params[2],
          kind: params[3],
          asked_at: new Date(),
          none_at: null,
          picked: null,
        });
        return rows([{ attempt }]);
      }
      if (/DELETE FROM shelf_attempts/.test(sql)) {
        world.attempts = world.attempts.filter((x) => !(x.account_id === params[0] && x.attempt === params[1]));
        return rows([]);
      }
      if (/FROM shelf_attempts/.test(sql) && /kind_key = \$2/.test(sql)) {
        const a = world.attempts.find((x) => x.account_id === params[0] && x.kind_key === params[1]);
        return rows(a ? [a] : []);
      }
      if (/FROM shelf_attempts/.test(sql) && /attempt = \$2/.test(sql)) {
        const a = world.attempts.find((x) => x.account_id === params[0] && x.attempt === params[1]);
        return rows(a ? [a] : []);
      }
      if (/UPDATE shelf_attempts SET none_at/.test(sql)) {
        const a = world.attempts.find((x) => x.account_id === params[0] && x.attempt === params[1] && !x.none_at);
        if (!a) return rows([]);
        a.none_at = new Date();
        return rows([{ attempt: a.attempt }]);
      }
      if (/UPDATE shelf_attempts SET picked/.test(sql)) {
        const a = world.attempts.find((x) => x.account_id === params[0] && x.attempt === params[1]);
        if (!a) return rows([]);
        a.picked = params[2];
        return rows([{ attempt: a.attempt }]);
      }
      // ---- shelf_gaps ----
      if (/INSERT INTO shelf_gaps/.test(sql)) {
        world.gaps.push({
          attempt: params[0],
          as_posted: params[1],
          kind: params[2],
          shortlist: JSON.parse(params[3]),
          outcome: params[4],
          picked: params[5],
        });
        return rows([]);
      }
      // ---- approval_links ----
      if (/INSERT INTO approval_links/.test(sql)) {
        const id = uuid(++seq);
        world.links.push({
          id,
          token_hash: 'pending',
          account_id: params[0],
          action: params[1],
          ref_id: params[2],
          amount: params[3] === null ? null : String(params[3]),
          ccy: params[4],
          counterparty_account: params[5],
          payload: params[6] ?? null,
          created_at: new Date(),
          expires_at: new Date(Date.now() + 15 * 60_000),
          used_at: null,
          decision: null,
        });
        return rows([{ id }]);
      }
      if (/UPDATE approval_links SET token_hash/.test(sql)) {
        const row = world.links.find((l) => l.id === params[0]);
        if (row) row.token_hash = params[1];
        return rows([]);
      }
      if (/SELECT \* FROM approval_links WHERE id/.test(sql)) {
        const row = world.links.find((l) => l.id === params[0]);
        return rows(row ? [row] : []);
      }
      if (/SELECT \* FROM approval_links/.test(sql) && /action = 'shelf-pick'/.test(sql)) {
        return rows(
          world.links.filter(
            (l) =>
              l.account_id === params[0] &&
              l.action === 'shelf-pick' &&
              l.ref_id === params[1] &&
              !l.used_at &&
              l.expires_at.getTime() > Date.now() + 60_000,
          ),
        );
      }
      if (/FROM approval_links WHERE id = \$1 AND account_id = \$2/.test(sql)) {
        const row = world.links.find((l) => l.id === params[0] && l.account_id === params[1]);
        return rows(row ? [row] : []);
      }
      if (/UPDATE approval_links SET used_at/.test(sql)) {
        const row = world.links.find((l) => l.id === params[0] && !l.used_at);
        if (!row) return rows([]);
        row.used_at = new Date();
        return rows([{ id: row.id }]);
      }
      if (/UPDATE approval_links SET decision/.test(sql)) {
        const row = world.links.find((l) => l.id === params[0]);
        if (row) row.decision = params[1];
        return rows([]);
      }
      // ---- sessions ----
      if (/FROM counter_sessions/.test(sql) && /SELECT id, account_id/.test(sql)) {
        return params[0] === sha256hex(SID)
          ? rows([{ id: 'sess-1', account_id: ANA, pin_ok_until: null, oauth_ctx: null }])
          : rows([]);
      }
      // ---- cards and accounts, for the publish itself ----
      if (/INSERT INTO cards/.test(sql)) {
        world.inserted.push(params);
        return rows([{ id: CARD }]);
      }
      if (/FROM accounts/.test(sql) && /SELECT \*/.test(sql)) {
        return rows([{ id: ANA, data_key_enc: Buffer.from('k'), timezone: null, status: 'active' }]);
      }
      return rows([]);
    },
  } as any;
}

let app: FastifyInstance;

beforeEach(async () => {
  suggestions = SCATTERED;
  seq = 0;
  world = { sql: [], links: [], attempts: [], gaps: [], inserted: [], refs: refsFake() };
  vi.spyOn(db, 'getPool').mockReturnValue(fakePool());
  vi.spyOn(sqs, 'send').mockResolvedValue({} as never);
  process.env.COUNTER_LINK_HMAC_KEY = 'a'.repeat(64);
  process.env.COUNTER_COOKIE_KEY = 'b'.repeat(64);
  await initCounterKeys(cfg);
  if (!app) {
    app = buildApp(cfg);
    await app.ready();
  }
});

const inject = (method: 'GET' | 'POST', url: string, body?: Record<string, string>) =>
  app.inject({
    method,
    url,
    headers: {
      host: 'my.test',
      cookie: `osb_counter=${SID}`,
      ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
    },
    ...(body ? { payload: new URLSearchParams(body).toString() } : {}),
  });

const refusal = async (card: any, reference?: unknown) => {
  try {
    await publishIntent(cfg, ANA, card, { reference });
    return undefined;
  } catch (e) {
    if (e instanceof OsbError) return e.payload;
    throw e;
  }
};

/** Ask once (SHELF_UNCLEAR), answer none of these (SHELF_PICK): the page. */
async function toThePage() {
  const asked = await refusal(listing());
  expect(asked?.code).toBe('SHELF_UNCLEAR');
  const pick = (await refusal(listing({ category: SHELF_NONE_OPTION })))!;
  expect(pick.code).toBe('SHELF_PICK');
  const link = pick.human_action!.match(/https:\/\/my\.test\/a\/\S+/)![0];
  const token = link.split('/a/')[1];
  return { pick, link, token };
}

// ---------------------------------------------------------------------------
describe('none of these, answered with the searchable page', () => {
  it('SHELF_UNCLEAR writes one asked row, and asking again does not write another', async () => {
    await refusal(listing());
    await refusal(listing());
    const asked = world.gaps.filter((g) => g.outcome === 'asked');
    expect(asked).toHaveLength(1);
    expect(asked[0].as_posted).toBe('goods.sim-racing.pedal-parts');
    expect(asked[0].kind).toBe('upgraded Fanatec pedal spring');
    expect(asked[0].shortlist[0]).toEqual({ category: 'goods.motoring.parts', lead: 3.1 });
    expect(asked[0].shortlist.length).toBeLessThanOrEqual(5);
    expect(asked[0].attempt).toBeTruthy();
  });

  it('answers none_of_these with SHELF_PICK: a link, a press to wait on, an ordinary answer', async () => {
    const { pick, link } = await toThePage();
    expect(pick.press_id).toBe(world.links[0].id);
    expect(world.links[0].action).toBe('shelf-pick');
    expect(world.links[0].ref_id).toBe(world.attempts[0].attempt);
    expect(world.links[0].counterparty_account).toBe(ANA);
    expect(pick.human_action).toBe(`${SHELF_PICK_ACTION} ${link}`);
    expect(pick.human_action!.length).toBeLessThanOrEqual(300);
    // Nothing went up.
    expect(world.inserted).toHaveLength(0);
    // And it travels as the switchboard working, with the link lifted out.
    const answer: any = protocolAnswer(pick);
    expect(answer.isError).toBe(false);
    expect(answer.structuredContent.what_happened).toBe('shelf_pick');
    expect(answer.structuredContent.link).toBe(link);
    // The gap log has the question and the none.
    expect(world.gaps.map((g) => g.outcome)).toEqual(['asked', 'none_of_these']);
    expect(world.gaps[1].attempt).toBe(world.gaps[0].attempt);
  });

  it('hands back the same live page when none_of_these is sent twice, and logs it once', async () => {
    const first = await toThePage();
    const again = (await refusal(listing({ category: SHELF_NONE_OPTION })))!;
    expect(again.press_id).toBe(first.pick.press_id);
    expect(world.links).toHaveLength(1);
    expect(world.gaps.filter((g) => g.outcome === 'none_of_these')).toHaveLength(1);
  });

  it('refuses none_of_these where no shelf question is open', async () => {
    await expect(publishIntent(cfg, ANA, listing({ category: SHELF_NONE_OPTION }))).rejects.toMatchObject({
      validation: ['category'],
    });
  });

  it('reads a bare top level sent after the question as none of these', async () => {
    await refusal(listing());
    const p = (await refusal(listing({ category: 'goods' })))!;
    expect(p.code).toBe('SHELF_PICK');
    expect(world.inserted).toHaveLength(0);
  });
});

describe('the page', () => {
  it('filters on ?q= on the server, with every row printed and the rest hidden', async () => {
    const { token } = await toThePage();
    const r = await inject('GET', `/a/${token}?q=${encodeURIComponent('sim racing')}`);
    expect(r.statusCode).toBe(200);
    const html = r.body;
    // The sim-racing shelf is shown; an unrelated one is printed and hidden.
    const row = (cat: string) => html.match(new RegExp(`<li data-s="[^"]*"( hidden)?>\\s*<button[^>]*value="${cat.replace(/\./g, '\\.')}"`));
    expect(row('goods.electronics.console.sim-racing')?.[1]).toBeUndefined();
    expect(row('goods.bicycle.road')?.[1]).toBe(' hidden');
    expect(html).toContain('value="sim racing"');
    // The general shelf, and the way to leave it unposted.
    expect(html).toContain('Put it under things in general');
    expect(html).toContain('value="goods"');
    expect(html).toContain('Leave it unposted for now');
    // No ceremony on this page.
    expect(html).not.toMatch(/name="pin"/);
    // Viewing burns nothing.
    expect(world.links[0].used_at).toBeNull();
  });

  it('never lists a reserved or denied shelf', async () => {
    const { token } = await toThePage();
    const html = (await inject('GET', `/a/${token}`)).body;
    const offered = [...html.matchAll(/name="category" value="([^"]+)"/g)].map((m) => m[1]);
    expect(offered.length).toBeGreaterThan(100);
    for (const c of offered) {
      expect(categoryStatus(c).status, c).toBe('open');
      expect(categoryDenied(c), c).toBeUndefined();
    }
    expect(offered).not.toContain('services.trades.electrical');
    expect(offered.some((c) => c.startsWith('work.') || c.startsWith('property.'))).toBe(false);
    expect(offered.some((c) => c.startsWith('social.dating'))).toBe(false);
  });

  it('records the choice on the press, once, and wait_for_press hands it back', async () => {
    const { pick, token } = await toThePage();
    const pressed = await inject('POST', `/a/${token}`, {
      category: 'goods.electronics.console.sim-racing',
    });
    expect(pressed.statusCode).toBe(200);
    expect(pressed.body).toContain('It goes under sim racing wheels, pedals and rigs');
    expect(world.attempts[0].picked).toBe('goods.electronics.console.sim-racing');
    expect(world.links[0].used_at).not.toBeNull();
    expect(world.links[0].decision).toBe('approved');
    const row = world.gaps.find((g) => g.outcome === 'picked_from_list')!;
    expect(row.picked).toBe('goods.electronics.console.sim-racing');
    expect(row.attempt).toBe(world.attempts[0].attempt);

    const waited: any = await waitForPress(cfg, ANA, pick.press_id!, { capMs: 10, pollMs: 1 });
    expect(waited.pressed).toBe(true);
    expect(waited.picked).toEqual({
      category: 'goods.electronics.console.sim-racing',
      words: 'sim racing wheels, pedals and rigs',
    });
    expect(waited.what_to_do).toContain('category goods.electronics.console.sim-racing');

    // Single use: a second press finds nothing left to burn.
    const twice = await inject('POST', `/a/${token}`, { category: 'goods.bicycle.road' });
    expect(twice.body).toContain('already been used');
    expect(world.attempts[0].picked).toBe('goods.electronics.console.sim-racing');
  });

  it('refuses a shelf that is not on the page, without burning the link', async () => {
    const { token } = await toThePage();
    for (const bad of ['services.trades.electrical', 'goods.made-up.thing', 'social']) {
      const r = await inject('POST', `/a/${token}`, { category: bad });
      expect(r.statusCode, bad).toBe(400);
    }
    expect(world.links[0].used_at).toBeNull();
    expect(world.attempts[0].picked).toBeNull();
  });

  it('runs out like every other link', async () => {
    const { token } = await toThePage();
    world.links[0].expires_at = new Date(Date.now() - 1000);
    const r = await inject('GET', `/a/${token}`);
    expect(r.body).toContain('This link has expired');
  });

  it('can leave it unposted, which records nothing', async () => {
    const { token } = await toThePage();
    const r = await inject('POST', `/a/${token}`, { decision: 'no' });
    expect(r.body).toContain('Nothing went up');
    expect(world.links[0].decision).toBe('declined');
    expect(world.attempts[0].picked).toBeNull();
  });
});

describe('and then it goes up', () => {
  it('posts under the picked shelf, keeps the first path, and closes the question', async () => {
    const { token } = await toThePage();
    await inject('POST', `/a/${token}`, { category: 'goods.electronics.console.sim-racing' });
    const r: any = await publishIntent(
      cfg,
      ANA,
      listing({ category: 'goods.electronics.console.sim-racing' }),
    );
    expect(r.category).toBe('goods.electronics.console.sim-racing');
    // category_as_posted is the assistant's own first path.
    expect(world.inserted[0][21]).toBe('goods.sim-racing.pedal-parts');
    expect(world.attempts).toHaveLength(0);
    // The pick was logged at the press; nothing more is written for it.
    expect(world.gaps.map((g) => g.outcome)).toEqual(['asked', 'none_of_these', 'picked_from_list']);
  });

  it('also goes up when the assistant sends none_of_these again after the press', async () => {
    const { token } = await toThePage();
    await inject('POST', `/a/${token}`, { category: 'goods.electronics.console.sim-racing' });
    const r: any = await publishIntent(cfg, ANA, listing({ category: SHELF_NONE_OPTION }));
    expect(r.category).toBe('goods.electronics.console.sim-racing');
  });

  it('writes human_picked when a shelf from the options in chat comes back', async () => {
    await refusal(listing());
    const r: any = await publishIntent(cfg, ANA, listing({ category: 'goods.bicycle.parts' }));
    expect(r.category).toBe('goods.bicycle.parts');
    const row = world.gaps.find((g) => g.outcome === 'human_picked')!;
    expect(row.picked).toBe('goods.bicycle.parts');
    expect(row.attempt).toBe(world.gaps[0].attempt);
    expect(world.attempts).toHaveLength(0);
  });

  it('writes top_level when the door files it on its top level without asking', async () => {
    suggestions = { categories: [], scored: [], source: 'embedding' };
    const r: any = await publishIntent(cfg, ANA, listing({ category: 'goods.zz-nothing-near.thing' }));
    expect(r.category).toBe('goods');
    const row = world.gaps.find((g) => g.outcome === 'top_level')!;
    expect(row.picked).toBe('goods');
    expect(row.attempt).toBeNull();
  });
});

describe('what a gap row never holds', () => {
  it('carries no attribute value and no figure, and no account id, on any outcome', async () => {
    const priced = listing({
      price: { band: { max: SECRET_AMOUNT }, ccy: 'AUD' },
    });
    // The figure is read back first, which is where this attempt gets its
    // reference; everything after it carries that number (domain/postingRef.ts).
    const figure = (await refusal(priced))!;
    expect(figure.code).toBe('CONFIRM_FIGURE');
    const ref = figure.reference;
    await refusal(priced, ref);
    await refusal({ ...priced, category: SHELF_NONE_OPTION }, ref);
    suggestions = { categories: [], scored: [], source: 'embedding' };
    await refusal(listing({ category: 'goods.zz-nothing-near.thing', kind: 'another thing' }));
    const writes = world.sql.filter((s) => /INSERT INTO shelf_gaps/.test(s.text));
    expect(writes.length).toBeGreaterThanOrEqual(2);
    for (const w of writes) {
      const text = JSON.stringify(w.params);
      expect(text).not.toContain(SECRET_MODEL);
      expect(text).not.toContain(String(SECRET_AMOUNT));
      expect(text).not.toContain(ANA);
      expect(text).not.toContain('fanatec"'); // the brand attribute value on its own
      expect(w.text).not.toMatch(/account/);
    }
  });
});

describe('reading it back', () => {
  it('groups by the posters’ own words and says what humans picked', () => {
    const rows: ShelfGapRow[] = [
      ...Array.from({ length: 14 }, () => ({
        as_posted: 'goods.sim-racing',
        kind: 'Sim racing pedals',
        outcome: 'asked' as const,
        picked: null,
      })),
      ...Array.from({ length: 6 }, () => ({
        as_posted: 'goods.sim-racing',
        kind: 'sim-racing pedal',
        outcome: 'human_picked' as const,
        picked: 'goods.electronics.console.accessories',
      })),
      ...Array.from({ length: 5 }, () => ({
        as_posted: 'goods.sim-racing',
        kind: 'sim racing pedals',
        outcome: 'none_of_these' as const,
        picked: null,
      })),
    ];
    const [g] = summariseShelfGaps(rows, 'kind');
    expect(g.key).toBe('sim racing pedal');
    expect(normaliseKind('Sim-Racing Pedals')).toBe('sim racing pedal');
    const line = shelfGapLine(g, (c) => (c === 'goods.electronics.console.accessories' ? 'console accessories' : c));
    expect(line).toBe(
      'sim racing pedal: 14 times, picked console accessories 6, none of these 5, no answer yet 3',
    );
    expect(summariseShelfGaps(rows, 'as_posted')[0].key).toBe('goods.sim-racing');
  });
});

describe('the search, on its own', () => {
  it('keeps nothing for an empty search and every word for a real one', () => {
    expect(searchShelves('')).toEqual([]);
    const hits = searchShelves('Mountain Bikes');
    expect(hits.map((h) => h.category)).toContain('goods.bicycle.mountain');
    for (const h of hits) for (const w of searchWords('Mountain Bikes')) expect(h.haystack).toContain(w);
  });

  it('offers only open leaves, and the posting’s own top level at the bottom', () => {
    const leaves = openLeaves();
    expect(leaves.every((l) => l.category.includes('.'))).toBe(true);
    expect(pickable('goods', 'goods.sim-racing.pedal-parts')).toBe(true);
    expect(pickable('services', 'goods.sim-racing.pedal-parts')).toBe(false);
    expect(pickable('goods.bicycle', 'goods.x')).toBe(false); // a branch, not a leaf
  });

  it('folds the way the page script folds', () => {
    expect(foldForSearch('Gravel & Cyclocross Bikes')).toBe('gravel and cyclocross bikes');
    expect(foldForSearch('Café')).toBe('cafe');
  });
});

describe('every new sentence keeps the house style', () => {
  it('passes the lint', () => {
    const copy = [
      SHELF_PICK_ACTION,
      shelfPickedNote('goods.electronics.console.sim-racing').say,
      shelfPickedNote('goods').what_to_do,
      shelfCountLine(0, 0),
      shelfCountLine(2, 0),
      shelfCountLine(2, 1),
      shelfCountLine(2, 7),
    ];
    for (const c of copy) {
      expect(lintHumanCopy(c), c).toEqual([]);
      expect(c).not.toMatch(/\bmatch(es)?\b|\bscores?\b/i);
    }
  });

  it('keeps the page itself clean', async () => {
    const { token } = await toThePage();
    const html = (await inject('GET', `/a/${token}?q=pedal`)).body;
    // The page's own sentences: the rows are the catalogue's own labels
    // ("Trading cards" is what that shelf is called), so they are left out.
    const visible = html
      .replace(/<ul class="shelves"[\s\S]*?<\/ul>/, '')
      .replace(/<script[\s\S]*?<\/script>/g, '')
      .replace(/<style[\s\S]*?<\/style>/g, '')
      .replace(/<[^>]+>/g, ' ');
    expect(lintHumanCopy(visible)).toEqual([]);
    expect(visible).not.toMatch(/\bmatch(es)?\b|\bscores?\b/i);
  });
});
