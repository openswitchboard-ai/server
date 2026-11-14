/**
 * AN INTRODUCTION THAT ENDS TAKES ITS OPEN OFFERS WITH IT (14 November 2026;
 * src/domain/introductionEnds.ts, migration 072).
 *
 * Every way an introduction ends closes the figures still open on it, in the
 * same statement that ends it: 'withdrawn', marked closed_with_introduction.
 * An agreed figure is never touched, and an introduction that is still open
 * is never touched. Around it, from the review triage of the same code:
 *
 *  - lapse never ends an introduction whose deal is already agreed, and an
 *    accept is movement on the slot's clock (M14);
 *  - withdraw, decline and send_to_human are guarded transitions, so a race
 *    can neither write over a figure the ending closed nor park one on an
 *    introduction that ended (M17);
 *  - a decline cannot turn an ended introduction into a declined one (L20),
 *    and choosing a best offer declines only figures on introductions still
 *    open (L4);
 *  - the seller's best-offer result leaves out buyers whose introduction has
 *    ended (H3);
 *  - a buyer still in line cannot put a figure in (M5);
 *  - and every reader after it says what happened plainly.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/crypto.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  decryptFields: vi.fn(async (_a: string, _k: Buffer, fields: Record<string, Buffer>) =>
    Object.fromEntries(
      Object.entries(fields).map(([k, v]) => [k, v.toString('utf8').replace(/^enc:/, '')]),
    ),
  ),
  writeConsentEvent: vi.fn(async () => 'consent-events/x'),
  writeDecryptAudit: vi.fn(async () => 'decrypt-audit/x'),
}));

vi.mock('../../src/counter/email.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  sendOfferOnTheTableEmail: vi.fn(async () => ({ status: 'sent' })),
  sendDealAgreedEmail: vi.fn(async () => ({ status: 'sent' })),
  sendReceiptEmail: vi.fn(async () => ({ status: 'sent' })),
}));

import * as db from '../../src/db.js';
import * as receiptModule from '../../src/domain/receipt.js';
import * as matches from '../../src/domain/matches.js';
import * as offers from '../../src/domain/offers.js';
import * as sequencer from '../../src/domain/sequencer.js';
import { acceptNumberLink } from '../../src/domain/humanLinks.js';
import { offersOnMatch } from '../../src/domain/counterOps.js';
import { buildSteps, type StoryFacts } from '../../src/domain/matchStory.js';
import { endingClosesOffers } from '../../src/domain/introductionEnds.js';
import { lintHumanCopy } from '../../src/email/lint.js';
import { OsbError } from '../../src/protocol.js';
import type { Config } from '../../src/config.js';

const cfg = {
  envName: 'dev',
  counterOrigin: 'https://my.test',
  publicOrigin: 'https://mcp.test',
  quotas: { maxOpenCards: 5, maxPublishesPerDay: 10, maxOffersPerHour: 60 },
} as unknown as Config;

const ANA = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'; // buyer
const BEPPE = 'cccccccc-3333-4333-8333-cccccccccccc'; // seller
const CARD_W = 'dddddddd-4444-4444-8444-dddddddddddd';
const CARD_W2 = 'dddddddd-4444-4444-8444-ddddddddddd2';
const CARD_H = 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee';
const ENDING = 'aaaaaaaa-1111-4111-8111-000000000001'; // the one that ends
const LIVE = 'aaaaaaaa-1111-4111-8111-000000000002'; // the one that stays open
const offerId = (n: number) => `0f0f0f0f-0000-4000-8000-${String(n).padStart(12, '0')}`;

interface Intro {
  id: string;
  card_want: string;
  card_have: string;
  account_want: string;
  account_have: string;
  category: string;
  stage: number;
  state: string;
  live: boolean;
  channel_id: string | null;
  /** The slot's clock has run out (dueToLapse would find it). */
  stale?: boolean;
  archived_via?: string;
  severed_at?: Date | null;
}
interface Offer {
  id: string;
  match_id: string;
  proposer_account: string;
  amount: string;
  ccy: string;
  expiry: Date;
  state: string;
  message: null;
  authored_by: 'human' | 'agent';
  created_at: Date;
  updated_at: Date;
  closed_with_introduction: boolean;
}
interface World {
  intros: Intro[];
  offers: Offer[];
  sale: 'straight' | 'best-offer';
  /** Runs just before a guarded offer write, to stand in for a racing ending. */
  beforeWrite?: () => void;
  sql: string[];
}
let world: World;

const intro = (id: string, cardWant: string, over: Partial<Intro> = {}): Intro => ({
  id,
  card_want: cardWant,
  card_have: CARD_H,
  account_want: ANA,
  account_have: BEPPE,
  category: 'goods.bicycle.mountain',
  stage: 4,
  state: 'open',
  live: true,
  channel_id: null,
  severed_at: null,
  ...over,
});

let seq = 0;
const offer = (matchId: string, state: string, over: Partial<Offer> = {}): Offer => {
  const o: Offer = {
    id: offerId(++seq),
    match_id: matchId,
    proposer_account: ANA,
    amount: String(400 + seq),
    ccy: 'AUD',
    expiry: new Date(Date.now() + 7 * 86_400_000),
    state,
    message: null,
    authored_by: 'human',
    created_at: new Date(Date.now() - 60_000),
    updated_at: new Date(Date.now() - 60_000),
    closed_with_introduction: false,
    ...over,
  };
  world.offers.push(o);
  return o;
};

const OPEN = ['proposed', 'awaiting-human'];
const byId = (id: string) => world.intros.find((i) => i.id === id);
const hasAgreed = (id: string) =>
  world.offers.some((o) => o.match_id === id && o.state === 'accepted-by-human');

/**
 * The ending, as the database runs it: the matches UPDATE inside the CTE ends
 * whatever its WHERE finds, and the offers UPDATE beside it closes the open
 * figures on exactly those. Read from the statement itself, so a path that
 * forgot the offers half would close nothing here.
 */
function runEnding(sql: string, params: any[]) {
  const newState = sql.match(/SET state = '(\w+)'/)![1];
  let found: Intro[];
  if (/\(card_want = \$1 OR card_have = \$1\)/.test(sql)) {
    found = world.intros.filter(
      (i) =>
        (i.card_want === params[0] || i.card_have === params[0]) &&
        i.state === 'open' &&
        (!i.channel_id || i.stage < 4),
    );
  } else if (/card_have = \$1 AND id <> \$2/.test(sql)) {
    found = world.intros.filter((i) => i.card_have === params[0] && i.id !== params[1] && i.state === 'open');
  } else {
    found = world.intros.filter((i) => i.id === params[0]);
    if (/AND state = 'open'/.test(sql)) found = found.filter((i) => i.state === 'open');
  }
  if (/AND live/.test(sql)) found = found.filter((i) => i.live);
  if (/o\.state = 'accepted-by-human'/.test(sql)) found = found.filter((i) => !hasAgreed(i.id));
  for (const i of found) {
    i.state = newState;
    i.live = false;
    const via = sql.match(/archived_via = '([\w-]+)'/)?.[1] ?? (newState === 'archived' ? params[2] : undefined);
    if (via) i.archived_via = via;
    if (newState === 'closed') i.severed_at = new Date();
  }
  const closesOpenOnly = /UPDATE offers\s+SET state = 'withdrawn', closed_with_introduction = true[\s\S]*state IN \('proposed', 'awaiting-human'\)/.test(sql);
  if (closesOpenOnly) {
    const ids = new Set(found.map((i) => i.id));
    for (const o of world.offers) {
      if (ids.has(o.match_id) && OPEN.includes(o.state)) {
        o.state = 'withdrawn';
        o.closed_with_introduction = true;
        o.updated_at = new Date();
      }
    }
  }
  return found.map((i) => ({ id: i.id }));
}

/** A guarded offer write, read from its own WHERE. */
function runOfferWrite(sql: string, params: any[]) {
  world.beforeWrite?.();
  const to = sql.match(/UPDATE offers SET state='([\w-]+)'/)![1];
  const o = world.offers.find((x) => x.id === params[0]);
  if (!o) return [];
  const allowed = sql.match(/AND state IN \(([^)]*)\)/)?.[1] ?? (/AND state = 'proposed'/.test(sql) ? "'proposed'" : undefined);
  if (allowed && !allowed.includes(`'${o.state}'`)) return [];
  if (/m\.state = 'open'/.test(sql) && byId(o.match_id)?.state !== 'open') return [];
  o.state = to;
  o.updated_at = new Date();
  return [o];
}

function fakePool() {
  const query = async (sql: string, params: any[] = []) => {
    world.sql.push(sql);
    const rows = (r: any[]) => ({ rows: r, rowCount: r.length });
    if (/WITH ended AS \(/.test(sql)) return rows(runEnding(sql, params));
    if (/^\s*UPDATE offers SET state='(withdrawn|declined|awaiting-human)'/.test(sql)) {
      return rows(runOfferWrite(sql, params));
    }
    if (/UPDATE offers SET state='accepted-by-human'/.test(sql)) {
      const o = world.offers.find((x) => x.id === params[0])!;
      o.state = 'accepted-by-human';
      return rows([o]);
    }
    if (/UPDATE offers o SET state = 'declined'/.test(sql)) {
      // declineTheRest: only figures on introductions still open (L4).
      const scoped = /m\.state = 'open'/.test(sql);
      for (const o of world.offers) {
        const i = byId(o.match_id);
        if (o.id === params[1] || !OPEN.includes(o.state)) continue;
        if (i?.card_have !== params[0]) continue;
        if (scoped && i?.state !== 'open') continue;
        o.state = 'declined';
      }
      return rows([]);
    }
    if (/^SELECT \* FROM matches WHERE id = \$1/.test(sql)) return rows([byId(params[0])].filter(Boolean));
    if (/SELECT state FROM matches WHERE id = \$1 FOR SHARE/.test(sql)) {
      return rows([{ state: byId(params[0])!.state }]);
    }
    if (/SELECT \* FROM offers WHERE id/.test(sql)) return rows(world.offers.filter((o) => o.id === params[0]));
    if (/FROM offers o\s+JOIN matches m ON m\.id = o\.match_id WHERE o\.id/.test(sql)) {
      const o = world.offers.find((x) => x.id === params[0]);
      const i = o && byId(o.match_id);
      return rows(o && i ? [{ ...i, ...o, id: o.id, state: o.state, match_state: i.state }] : []);
    }
    // the slot clock (dueToLapse): live, open, gone quiet, and nothing agreed
    if (/m\.last_movement_at < now\(\)/.test(sql)) {
      const skipsAgreed = /o\.state = 'accepted-by-human'/.test(sql);
      return rows(
        world.intros
          .filter((i) => i.state === 'open' && i.live && i.stale && !(skipsAgreed && hasAgreed(i.id)))
          .map((i) => ({ id: i.id })),
      );
    }
    // the sale behind an introduction, and the best-offer reads
    if (/SELECT c\.id AS card_id, c\.sale/.test(sql)) {
      return rows([{ card_id: CARD_H, sale: world.sale, ask: null, gather_until: new Date(Date.now() - 1000), gather_closed_at: new Date(), open: false }]);
    }
    if (/SELECT c\.id FROM matches m JOIN cards c/.test(sql)) {
      return rows(world.sale === 'best-offer' ? [{ id: CARD_H }] : []);
    }
    if (/SELECT id, account_id, sale, category, geo_lat/.test(sql)) {
      return rows([{ id: CARD_H, account_id: BEPPE, sale: world.sale, category: 'goods.bicycle.mountain', gather_until: new Date(Date.now() - 1000), gather_closed_at: new Date(), ask: null }]);
    }
    if (/SELECT o\.id, o\.match_id, o\.amount, o\.ccy, o\.message, o\.state/.test(sql)) {
      const keepsEnded = !/m\.state = 'open' OR o\.state = 'accepted-by-human'/.test(sql);
      return rows(
        world.offers
          .filter((o) => ['proposed', 'awaiting-human', 'accepted-by-human'].includes(o.state))
          .filter((o) => keepsEnded || byId(o.match_id)?.state === 'open' || o.state === 'accepted-by-human')
          .sort((a, b) => Number(b.amount) - Number(a.amount))
          .map((o) => ({ ...o, want_urgency: null, want_lat: null, want_lon: null, reliability: 0.5 })),
      );
    }
    if (/SELECT c\.account_id, c\.price_enc/.test(sql)) return rows([]);
    if (/SELECT id, amount, ccy, state, expiry, proposer_account, authored_by, message/.test(sql)) {
      return rows(world.offers.filter((o) => o.match_id === params[0]));
    }
    if (/SELECT id, proposer_account, amount, ccy, state, message, authored_by, created_at/.test(sql)) {
      return rows(world.offers.filter((o) => o.match_id === params[0] && ['proposed', 'awaiting-human', 'accepted-by-human'].includes(o.state)));
    }
    if (/SELECT amount, ccy, message FROM offers/.test(sql)) {
      return rows(world.offers.filter((o) => o.match_id === params[0] && o.proposer_account !== params[1] && OPEN.includes(o.state)));
    }
    if (/SELECT hears_via FROM accounts/.test(sql)) return rows([{ hears_via: 'assistant' }]);
    return rows([]);
  };
  return { query, connect: async () => ({ query, release: () => {} }) } as any;
}

beforeEach(() => {
  seq = 0;
  world = {
    intros: [intro(ENDING, CARD_W), intro(LIVE, CARD_W2)],
    offers: [],
    sale: 'straight',
    sql: [],
  };
  vi.spyOn(db, 'getPool').mockReturnValue(fakePool());
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(receiptModule, 'buildReceipt').mockRejectedValue(new Error('not needed here'));
});

const refusal = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
    return undefined;
  } catch (e) {
    if (e instanceof OsbError) return e.payload as any;
    throw e;
  }
};

/** One open, one parked and one agreed figure on each of the two. */
function figuresOnBoth() {
  const on = (id: string) => ({
    proposed: offer(id, 'proposed'),
    parked: offer(id, 'awaiting-human'),
    agreed: offer(id, 'accepted-by-human', { proposer_account: BEPPE }),
  });
  return { ending: on(ENDING), live: on(LIVE) };
}

function expectClosedWithIt(f: ReturnType<typeof figuresOnBoth>) {
  for (const o of [f.ending.proposed, f.ending.parked]) {
    expect(o.state).toBe('withdrawn');
    expect(o.closed_with_introduction).toBe(true);
  }
  // An agreed figure is never touched.
  expect(f.ending.agreed.state).toBe('accepted-by-human');
  expect(f.ending.agreed.closed_with_introduction).toBe(false);
  // And nothing on the introduction that is still open moves at all.
  expect([f.live.proposed.state, f.live.parked.state, f.live.agreed.state]).toEqual([
    'proposed',
    'awaiting-human',
    'accepted-by-human',
  ]);
  expect(byId(LIVE)!.state).toBe('open');
}

// ---------------------------------------------------------------------------
describe('every way an introduction ends closes its open figures', () => {
  it('a decline', async () => {
    const f = figuresOnBoth();
    await matches.declineMatch(ENDING, ANA, cfg);
    expect(byId(ENDING)!.state).toBe('declined');
    expectClosedWithIt(f);
  });

  it('"not the thing", which closes as a decline does', async () => {
    const f = figuresOnBoth();
    await matches.notTheThing(ENDING, ANA, cfg);
    expectClosedWithIt(f);
  });

  it('a bad-match verdict', async () => {
    const f = figuresOnBoth();
    await matches.recordVerdict(ENDING, ANA, 'bad', 'counter', cfg);
    expect(byId(ENDING)!.state).toBe('declined');
    expectClosedWithIt(f);
  });

  it('an archive', async () => {
    const f = figuresOnBoth();
    await matches.archiveMatch(ENDING, ANA, 'agent-attested', cfg);
    expect(byId(ENDING)!.state).toBe('archived');
    expectClosedWithIt(f);
  });

  it('a posting taken down, which keeps an open conversation and its figures', async () => {
    const f = figuresOnBoth();
    byId(LIVE)!.card_want = CARD_W; // the same want, but already talking
    byId(LIVE)!.channel_id = 'ch-1';
    const n = await matches.archiveOpenIntroductionsOnCard(CARD_W, ANA, 'withdrawn', cfg);
    expect(n).toBe(1);
    expect(byId(ENDING)!.archived_via).toBe('withdrawn');
    expectClosedWithIt(f);
  });

  it('a report or a suspension (sever)', async () => {
    const f = figuresOnBoth();
    const r = await matches.severMatch(ENDING, undefined, cfg);
    expect(r.severed).toBe(true);
    expect(byId(ENDING)!.state).toBe('closed');
    expectClosedWithIt(f);
  });

  it('a slot that lapsed', async () => {
    const f = figuresOnBoth();
    f.ending.agreed.state = 'declined'; // nothing agreed here, so it may lapse
    byId(ENDING)!.stale = true;
    const out = await sequencer.lapseDueSlots(cfg);
    expect(out.lapsed).toBe(1);
    expect(byId(ENDING)!.archived_via).toBe('lapsed');
    expect(f.ending.proposed.state).toBe('withdrawn');
    expect(f.ending.parked.state).toBe('withdrawn');
    expect(f.live.proposed.state).toBe('proposed');
  });

  it('the seller choosing someone else on a best offer: declined, and only on open ones (L4)', async () => {
    world.sale = 'best-offer';
    byId(LIVE)!.state = 'archived'; // a buyer whose introduction already ended
    const lateFigure = offer(LIVE, 'withdrawn', { closed_with_introduction: true });
    const winner = offer(ENDING, 'proposed');
    const third = intro('aaaaaaaa-1111-4111-8111-000000000003', 'dddddddd-4444-4444-8444-ddddddddddd3');
    world.intros.push(third);
    const loser = offer(third.id, 'proposed');
    await offers.acceptOfferByHuman(winner.id, BEPPE, 'counter', cfg);
    expect(loser.state).toBe('declined');
    expect(third.archived_via).toBe('not-chosen');
    expect(lateFigure.state).toBe('withdrawn'); // never re-labelled as turned down
  });
});

// ---------------------------------------------------------------------------
describe('lapse and an agreed deal (M14)', () => {
  it('never lapses an introduction whose figure is agreed', async () => {
    offer(ENDING, 'accepted-by-human');
    byId(ENDING)!.stale = true;
    const out = await sequencer.lapseDueSlots(cfg);
    expect(out.lapsed).toBe(0);
    expect(byId(ENDING)!.state).toBe('open');
  });

  it('asks it of both the sweep and the statement that ends it', () => {
    const src = readFileSync(new URL('../../src/domain/sequencer.ts', import.meta.url), 'utf8');
    const lapse = src.slice(src.indexOf('export async function lapseDueSlots'));
    const due = src.slice(src.indexOf('export async function dueToLapse'), src.indexOf('export async function openGatheringWindow'));
    expect(due).toMatch(/o\.state = 'accepted-by-human'/);
    expect(lapse.slice(0, 1500)).toMatch(/o\.state = 'accepted-by-human'/);
  });

  it('an accept is movement on the slot clock', async () => {
    const o = offer(ENDING, 'proposed');
    await offers.acceptOfferByHuman(o.id, BEPPE, 'counter', cfg);
    expect(world.sql.some((s) => /UPDATE matches SET last_movement_at = now\(\)/.test(s))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('nothing is touched that is still open', () => {
  it('an ending that finds its introduction already ended closes nothing on another', async () => {
    const f = figuresOnBoth();
    byId(ENDING)!.state = 'archived';
    await refusal(() => matches.declineMatch(ENDING, ANA, cfg));
    expect(f.live.proposed.state).toBe('proposed');
  });

  it('a decline never turns an ended introduction into a declined one (L20)', () => {
    const src = readFileSync(new URL('../../src/domain/matches.ts', import.meta.url), 'utf8');
    const decline = src.slice(src.indexOf('export async function declineMatch'), src.indexOf('export async function notTheThing'));
    expect(decline).toMatch(/SET state = 'declined'[\s\S]*WHERE id = \$1 AND state = 'open'/);
  });
});

// ---------------------------------------------------------------------------
describe('the ending is one statement, wherever it is written', () => {
  it('closes only figures still on the table, on the ids it ended', () => {
    const sql = endingClosesOffers(`UPDATE matches SET state = 'declined' WHERE id = $1 RETURNING id`);
    expect(sql).toMatch(/^WITH ended AS \(UPDATE matches/);
    expect(sql).toMatch(/WHERE match_id IN \(SELECT id FROM ended\)\s+AND state IN \('proposed', 'awaiting-human'\)/);
    expect(sql).not.toMatch(/accepted-by-human/);
    expect(sql).toMatch(/SET state = 'withdrawn', closed_with_introduction = true/);
    expect(sql.trim()).toMatch(/SELECT ended\.id FROM ended$/);
  });

  it('refuses an ending that does not hand back its ids', () => {
    expect(() => endingClosesOffers(`UPDATE matches SET state = 'declined' WHERE id = $1`)).toThrow();
  });

  it('every statement in the server that ends an introduction goes through it', () => {
    const dir = new URL('../../src/domain/', import.meta.url);
    const found: string[] = [];
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.ts'))) {
      const src = readFileSync(new URL(f, dir), 'utf8');
      const re = /UPDATE matches(?:\s+m)?\s+SET state = '(declined|closed|archived)'/g;
      for (let m = re.exec(src); m; m = re.exec(src)) {
        const before = src.slice(Math.max(0, m.index - 120), m.index);
        found.push(f);
        expect(before, `${f}: an ending outside endingClosesOffers`).toMatch(/endingClosesOffers\(\s*`\s*$/);
      }
    }
    // decline, verdict, sever, archive, withdraw (matches.ts); two lapses
    // (sequencer.ts); not-chosen (offers.ts).
    expect(found.filter((f) => f === 'matches.ts')).toHaveLength(5);
    expect(found.filter((f) => f === 'sequencer.ts')).toHaveLength(2);
    expect(found.filter((f) => f === 'offers.ts')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
describe('the figures left open before today (migration 072)', () => {
  const sql = readFileSync(
    new URL('../../migrations/072_offers_end_with_their_introduction.sql', import.meta.url),
    'utf8',
  );
  const update = sql.slice(sql.indexOf('UPDATE offers'));

  it('closes only figures on the table, on introductions already ended', () => {
    expect(update).toMatch(/m\.state IN \('declined', 'closed', 'archived'\)/);
    expect(update).toMatch(/o\.state IN \('proposed', 'awaiting-human'\)/);
    expect(update).not.toMatch(/'open'/);
    expect(update).not.toMatch(/accepted-by-human/);
    expect(update).toMatch(/SET state = 'withdrawn',\s+closed_with_introduction = true/);
  });

  it('adds no offer state: the CHECK is left as it was', () => {
    expect(sql).not.toMatch(/offers_state_check|ADD CONSTRAINT/);
  });
});

// ---------------------------------------------------------------------------
describe('guarded transitions (M17)', () => {
  it('a withdrawal racing the ending writes nothing over the closed figure', async () => {
    const o = offer(ENDING, 'proposed');
    world.beforeWrite = () => {
      byId(ENDING)!.state = 'archived';
      o.state = 'withdrawn';
      o.closed_with_introduction = true;
    };
    const p = await refusal(() => offers.agentOfferAction(cfg, ANA, o.id, 'withdraw_offer'));
    expect(p.human_action).toBe(offers.INTRODUCTION_ENDED_WORDS);
    expect(o.closed_with_introduction).toBe(true);
  });

  it('a decline racing an accept leaves the deal agreed', async () => {
    const o = offer(ENDING, 'proposed');
    world.beforeWrite = () => {
      o.state = 'accepted-by-human';
    };
    const p = await refusal(() => offers.agentOfferAction(cfg, BEPPE, o.id, 'decline_offer'));
    expect(p.code).toBe('NOT_UNLOCKED_YET');
    expect(o.state).toBe('accepted-by-human');
  });

  it('nothing is parked for a human on an introduction that ended a moment ago', async () => {
    const o = offer(ENDING, 'proposed');
    world.beforeWrite = () => {
      byId(ENDING)!.state = 'declined';
    };
    const p = await refusal(() => offers.agentOfferAction(cfg, BEPPE, o.id, 'send_to_human'));
    expect(p.human_action).toBe(offers.INTRODUCTION_ENDED_WORDS);
    expect(o.state).toBe('proposed');
  });

  it('the guarded writes still go through on a live introduction', async () => {
    const a = offer(ENDING, 'proposed');
    const b = offer(ENDING, 'proposed');
    const c = offer(ENDING, 'proposed');
    expect(((await offers.agentOfferAction(cfg, BEPPE, a.id, 'send_to_human')) as any).state).toBe('awaiting-human');
    expect(((await offers.agentOfferAction(cfg, BEPPE, b.id, 'decline_offer')) as any).state).toBe('declined');
    expect(((await offers.agentOfferAction(cfg, ANA, c.id, 'withdraw_offer')) as any).state).toBe('withdrawn');
  });
});

// ---------------------------------------------------------------------------
describe('what everybody is told about a figure closed with its introduction', () => {
  const closedOne = () => {
    byId(ENDING)!.state = 'archived';
    return offer(ENDING, 'withdrawn', { closed_with_introduction: true });
  };

  it('the accept says the introduction ended, never "it is withdrawn"', async () => {
    const o = closedOne();
    const p = await refusal(() => offers.acceptOfferByHuman(o.id, BEPPE, 'counter', cfg));
    expect(p.human_action).toBe(offers.INTRODUCTION_ENDED_WORDS);
    expect(p.human_action).not.toMatch(/withdrawn/);
  });

  it('so does the page link and every agent action on it', async () => {
    const o = closedOne();
    expect((await refusal(() => acceptNumberLink(cfg, BEPPE, o.id))).human_action).toBe(
      offers.INTRODUCTION_ENDED_WORDS,
    );
    for (const action of ['send_to_human', 'decline_offer'] as const) {
      expect((await refusal(() => offers.agentOfferAction(cfg, BEPPE, o.id, action))).human_action).toBe(
        offers.INTRODUCTION_ENDED_WORDS,
      );
    }
    expect((await refusal(() => offers.agentOfferAction(cfg, ANA, o.id, 'withdraw_offer'))).human_action).toBe(
      offers.INTRODUCTION_ENDED_WORDS,
    );
  });

  it('an agreed figure on a finished introduction keeps the answer it always had', async () => {
    byId(ENDING)!.state = 'archived';
    const o = offer(ENDING, 'accepted-by-human');
    const p = await refusal(() => offers.acceptOfferByHuman(o.id, BEPPE, 'counter', cfg));
    expect(p.human_action).toMatch(/no longer open to accept/);
  });

  it('the sweep and the table carry nothing of it', async () => {
    closedOne();
    expect(await offers.offerTable(BEPPE, ENDING)).toEqual([]);
    expect(offers.offerTableNote([], 'mountain bike')).toBeUndefined();
  });

  it('the match page calls it closed', async () => {
    const o = closedOne();
    offer(ENDING, 'withdrawn');
    const rows = await offersOnMatch(ENDING);
    expect(rows.map((r) => r.state)).toEqual(['closed', 'withdrawn']);
    expect(rows[0]).not.toHaveProperty('closed_with_introduction');
    expect(rows[0].id).toBe(o.id);
  });

  it('the story says it closed when this one ended, in words that pass the copy rules', () => {
    const at = new Date('2026-11-10T00:00:00Z');
    const facts = (closedWithIntroduction: boolean, expiry = new Date('2026-11-20T00:00:00Z')): StoryFacts => ({
      viewer: ANA,
      match: { id: ENDING, state: 'archived', stage: 3, created_at: new Date('2026-11-01T00:00:00Z'), account_want: ANA, account_have: BEPPE },
      theirName: 'Beppe',
      optIns: [],
      photos: [],
      messages: [],
      offers: [
        { id: 'o1', proposer_account: ANA, amount: '415', ccy: 'AUD', state: 'withdrawn', created_at: new Date('2026-11-02T00:00:00Z'), updated_at: at, expiry, closedWithIntroduction },
        { id: 'o2', proposer_account: BEPPE, amount: '430', ccy: 'AUD', state: 'withdrawn', created_at: new Date('2026-11-03T00:00:00Z'), updated_at: at, expiry, closedWithIntroduction },
      ],
    });
    const texts = buildSteps(facts(true), new Date('2026-11-14T00:00:00Z')).map((s) => s.text);
    expect(texts).toContain('Your $415 AUD closed when this one ended');
    expect(texts).toContain("Beppe's $430 AUD closed when this one ended");
    expect(texts.join(' ')).not.toMatch(/withdrew/);
    for (const t of texts) expect(lintHumanCopy(t)).toEqual([]);
    // One that had already run out before the ending lapsed, and says so.
    const ranOut = buildSteps(facts(true, new Date('2026-11-05T00:00:00Z')), new Date('2026-11-14T00:00:00Z')).map((s) => s.text);
    expect(ranOut).toContain('Your $415 AUD lapsed');
    // A withdrawal by the person who made it still reads as one.
    const theirs = buildSteps(facts(false), new Date('2026-11-14T00:00:00Z')).map((s) => s.text);
    expect(theirs).toContain('You withdrew your $415 AUD');
  });
});

// ---------------------------------------------------------------------------
describe("the seller's best-offer result (H3)", () => {
  beforeEach(() => {
    world.sale = 'best-offer';
  });

  it('leaves out a buyer whose introduction has ended, even with a figure left open', async () => {
    offer(LIVE, 'proposed', { amount: '500' });
    const stale = offer(ENDING, 'proposed', { amount: '900' }); // a row from before today
    byId(ENDING)!.state = 'archived';
    const result = (await offers.bestOfferResult(CARD_H, BEPPE))!;
    expect(result.offers.map((o) => o.amount)).toEqual([500]);
    expect(result.note).toContain('One person has');
    expect(JSON.stringify(result)).not.toContain(stale.id);
  });

  it('keeps an agreed figure on an introduction since filed away', async () => {
    offer(ENDING, 'accepted-by-human', { amount: '700' });
    byId(ENDING)!.state = 'archived';
    const result = (await offers.bestOfferResult(CARD_H, BEPPE))!;
    expect(result.offers.map((o) => o.amount)).toEqual([700]);
  });

  it('answers nothing where every buyer has gone', async () => {
    offer(ENDING, 'proposed');
    byId(ENDING)!.state = 'declined';
    expect(await offers.bestOfferResult(CARD_H, BEPPE)).toBeUndefined();
  });

  it('the count behind the close notice reads it the same way', () => {
    const src = readFileSync(new URL('../../src/domain/offers.ts', import.meta.url), 'utf8');
    const count = src.slice(src.indexOf('export async function bestOfferNumbersIn'));
    expect(count.slice(0, 900)).toMatch(/m\.state = 'open' OR o\.state = 'accepted-by-human'/);
  });
});

// ---------------------------------------------------------------------------
describe('a buyer still in line puts no figure in (M5)', () => {
  it('is refused with the sentence the sweep gives them, and nothing is written', async () => {
    byId(ENDING)!.live = false;
    const p = await refusal(() =>
      offers.proposeOffer(
        cfg,
        ANA,
        { match_id: ENDING, amount: 450, ccy: 'AUD', expiry: new Date(Date.now() + 86_400_000).toISOString() },
        { author: 'human' },
      ),
    );
    expect(p.code).toBe('NOT_UNLOCKED_YET');
    expect(p.human_action).toContain(matches.IN_LINE_HEAD);
    expect(world.sql.some((s) => /INSERT INTO offers/.test(s))).toBe(false);
  });
});
