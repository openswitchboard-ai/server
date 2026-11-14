/**
 * ONE ENTRY PER PERSON FOR LISTS (14 November 2026; migration 074;
 * src/domain/pairings.ts, src/domain/quantities.ts).
 *
 * Held here against a board in memory, faked at the pool:
 *
 *  - which pairs are grouped (two list items on goods, nothing else), and
 *    that an ordinary posting is never grouped;
 *  - what two lists allow, for every pair of deals;
 *  - the upsert: two matching runs racing from both sides land on one pairing;
 *  - the ranking, and the sequencing (P live per person, both need room);
 *  - the check_in entry's shape: one per person, their words labelled, no
 *    identifier ever, the maybes apart, the next step;
 *  - ending a pairing ends every member in one statement and closes their
 *    open figures; one item not being it ends that item alone;
 *  - quantities coming down, and an item going down at none left;
 *  - and the ordinary line: a posting that is not a list item counts, waits
 *    and is swept exactly as before.
 */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/crypto.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  writeConsentEvent: vi.fn(async () => 'consent-events/x'),
  writeDecryptAudit: vi.fn(async () => 'decrypt-audit/x'),
}));

import * as db from '../../src/db.js';
import * as pairings from '../../src/domain/pairings.js';
import * as quantities from '../../src/domain/quantities.js';
import * as matches from '../../src/domain/matches.js';
import { lineCounts, type OwnLineRow } from '../../src/domain/sequencer.js';
import { readListItem } from '../../src/domain/lists.js';
import { lintHumanCopy } from '../../src/email/lint.js';
import { OsbError } from '../../src/protocol.js';
import type { Config } from '../../src/config.js';

const {
  dealsAllow,
  groupsAsPairing,
  pairKey,
  rankPairings,
  factsOfPairing,
  UPSERT_PAIRING_SQL,
  joinPairing,
  resequencePairings,
  endPairing,
  pairingEntry,
  memberEndingSql,
  itemNotTheThing,
  countsSentence,
  dealSentence,
} = pairings;

const cfg = { envName: 'dev', counterOrigin: 'https://my.test', publicOrigin: 'https://mcp.test' } as unknown as Config;

const ANA = 'aaaaaaaa-0000-4000-8000-000000000001';
const BEPPE = 'bbbbbbbb-0000-4000-8000-000000000002';
const id = (prefix: string, n: number) => `${prefix}${String(n).padStart(7, '0')}-1111-4111-8111-111111111111`;

// ---------------------------------------------------------------------------
// The board in memory.
// ---------------------------------------------------------------------------

interface Card {
  id: string;
  account_id: string;
  type: 'WANT' | 'HAVE';
  list_id: string | null;
  category: string;
  kind: string;
  attributes: Record<string, unknown>;
  screened_content: any;
  lifecycle_state: string;
  quantity_gone: number;
  withdrawn_because?: string | null;
  geo_lat: number | null;
  geo_lon: number | null;
}
interface Match {
  id: string;
  card_want: string;
  card_have: string;
  account_want: string;
  account_have: string;
  certainty: 'sure' | 'possible';
  state: string;
  live: boolean;
  stage: number;
  channel_id: string | null;
  pairing_id: string | null;
  item_set_aside_at: Date | null;
  archived_via?: string | null;
  interest_want: boolean;
  interest_have: boolean;
  created_at: Date;
  swap?: boolean;
  category: string;
  kind: string;
}
interface Offer {
  id: string;
  match_id: string;
  proposer_account: string;
  amount: string;
  ccy: string;
  state: string;
  message: null;
  authored_by: 'human';
  created_at: Date;
  closed_with_introduction?: boolean;
}
interface World {
  cards: Map<string, Card>;
  lists: Map<string, { id: string; deal: string }>;
  matches: Match[];
  offers: Offer[];
  pairings: any[];
  sql: string[];
}
let w: World;
let seq = 0;

function card(over: Partial<Card> & { id: string; account_id: string; type: 'WANT' | 'HAVE' }): Card {
  const c: Card = {
    list_id: null,
    category: 'goods.bicycle.parts',
    kind: 'thing',
    attributes: {},
    screened_content: null,
    lifecycle_state: 'PUBLISHED',
    quantity_gone: 0,
    geo_lat: -35.28,
    geo_lon: 149.13,
    ...over,
  };
  if (!c.screened_content) {
    c.screened_content = { version: 1, at: 'x', kind: c.kind, attributes: c.attributes, ask: null };
  }
  w.cards.set(c.id, c);
  return c;
}

function list(listId: string, deal: string) {
  w.lists.set(listId, { id: listId, deal });
  return listId;
}

function match(over: Partial<Match> & { card_want: string; card_have: string }): Match {
  const want = w.cards.get(over.card_want)!;
  const have = w.cards.get(over.card_have)!;
  const m: Match = {
    id: id('a', ++seq),
    account_want: want.account_id,
    account_have: have.account_id,
    certainty: 'sure',
    state: 'open',
    live: false,
    stage: 2,
    channel_id: null,
    pairing_id: null,
    item_set_aside_at: null,
    interest_want: true,
    interest_have: true,
    created_at: new Date(Date.now() - 1000 * (100 - seq)),
    category: want.category,
    kind: want.kind,
    ...over,
  };
  w.matches.push(m);
  return m;
}

const pairingById = (pid: string) => w.pairings.find((p) => p.id === pid);

/** RECOUNT_SQL, worked out the same way in memory. */
function recount(ids: string[]) {
  for (const p of w.pairings.filter((x) => ids.includes(x.id))) {
    const usable = w.matches
      .filter((m) => m.pairing_id === p.id && m.state === 'open' && !m.item_set_aside_at)
      .map((m) => {
        const wc = w.cards.get(m.card_want)!;
        const hc = w.cards.get(m.card_have)!;
        if (wc.lifecycle_state !== 'PUBLISHED' || hc.lifecycle_state !== 'PUBLISHED') return undefined;
        const d = dealsAllow(w.lists.get(hc.list_id!)!.deal, w.lists.get(wc.list_id!)!.deal);
        return d.sale || d.trade || d.free ? { m, d } : undefined;
      })
      .filter((x): x is { m: Match; d: ReturnType<typeof dealsAllow> } => !!x);
    const dir = (acct: string) => usable.filter((x) => x.m.account_want === acct);
    const items = (xs: typeof usable, sureOnly: boolean) =>
      new Set(xs.filter((x) => !sureOnly || x.m.certainty !== 'possible').map((x) => x.m.card_have)).size;
    const lo = dir(p.account_lo);
    const hi = dir(p.account_hi);
    Object.assign(p, {
      lo_gets_sure: items(lo, true),
      lo_gets_maybe: items(lo, false) - items(lo, true),
      hi_gets_sure: items(hi, true),
      hi_gets_maybe: items(hi, false) - items(hi, true),
      sale_to_lo: lo.some((x) => x.d.sale),
      sale_to_hi: hi.some((x) => x.d.sale),
      trade_to_lo: lo.some((x) => x.d.trade),
      trade_to_hi: hi.some((x) => x.d.trade),
      free_to_lo: lo.some((x) => x.d.free),
      free_to_hi: hi.some((x) => x.d.free),
    });
  }
}

/** A tick, so racing callers interleave the way two transactions would. */
const tick = () => new Promise((r) => setTimeout(r, 0));

async function run(sql: string, params: any[] = []): Promise<{ rows: any[]; rowCount: number }> {
  w.sql.push(sql);
  const out = (rows: any[]) => ({ rows, rowCount: rows.length });
  const s = sql.replace(/\s+/g, ' ').trim();
  if (/^(BEGIN|COMMIT|ROLLBACK)/.test(s)) return out([]);
  if (s.startsWith('INSERT INTO matches')) {
    const [cw, ch] = params;
    if (w.matches.some((m) => m.card_want === cw && m.card_have === ch)) return out([]);
    const m = match({ card_want: cw, card_have: ch });
    return out([{ id: m.id }]);
  }
  if (s.startsWith('INSERT INTO pairings')) {
    // Both racing runs get here before either has written: the partial
    // unique index on (lo, hi) WHERE state = 'open' is what decides.
    await tick();
    const [lo, hi, anchor] = params;
    const found = w.pairings.find((p) => p.account_lo === lo && p.account_hi === hi && p.state === 'open');
    if (found) {
      found.anchor_match_id ??= anchor;
      return out([{ id: found.id, live: found.live, anchor_match_id: found.anchor_match_id }]);
    }
    const p = {
      id: id('f', ++seq),
      account_lo: lo,
      account_hi: hi,
      state: 'open',
      live: false,
      anchor_match_id: anchor,
      created_at: new Date(Date.now() - 1000 * (100 - seq)),
      lo_gets_sure: 0,
      lo_gets_maybe: 0,
      hi_gets_sure: 0,
      hi_gets_maybe: 0,
    };
    w.pairings.push(p);
    return out([{ id: p.id, live: false, anchor_match_id: anchor }]);
  }
  if (s.startsWith('UPDATE matches SET pairing_id = $2')) {
    const m = w.matches.find((x) => x.id === params[0])!;
    m.pairing_id = params[1];
    if (params[2]) m.live = true;
    return out([]);
  }
  if (s.startsWith('WITH u AS')) {
    recount(params[0]);
    return out(params[0].map((x: string) => ({ id: x })));
  }
  if (s.startsWith('SELECT count(*)::int AS n FROM pairings')) {
    const n = w.pairings.filter((p) => (p.account_lo === params[0] || p.account_hi === params[0]) && p.state === 'open' && p.live).length;
    return out([{ n }]);
  }
  if (s.startsWith('SELECT p.*, COALESCE(rep.score')) {
    const rows = w.pairings
      .filter((p) => (p.account_lo === params[0] || p.account_hi === params[0]) && p.state === 'open')
      .map((p) => ({ ...p, reliability: 0.5, w_lat: null, w_lon: null, h_lat: null, h_lon: null }));
    return out(rows);
  }
  if (s.startsWith('UPDATE pairings SET live = true')) {
    const p = pairingById(params[0]);
    if (!p || p.state !== 'open' || p.live) return out([]);
    p.live = true;
    return out([{ id: p.id }]);
  }
  if (s.startsWith('UPDATE matches SET live = true')) {
    for (const m of w.matches) if (m.pairing_id === params[0] && m.state === 'open') m.live = true;
    return out([]);
  }
  if (s.startsWith('UPDATE pairings SET state = $2')) {
    const p = pairingById(params[0]);
    if (!p || p.state !== 'open') return out([]);
    Object.assign(p, { state: params[1], live: false, ended_via: params[2] });
    return out([{ account_lo: p.account_lo, account_hi: p.account_hi, anchor_match_id: p.anchor_match_id }]);
  }
  if (s.startsWith('WITH ended AS')) {
    // endingClosesOffers around one of the member endings.
    const newState = s.match(/SET state = '(\w+)'/)![1];
    let found: Match[];
    if (/WHERE pairing_id = \$1 AND state = 'open'/.test(s)) {
      found = w.matches.filter((m) => m.pairing_id === params[0] && m.state === 'open');
    } else if (/WHERE \(card_want = \$1 OR card_have = \$1\) AND state = 'open' AND id <> \$2/.test(s)) {
      found = w.matches.filter(
        (m) =>
          (m.card_want === params[0] || m.card_have === params[0]) &&
          m.state === 'open' &&
          m.id !== params[1] &&
          (!m.channel_id || m.stage < 4) &&
          !w.offers.some((o) => o.match_id === m.id && o.state === 'accepted-by-human') &&
          !w.pairings.some((p) => p.anchor_match_id === m.id && p.state === 'open'),
      );
    } else if (/WHERE \(card_want = \$1 OR card_have = \$1\) AND state = 'open'/.test(s)) {
      // archiveOpenIntroductionsOnCard: no conversation, and never an open pairing's anchor.
      found = w.matches.filter(
        (m) =>
          (m.card_want === params[0] || m.card_have === params[0]) &&
          m.state === 'open' &&
          (!m.channel_id || m.stage < 4) &&
          !w.pairings.some((p) => p.anchor_match_id === m.id && p.state === 'open'),
      );
    } else {
      found = w.matches.filter((m) => m.id === params[0] && m.state === 'open');
    }
    for (const m of found) {
      m.state = newState;
      m.live = false;
      const via = s.match(/archived_via = '([\w-]+)'/)?.[1];
      if (via) m.archived_via = via;
    }
    const ended = new Set(found.map((m) => m.id));
    for (const o of w.offers) {
      if (ended.has(o.match_id) && ['proposed', 'awaiting-human'].includes(o.state)) {
        o.state = 'withdrawn';
        o.closed_with_introduction = true;
      }
    }
    return out(found.map((m) => ({ id: m.id })));
  }
  if (s.startsWith('SELECT * FROM pairings WHERE id = $1')) return out([pairingById(params[0])].filter(Boolean));
  if (s.startsWith('SELECT * FROM matches WHERE id = $1')) return out(w.matches.filter((m) => m.id === params[0]));
  if (s.startsWith('SELECT m.id, m.account_want, m.account_have, m.certainty')) {
    const rows = w.matches
      .filter((m) => m.pairing_id === params[0] && m.state === 'open' && !m.item_set_aside_at)
      .filter((m) => w.cards.get(m.card_want)!.lifecycle_state === 'PUBLISHED' && w.cards.get(m.card_have)!.lifecycle_state === 'PUBLISHED')
      .map((m) => {
        const wc = w.cards.get(m.card_want)!;
        const hc = w.cards.get(m.card_have)!;
        return {
          ...m,
          w_kind: wc.kind,
          w_attributes: wc.attributes,
          w_screened: wc.screened_content,
          h_kind: hc.kind,
          h_attributes: hc.attributes,
          h_screened: hc.screened_content,
          h_gone: hc.quantity_gone,
          want_deal: w.lists.get(wc.list_id!)!.deal,
          have_deal: w.lists.get(hc.list_id!)!.deal,
          has_offers: w.offers.some((o) => o.match_id === m.id && ['proposed', 'awaiting-human', 'accepted-by-human'].includes(o.state)),
        };
      })
      .sort((a, b) => Number(b.has_offers) - Number(a.has_offers));
    return out(rows);
  }
  if (s.startsWith('SELECT id, proposer_account, amount, ccy, state, message, authored_by, created_at FROM offers')) {
    return out(
      w.offers.filter((o) => o.match_id === params[0] && ['proposed', 'awaiting-human', 'accepted-by-human'].includes(o.state)),
    );
  }
  if (s.startsWith('SELECT 1 FROM pairings WHERE id = $1 AND anchor_match_id = $2')) {
    return out(w.pairings.filter((p) => p.id === params[0] && p.anchor_match_id === params[1] && p.state === 'open').map(() => ({ 1: 1 })));
  }
  if (s.startsWith('UPDATE matches SET item_set_aside_at')) {
    const m = w.matches.find((x) => x.id === params[0] && x.state === 'open');
    if (m) m.item_set_aside_at ??= new Date();
    return out([]);
  }
  if (s.startsWith('SELECT p.id FROM pairings p WHERE p.id = ANY')) {
    const rows = w.pairings.filter(
      (p) =>
        params[0].includes(p.id) &&
        p.state === 'open' &&
        p.lo_gets_sure + p.lo_gets_maybe + p.hi_gets_sure + p.hi_gets_maybe === 0 &&
        !w.matches.some((m) => m.pairing_id === p.id && m.state === 'open' && m.channel_id && m.stage >= 4),
    );
    return out(rows.map((p) => ({ id: p.id })));
  }
  if (s.startsWith('SELECT account_lo, account_hi FROM pairings')) {
    return out(w.pairings.filter((p) => params[0].includes(p.id)));
  }
  if (s.startsWith('SELECT DISTINCT pairing_id FROM matches WHERE (card_want = $1 OR card_have = $1)')) {
    return out(
      [...new Set(w.matches.filter((m) => (m.card_want === params[0] || m.card_have === params[0]) && m.pairing_id).map((m) => m.pairing_id))].map(
        (p) => ({ pairing_id: p }),
      ),
    );
  }
  // quantities.ts
  if (s.startsWith('UPDATE cards SET quantity_gone = quantity_gone + 1')) {
    const c = w.cards.get(params[0]);
    const q = typeof c?.attributes.quantity === 'number' ? (c.attributes.quantity as number) : 1;
    if (!c || !c.list_id || c.quantity_gone >= q) return out([]);
    c.quantity_gone += 1;
    return out([{ attributes: c.attributes, quantity_gone: c.quantity_gone }]);
  }
  if (s.startsWith('SELECT list_id, attributes, quantity_gone FROM cards')) {
    const c = w.cards.get(params[0]);
    return out(c ? [{ list_id: c.list_id, attributes: c.attributes, quantity_gone: c.quantity_gone }] : []);
  }
  if (s.startsWith("UPDATE cards SET lifecycle_state = 'WITHDRAWN', withdrawn_because")) {
    const c = w.cards.get(params[0]);
    if (!c || !['PENDING_SCREENING', 'PUBLISHED'].includes(c.lifecycle_state)) return out([]);
    c.lifecycle_state = 'WITHDRAWN';
    c.withdrawn_because = 'none_left';
    return out([{ id: c.id }]);
  }
  if (s.startsWith('UPDATE offers o SET state = \'withdrawn\'')) {
    for (const o of w.offers) {
      const m = w.matches.find((x) => x.id === o.match_id)!;
      if ((m.card_want === params[0] || m.card_have === params[0]) && m.id !== params[1] && ['proposed', 'awaiting-human'].includes(o.state)) {
        o.state = 'withdrawn';
      }
    }
    return out([]);
  }
  // Everything else (the per-posting line, channel leftovers, reputation):
  // nothing here, as on an empty board.
  return out([]);
}

function fakePool() {
  const client = { query: run, release: () => {} };
  return { query: run, connect: async () => client } as any;
}

beforeEach(() => {
  seq = 0;
  w = { cards: new Map(), lists: new Map(), matches: [], offers: [], pairings: [], sql: [] };
  vi.restoreAllMocks();
  vi.spyOn(db, 'getPool').mockReturnValue(fakePool());
});

/** Ana's sale_or_trade haves, Ana's trade wants, Beppe's two lists the other way round. */
function twoListsEach(opts: { anaHave?: string; anaWant?: string; beppeHave?: string; beppeWant?: string } = {}) {
  const L = {
    anaHave: list('l-ana-have', opts.anaHave ?? 'sale_or_trade'),
    anaWant: list('l-ana-want', opts.anaWant ?? 'trade'),
    beppeHave: list('l-beppe-have', opts.beppeHave ?? 'trade'),
    beppeWant: list('l-beppe-want', opts.beppeWant ?? 'sale_or_trade'),
  };
  const levers = card({
    id: id('c', 1),
    account_id: ANA,
    type: 'HAVE',
    list_id: L.anaHave,
    kind: 'brake lever set',
    attributes: { condition: 'good', quantity: 2 },
  });
  levers.screened_content = {
    version: 1,
    at: 'x',
    kind: 'brake lever set',
    attributes: { condition: 'good', quantity: 2 },
    ask: { amount: 10, ccy: 'AUD' },
    identifiers: [{ kind: 'model number', value: 'BL-77', norm: 'bl77' }],
  };
  const beppeWantsLevers = card({ id: id('c', 2), account_id: BEPPE, type: 'WANT', list_id: L.beppeWant, kind: 'brake levers' });
  beppeWantsLevers.screened_content = {
    version: 1,
    at: 'x',
    kind: 'brake levers',
    attributes: {},
    ask: null,
    identifiers: [{ kind: 'model number', value: 'BL 77', norm: 'bl77' }],
  };
  const tool = card({ id: id('c', 3), account_id: BEPPE, type: 'HAVE', list_id: L.beppeHave, kind: 'chain tool' });
  const anaWantsTool = card({ id: id('c', 4), account_id: ANA, type: 'WANT', list_id: L.anaWant, kind: 'chain breaker' });
  return { L, levers, beppeWantsLevers, tool, anaWantsTool };
}

/** The matcher's road for a grouped pair, without the matcher around it. */
async function introduce(want: Card, have: Card, over: Partial<Match> = {}): Promise<Match> {
  const m = match({ card_want: want.id, card_have: have.id, ...over });
  await joinPairing(db.getPool() as any, m.id, want.account_id, have.account_id);
  return m;
}

// ---------------------------------------------------------------------------
describe('what is grouped, and what two lists allow', () => {
  it('groups two list items on goods, and nothing else', () => {
    const want = { list_id: 'l1', category: 'goods.bicycle.parts', account_id: ANA };
    const have = { list_id: 'l2', category: 'goods.bicycle.parts', account_id: BEPPE };
    expect(groupsAsPairing(want, have, false)).toBe(true);
    // An ordinary posting on either side is introduced exactly as before.
    expect(groupsAsPairing({ ...want, list_id: null }, have, false)).toBe(false);
    expect(groupsAsPairing(want, { ...have, list_id: null }, false)).toBe(false);
    expect(groupsAsPairing({ ...want, list_id: null }, { ...have, list_id: null }, false)).toBe(false);
    // Only goods; never a swap; never one person with themselves.
    expect(groupsAsPairing({ ...want, category: 'services.repairs' }, { ...have, category: 'services.repairs' }, false)).toBe(false);
    expect(groupsAsPairing(want, { ...have, category: 'social.chess' }, false)).toBe(false);
    expect(groupsAsPairing(want, have, true)).toBe(false);
    expect(groupsAsPairing(want, { ...have, account_id: ANA }, false)).toBe(false);
  });

  it('works out every pair of deals, the giver\'s list first', () => {
    const deals = ['sale', 'trade', 'sale_or_trade', 'free'] as const;
    const expected: Record<string, [boolean, boolean, boolean]> = {
      'sale>sale': [true, false, false],
      'sale>trade': [false, false, false],
      'sale>sale_or_trade': [true, false, false],
      'sale>free': [false, false, false],
      'trade>sale': [false, false, false],
      'trade>trade': [false, true, false],
      'trade>sale_or_trade': [false, true, false],
      'trade>free': [false, false, false],
      'sale_or_trade>sale': [true, false, false],
      'sale_or_trade>trade': [false, true, false],
      'sale_or_trade>sale_or_trade': [true, true, false],
      'sale_or_trade>free': [false, false, false],
      'free>sale': [false, false, true],
      'free>trade': [false, false, true],
      'free>sale_or_trade': [false, false, true],
      'free>free': [false, false, true],
    };
    for (const have of deals) {
      for (const want of deals) {
        const d = dealsAllow(have, want);
        expect([d.sale, d.trade, d.free], `${have}>${want}`).toEqual(expected[`${have}>${want}`]);
      }
    }
  });

  it('keeps the two accounts in one order, whichever side asks', () => {
    expect(pairKey(ANA, BEPPE)).toEqual(pairKey(BEPPE, ANA));
    expect(pairKey(BEPPE, ANA).lo < pairKey(BEPPE, ANA).hi).toBe(true);
  });

  it('reads a list for sale or trade: money as a sale, and the trade said on the item', () => {
    const ok = readListItem({ name: 'brake lever set', price: 10, quantity: 2 }, 0, { type: 'HAVE', deal: 'sale_or_trade' });
    expect(ok.ok && ok.item.attributes).toEqual({ quantity: 2, trade: true });
    expect(ok.ok && ok.item.price).toBe(10);
    const offers = readListItem({ name: 'brake lever set', open_to_offers: true }, 0, { type: 'HAVE', deal: 'sale_or_trade' });
    expect(offers.ok).toBe(true);
    const bare = readListItem({ name: 'brake lever set' }, 0, { type: 'HAVE', deal: 'sale_or_trade' });
    expect(!bare.ok && bare.refusal.reason).toBe('price');
    const limit = readListItem({ name: 'brake levers', price_limit: 12 }, 0, { type: 'WANT', deal: 'sale_or_trade' });
    expect(limit.ok).toBe(true);
    // A trade list still carries no money, and a sale list is as it was.
    const trade = readListItem({ name: 'brake levers', price: 10 }, 0, { type: 'HAVE', deal: 'trade' });
    expect(!trade.ok && trade.refusal.reason).toBe('price');
    const sale = readListItem({ name: 'brake levers', price: 10 }, 0, { type: 'HAVE', deal: 'sale' });
    expect(sale.ok && sale.item.attributes).toEqual({});
  });

  it('lets a grade never decide a match, as condition never has', async () => {
    const { wordAgreement } = await import('../../src/domain/matchTiers.js');
    const a = wordAgreement(
      { kind: 'brake lever set', attributes: { grade: '9', graded: true, grader: 'someone' } },
      { kind: 'brake lever set', attributes: { grade: '6' } },
    );
    const b = wordAgreement({ kind: 'brake lever set', attributes: {} }, { kind: 'brake lever set', attributes: {} });
    expect(a.score).toBe(b.score);
  });
});

// ---------------------------------------------------------------------------
describe('joining a pairing', () => {
  it('lands two runs racing from both sides on one pairing', async () => {
    const { levers, beppeWantsLevers, tool, anaWantsTool } = twoListsEach();
    const m1 = match({ card_want: beppeWantsLevers.id, card_have: levers.id });
    const m2 = match({ card_want: anaWantsTool.id, card_have: tool.id });
    const pool = db.getPool() as any;
    const [a, b] = await Promise.all([
      joinPairing(await pool.connect(), m1.id, BEPPE, ANA),
      joinPairing(await pool.connect(), m2.id, ANA, BEPPE),
    ]);
    expect(a.pairingId).toBe(b.pairingId);
    expect(w.pairings).toHaveLength(1);
    expect(w.matches.map((m) => m.pairing_id)).toEqual([a.pairingId, a.pairingId]);
    // The first member is the anchor, and stays it.
    expect(w.pairings[0].anchor_match_id).toBe(m1.id);
  });

  it('makes a grouped introduction and its pairing in one transaction, with the matcher\'s own statement', async () => {
    const { levers, beppeWantsLevers } = twoListsEach();
    const insert = `INSERT INTO matches (card_want, card_have) VALUES ($1, $2) ON CONFLICT (card_want, card_have) DO NOTHING RETURNING id`;
    const first = await pairings.insertGroupedMatch(insert, [beppeWantsLevers.id, levers.id], BEPPE, ANA);
    expect(first.rows).toHaveLength(1);
    expect(first.pairingId).toBe(w.pairings[0].id);
    const order = w.sql.map((q) => q.trim().split(/\s+/).slice(0, 3).join(' '));
    expect(order[0]).toBe('BEGIN');
    expect(order.at(-1)).toBe('COMMIT');
    expect(order.slice(1, 5)).toEqual([
      'INSERT INTO matches',
      'INSERT INTO pairings',
      'UPDATE matches SET',
      'WITH u AS',
    ]);
    // The same pair again inserts nothing and touches no pairing.
    w.sql = [];
    const again = await pairings.insertGroupedMatch(insert, [beppeWantsLevers.id, levers.id], BEPPE, ANA);
    expect(again.rows).toEqual([]);
    expect(again.pairingId).toBeUndefined();
    expect(w.sql.some((q) => /pairings/.test(q))).toBe(false);
  });

  it('relies on the one-open-row index the migration makes, and says so in its statement', () => {
    expect(UPSERT_PAIRING_SQL).toMatch(/ON CONFLICT \(account_lo, account_hi\) WHERE state = 'open'/);
    const migration = readFileSync(new URL('../../migrations/074_pairings.sql', import.meta.url), 'utf8');
    expect(migration).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS pairings_one_open_idx\s+ON pairings \(account_lo, account_hi\) WHERE state = 'open'/);
    expect(migration).toMatch(/CHECK \(account_lo < account_hi\)/);
    expect(migration).toMatch(/CHECK \(deal IN \('sale', 'trade', 'free', 'sale_or_trade'\)\)/);
  });

  it('counts distinct things each way, only where the two lists allow a deal', async () => {
    const { levers, beppeWantsLevers, tool, anaWantsTool } = twoListsEach();
    await introduce(beppeWantsLevers, levers);
    await introduce(anaWantsTool, tool);
    const p = w.pairings[0];
    const ana = pairings.seenBy(p, ANA);
    expect(ana).toMatchObject({ getSure: 1, giveSure: 1, canBuy: false, canSell: true, tradeTo: true, tradeFrom: true });
    expect(pairings.tradePossible(p)).toBe(true);
  });

  it('shows nobody an introduction whose two lists allow no deal: a trade list runs as no sale', async () => {
    const { levers, beppeWantsLevers } = twoListsEach({ anaHave: 'trade', beppeWant: 'sale' });
    await introduce(beppeWantsLevers, levers);
    const p = w.pairings[0];
    expect(pairings.hasAnything(p)).toBe(false);
    p.live = true;
    const anchor = w.matches[0];
    expect(await pairingEntry(cfg, anchor, ANA)).toBeUndefined();
    expect(await pairingEntry(cfg, anchor, BEPPE)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
describe('ranking and sequencing', () => {
  const facts = (over: Partial<pairings.PairingFacts>): pairings.PairingFacts => ({
    pairingId: 'x',
    tradeBoth: false,
    smaller: 0,
    total: 0,
    sureShare: 1,
    distanceKm: null,
    reliability: 0.5,
    arrivedAt: 0,
    ...over,
  });

  it('ranks a trade both ways first, then the smaller side, the total, the sure share, distance, reliability and arrival', () => {
    const rows = [
      facts({ pairingId: 'late', arrivedAt: 9 }),
      facts({ pairingId: 'early', arrivedAt: 1 }),
      facts({ pairingId: 'reliable', reliability: 0.9, arrivedAt: 9 }),
      facts({ pairingId: 'near', distanceKm: 3, arrivedAt: 9 }),
      facts({ pairingId: 'sure', sureShare: 1.0, total: 1, arrivedAt: 9 }),
      facts({ pairingId: 'unsure', sureShare: 0.5, total: 1, arrivedAt: 9 }),
      facts({ pairingId: 'many', total: 6, smaller: 0 }),
      facts({ pairingId: 'balanced', total: 4, smaller: 2 }),
      facts({ pairingId: 'trade', tradeBoth: true, total: 2, smaller: 1 }),
    ];
    expect(rankPairings(rows).map((r) => r.pairingId)).toEqual([
      'trade',
      'balanced',
      'many',
      'sure',
      'unsure',
      'near',
      'reliable',
      'early',
      'late',
    ]);
  });

  it('never ranks by a maybe: maybes count in none of the first three', () => {
    const base = {
      id: 'p',
      account_lo: ANA,
      account_hi: BEPPE,
      state: 'open',
      live: false,
      anchor_match_id: null,
      sale_to_lo: true,
      sale_to_hi: true,
      trade_to_lo: true,
      trade_to_hi: true,
      free_to_lo: false,
      free_to_hi: false,
      created_at: new Date(0),
    } as const;
    const maybes = factsOfPairing(
      { ...base, lo_gets_sure: 0, lo_gets_maybe: 9, hi_gets_sure: 0, hi_gets_maybe: 9 } as any,
      { distanceKm: null, reliability: 0.5 },
    );
    expect(maybes).toMatchObject({ tradeBoth: false, smaller: 0, total: 0, sureShare: 0 });
  });

  it('lets each person have P live at once, and a pairing go live only where both have room', async () => {
    const others = Array.from({ length: 7 }, (_, i) => `cccccccc-0000-4000-8000-00000000000${i}`);
    for (const [i, other] of others.entries()) {
      const lh = list(`lh${i}`, 'sale');
      const lw = list(`lw${i}`, 'sale');
      const have = card({ id: id('h', i), account_id: other, type: 'HAVE', list_id: lh });
      const want = card({ id: id('w', i), account_id: ANA, type: 'WANT', list_id: lw });
      await introduce(want, have);
    }
    // The last person is already full with five people of their own.
    const busy = others[6];
    for (let k = 0; k < 5; k++) {
      w.pairings.push({ id: id('z', k), account_lo: busy, account_hi: `dddddddd-0000-4000-8000-00000000000${k}`, state: 'open', live: true });
    }
    const promoted = await resequencePairings([ANA], { ...cfg, pairingsLivePerPerson: 5 } as Config);
    const mine = w.pairings.filter((p) => p.account_lo === ANA || p.account_hi === ANA);
    expect(mine.filter((p) => p.live)).toHaveLength(5);
    expect(promoted).toHaveLength(5);
    expect(mine.find((p) => p.account_lo === busy || p.account_hi === busy)!.live).toBe(false);
    // Every member of a live pairing is live with it, and no other is.
    for (const m of w.matches) expect(m.live).toBe(pairingById(m.pairing_id!).live);
    // Running it again moves nothing: live ones are counted, never re-ordered.
    expect(await resequencePairings([ANA], cfg)).toEqual([]);
  });

  it('reads the default room as five', () => {
    expect(pairings.livePerPerson(undefined)).toBe(5);
    expect(pairings.livePerPerson({ pairingsLivePerPerson: 3 })).toBe(3);
  });
});

// ---------------------------------------------------------------------------
describe('the check_in entry: one per person', () => {
  async function livePairing() {
    const g = twoListsEach();
    const anchor = await introduce(g.beppeWantsLevers, g.levers);
    const toolIntro = await introduce(g.anaWantsTool, g.tool);
    const spare = card({ id: id('c', 9), account_id: BEPPE, type: 'HAVE', list_id: g.L.beppeHave, kind: 'spoke key' });
    const anaWantsKey = card({ id: id('c', 10), account_id: ANA, type: 'WANT', list_id: g.L.anaWant, kind: 'spoke wrench' });
    const maybe = await introduce(anaWantsKey, spare, { certainty: 'possible' });
    await resequencePairings([ANA, BEPPE], cfg);
    return { ...g, anchor, toolIntro, maybe };
  }

  it('carries one entry, their words labelled, the maybes apart, and the next step', async () => {
    const { anchor, toolIntro, maybe } = await livePairing();
    const e = await pairingEntry(cfg, w.matches.find((m) => m.id === anchor.id), BEPPE);
    expect(e).toMatchObject({
      kind: 'pairing',
      intro_id: anchor.id,
      pairing_id: w.pairings[0].id,
      state: 'open',
      next: 'details_unlocked',
      can_buy: true,
      can_sell: false,
      trade_possible: true,
      they_have: { sure: 1, maybe: 0 },
      they_want: { sure: 1, maybe: 1 },
    });
    // Theirs, in their own screened words, labelled; quantity and asking price.
    expect(e.they_have.items).toEqual([
      expect.objectContaining({
        intro_id: anchor.id,
        their_words: { text: 'brake lever set', provenance: 'counterparty-untrusted' },
        details: { condition: 'good' },
        quantity: 2,
        for_your_want: 'brake levers',
        deal: ['sale', 'trade'],
        asking_price: { amount: 10, ccy: 'AUD' },
        identifier_note: { text: expect.stringMatching(/same identifier/), provenance: 'switchboard-system' },
      }),
    ]);
    expect(e.they_want.items).toEqual([
      expect.objectContaining({ intro_id: toolIntro.id, your_item: 'chain tool', deal: ['trade'] }),
    ]);
    // The maybe comes apart, with its own sentence.
    expect(e.maybes.they_want).toEqual([expect.objectContaining({ intro_id: maybe.id })]);
    expect(e.maybes.note.text).toMatch(/may or may not be/);
    // No identifier crosses, ever.
    expect(JSON.stringify(e)).not.toMatch(/BL-?\s?77|bl77/i);
    // The sentence: how much each way, what can happen, the next step.
    expect(e.note.text).toMatch(/^Someone whose list meets yours has 1 thing you are after, and is after 1 thing of yours\./);
    expect(e.note.text).toMatch(/You can buy from them or trade with them\./);
    expect(e.what_to_do).toMatch(/intro_id/);
    for (const t of [e.note.text, e.maybes.note.text, e.their_words_note.text]) expect(lintHumanCopy(t)).toEqual([]);
  });

  it('leads with a figure from them, beside the thing it is on', async () => {
    const { anchor } = await livePairing();
    w.offers.push({
      id: id('o', 1),
      match_id: anchor.id,
      proposer_account: BEPPE,
      amount: '9',
      ccy: 'AUD',
      state: 'proposed',
      message: null,
      authored_by: 'human',
      created_at: new Date(),
    });
    const e = await pairingEntry(cfg, w.matches.find((m) => m.id === anchor.id), ANA);
    expect(e.note.text).toMatch(/^They have put a figure on one of these/);
    expect(e.next).toBe('awaiting_your_human');
    const item = e.they_want.items.find((i: any) => i.intro_id === anchor.id);
    expect(item.offers).toEqual([expect.objectContaining({ side: 'theirs', amount: 9 })]);
  });

  it('tells the person waiting one sentence, and the person whose room is full nothing', async () => {
    const g = twoListsEach();
    const anchor = await introduce(g.beppeWantsLevers, g.levers);
    // Ana is full with five others; Beppe is not.
    for (let k = 0; k < 5; k++) {
      w.pairings.push({ id: id('z', k), account_lo: ANA, account_hi: `dddddddd-0000-4000-8000-00000000000${k}`, state: 'open', live: true });
    }
    expect(await pairingEntry(cfg, anchor, ANA)).toBeUndefined();
    const waiting = await pairingEntry(cfg, anchor, BEPPE);
    expect(waiting).toMatchObject({ kind: 'pairing', state: 'in_line', intro_id: anchor.id });
    expect(Object.keys(waiting).sort()).toEqual(['intro_id', 'kind', 'note', 'pairing_id', 'state']);
  });

  it('reads only the anchor of a pairing on the sweep, and every ordinary introduction as before', async () => {
    const src = readFileSync(new URL('../../src/domain/matches.ts', import.meta.url), 'utf8');
    expect(src).toMatch(
      /AND \(m\.pairing_id IS NULL\s+OR EXISTS \(SELECT 1 FROM pairings p WHERE p\.id = m\.pairing_id AND p\.anchor_match_id = m\.id\)\)/,
    );
  });

  it('says what can happen in plain words, and never a figure', () => {
    expect(countsSentence({ getSure: 4, getMaybe: 0, giveSure: 2, giveMaybe: 0 })).toBe(
      'Someone whose list meets yours has 4 things you are after, and is after 2 things of yours.',
    );
    expect(countsSentence({ getSure: 0, getMaybe: 2, giveSure: 0, giveMaybe: 0 })).toBe(
      'Someone whose list meets yours may have 2 things you are after.',
    );
    expect(
      dealSentence({ canBuy: true, canSell: true, trade: true, takeFree: false, giveFree: false, getAny: true, giveAny: true }),
    ).toBe('You can buy from them, sell to them or trade with them.');
    expect(
      dealSentence({ canBuy: false, canSell: false, trade: false, takeFree: true, giveFree: false, getAny: true, giveAny: false }),
    ).toBe('You can take what they are giving away.');
  });
});

// ---------------------------------------------------------------------------
describe('ending a pairing', () => {
  async function three() {
    const g = twoListsEach();
    const anchor = await introduce(g.beppeWantsLevers, g.levers);
    const tool = await introduce(g.anaWantsTool, g.tool);
    const key = card({ id: id('c', 9), account_id: BEPPE, type: 'HAVE', list_id: g.L.beppeHave, kind: 'spoke key' });
    const wantKey = card({ id: id('c', 10), account_id: ANA, type: 'WANT', list_id: g.L.anaWant, kind: 'spoke key' });
    const third = await introduce(wantKey, key);
    await resequencePairings([ANA, BEPPE], cfg);
    for (const m of [anchor, tool]) {
      w.offers.push({
        id: id('o', ++seq),
        match_id: m.id,
        proposer_account: BEPPE,
        amount: '9',
        ccy: 'AUD',
        state: 'proposed',
        message: null,
        authored_by: 'human',
        created_at: new Date(),
      });
    }
    return { anchor, tool, third };
  }

  it('ends every member in one statement, and closes their open figures with them', async () => {
    const { anchor } = await three();
    const before = w.sql.length;
    const out = await endPairing(w.pairings[0].id, { state: 'declined' }, cfg);
    expect(out.ended).toBe(true);
    expect(out.members).toHaveLength(3);
    expect(w.matches.map((m) => m.state)).toEqual(['declined', 'declined', 'declined']);
    expect(w.offers.map((o) => [o.state, o.closed_with_introduction])).toEqual([
      ['withdrawn', true],
      ['withdrawn', true],
    ]);
    const endings = w.sql.slice(before).filter((s) => /UPDATE matches/.test(s) && /state = 'declined'/.test(s));
    expect(endings).toHaveLength(1);
    expect(endings[0]).toMatch(/^WITH ended AS/);
    expect(w.pairings[0].state).toBe('declined');
    // Again changes nothing.
    expect((await endPairing(w.pairings[0].id, { state: 'declined' }, cfg)).ended).toBe(false);
    void anchor;
  });

  it('declining, archiving or severing any member is about the person', async () => {
    const { tool } = await three();
    await matches.declineMatch(tool.id, ANA, cfg);
    expect(w.matches.every((m) => m.state === 'declined')).toBe(true);

    w = { cards: new Map(), lists: new Map(), matches: [], offers: [], pairings: [], sql: [] };
    seq = 0;
    const s = await three();
    const sev = await matches.severMatch(s.third.id, undefined, cfg);
    expect(sev.severed).toBe(true);
    expect(w.matches.every((m) => m.state === 'closed')).toBe(true);
    expect(w.pairings[0].state).toBe('closed_by_switchboard');

    w = { cards: new Map(), lists: new Map(), matches: [], offers: [], pairings: [], sql: [] };
    seq = 0;
    const a = await three();
    const arch = await matches.archiveMatch(a.anchor.id, BEPPE, 'counter', cfg);
    expect(arch.state).toBe('archived');
    expect(w.matches.every((m) => m.state === 'archived')).toBe(true);
    expect(w.pairings[0].state).toBe('archived');
  });

  it('takes one item down with its introductions, keeps the anchor as the handle, and files the pairing away once nothing is left', async () => {
    const { anchor, tool, third } = await three();
    // Beppe takes the chain tool down: its introduction is filed away alone.
    const toolCard = w.cards.get(tool.card_have)!;
    toolCard.lifecycle_state = 'WITHDRAWN';
    await matches.archiveOpenIntroductionsOnCard(toolCard.id, BEPPE, 'withdrawn', cfg);
    expect(w.matches.find((m) => m.id === tool.id)!.state).toBe('archived');
    expect(w.pairings[0].state).toBe('open');
    // Ana takes the levers down: the anchor's own item stops counting, and the
    // anchor stays open while the spoke key is still between them.
    const levers = w.cards.get(anchor.card_have)!;
    levers.lifecycle_state = 'WITHDRAWN';
    await matches.archiveOpenIntroductionsOnCard(levers.id, ANA, 'withdrawn', cfg);
    expect(w.matches.find((m) => m.id === anchor.id)!.state).toBe('open');
    expect(w.pairings[0].state).toBe('open');
    // The last thing going files the whole of it away.
    const key = w.cards.get(third.card_have)!;
    key.lifecycle_state = 'WITHDRAWN';
    await matches.archiveOpenIntroductionsOnCard(key.id, BEPPE, 'withdrawn', cfg);
    expect(w.pairings[0].state).toBe('archived');
    expect(w.matches.every((m) => m.state !== 'open')).toBe(true);
  });

  it('builds each member ending through endingClosesOffers', () => {
    for (const end of [
      { state: 'declined' as const },
      { state: 'archived' as const, via: 'lapsed' },
      { state: 'closed_by_switchboard' as const },
    ]) {
      const sql = memberEndingSql(end);
      expect(sql).toMatch(/WHERE pairing_id = \$1 AND state = 'open'/);
      expect(sql).toMatch(/UPDATE offers\s+SET state = 'withdrawn', closed_with_introduction = true/);
    }
  });

  it('ends one item alone when it is not the thing, and sets the anchor\'s own item aside', async () => {
    const { anchor, tool, third } = await three();
    await itemNotTheThing({ id: tool.id, pairing_id: tool.pairing_id }, cfg);
    expect(w.matches.find((m) => m.id === tool.id)!.state).toBe('declined');
    expect(w.matches.find((m) => m.id === third.id)!.state).toBe('open');
    expect(w.pairings[0].state).toBe('open');
    await itemNotTheThing({ id: anchor.id, pairing_id: anchor.pairing_id }, cfg);
    const a = w.matches.find((m) => m.id === anchor.id)!;
    expect(a.state).toBe('open');
    expect(a.item_set_aside_at).toBeInstanceOf(Date);
    // The last thing going ends the whole of it.
    await itemNotTheThing({ id: third.id, pairing_id: third.pairing_id }, cfg);
    expect(w.pairings[0].state).toBe('declined');
    expect(w.matches.every((m) => m.state !== 'open')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('quantities that come down', () => {
  it('takes one unit for each accepted sale, and refuses once none are left', async () => {
    const L = list('l', 'sale');
    card({ id: id('c', 1), account_id: ANA, type: 'HAVE', list_id: L, attributes: { quantity: 2 } });
    const client = { query: run };
    expect(await quantities.takeOneForSale(client, id('c', 1))).toBe(1);
    expect(await quantities.takeOneForSale(client, id('c', 1))).toBe(0);
    await expect(quantities.takeOneForSale(client, id('c', 1))).rejects.toThrow(OsbError);
    await expect(quantities.takeOneForSale(client, id('c', 1))).rejects.toMatchObject({
      payload: { human_action: quantities.NONE_LEFT_WORDS },
    });
  });

  it('leaves an ordinary posting alone', async () => {
    card({ id: id('c', 2), account_id: ANA, type: 'HAVE', list_id: null, attributes: { quantity: 1 } });
    expect(await quantities.takeOneForSale({ query: run }, id('c', 2))).toBeUndefined();
    expect(w.cards.get(id('c', 2))!.quantity_gone).toBe(0);
    expect(quantities.acceptQuantityLine(undefined)).toBeUndefined();
  });

  it('says so on the page before the press', () => {
    expect(quantities.acceptQuantityLine(2)).toBe('This takes one off your list: 1 left after this.');
    expect(quantities.acceptQuantityLine(1)).toBe('This is the last one on your list, so it comes off your list once you accept.');
    expect(quantities.sendQuantityLine(3)).toBe('If they accept, one comes off your list: 2 left after that.');
    for (const t of [quantities.acceptQuantityLine(2)!, quantities.acceptQuantityLine(1)!, quantities.NONE_LEFT_WORDS]) {
      expect(lintHumanCopy(t)).toEqual([]);
    }
  });

  it('takes the item down at none left, files away what can no longer be met, and keeps the deal', async () => {
    const L = list('lh', 'sale');
    const W = list('lw', 'sale');
    const have = card({ id: id('c', 1), account_id: ANA, type: 'HAVE', list_id: L, attributes: { quantity: 1 } });
    const buyers = ['cccccccc-0000-4000-8000-000000000001', 'cccccccc-0000-4000-8000-000000000002', 'cccccccc-0000-4000-8000-000000000003'];
    const wants = buyers.map((b, i) => card({ id: id('w', i), account_id: b, type: 'WANT', list_id: i < 2 ? W : null }));
    const sold = match({ card_want: wants[0].id, card_have: have.id, live: true });
    const other = match({ card_want: wants[1].id, card_have: have.id, live: true });
    const talking = match({ card_want: wants[2].id, card_have: have.id, live: true, channel_id: 'ch', stage: 4 });
    const offer = (m: Match, state: string) =>
      w.offers.push({ id: id('o', ++seq), match_id: m.id, proposer_account: m.account_want, amount: '5', ccy: 'AUD', state, message: null, authored_by: 'human', created_at: new Date() });
    offer(sold, 'accepted-by-human');
    offer(other, 'proposed');
    offer(talking, 'proposed');
    have.quantity_gone = 1;
    await quantities.takeDownNoneLeft(have.id, sold.id, cfg);
    expect(have.lifecycle_state).toBe('WITHDRAWN');
    expect(have.withdrawn_because).toBe('none_left');
    expect(sold.state).toBe('open');
    expect([other.state, other.archived_via]).toEqual(['archived', 'none_left']);
    expect(talking.state).toBe('open');
    expect(w.offers.map((o) => o.state)).toEqual(['accepted-by-human', 'withdrawn', 'withdrawn']);
    expect(lintHumanCopy(matches.NONE_LEFT_SENTENCE)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe('an ordinary posting is untouched', () => {
  const row = (over: Partial<OwnLineRow>): OwnLineRow => ({
    cid: 'mine',
    live: false,
    other: 'someone',
    slots: 1,
    gather_open: false,
    ...over,
  });

  it('counts its line exactly as before, and a pairing member never fills it or waits in it', () => {
    const ordinary = [row({ live: true, other: 'a' }), row({ other: 'b' })];
    expect(lineCounts(ordinary).get('mine')).toEqual({ here: 1, waiting: 1 });
    // A live member counts as somebody with the posting; it takes no slot and
    // nobody waits behind it, and a member waiting on its pairing is nobody's line.
    const withMembers = [row({ live: true, other: 'g', grouped: true }), row({ other: 'b' }), row({ other: 'h', grouped: true })];
    expect(lineCounts(withMembers).get('mine')).toEqual({ here: 1, waiting: 0 });
  });

  it('sequences only ordinary introductions on a posting\'s own line', () => {
    const src = readFileSync(new URL('../../src/domain/sequencer.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/AND m\.pairing_id IS NULL`,\s+\[cardId\]/);
    expect(src).toMatch(/AND m\.state = 'open' AND m\.live AND m\.pairing_id IS NULL\) AS live_now/);
    expect(src).toMatch(/AND certainty = 'sure' AND pairing_id IS NULL/);
  });

  it('files away an ordinary posting\'s introductions as before, and touches no pairing', async () => {
    const have = card({ id: id('c', 1), account_id: ANA, type: 'HAVE' });
    const want = card({ id: id('c', 2), account_id: BEPPE, type: 'WANT' });
    const m = match({ card_want: want.id, card_have: have.id, live: true });
    const n = await matches.archiveOpenIntroductionsOnCard(have.id, ANA, 'withdrawn', cfg);
    expect(n).toBe(1);
    expect(m.state).toBe('archived');
    expect(w.pairings).toEqual([]);
    expect(w.sql.some((s) => /INSERT INTO pairings|UPDATE pairings/.test(s))).toBe(false);
  });

  it('declines an ordinary introduction alone', async () => {
    const have = card({ id: id('c', 1), account_id: ANA, type: 'HAVE' });
    const want = card({ id: id('c', 2), account_id: BEPPE, type: 'WANT' });
    const m = match({ card_want: want.id, card_have: have.id, live: true });
    const other = match({ card_want: card({ id: id('c', 3), account_id: BEPPE, type: 'WANT' }).id, card_have: have.id, live: true });
    await matches.declineMatch(m.id, ANA, cfg);
    expect([m.state, other.state]).toEqual(['declined', 'open']);
    expect(w.sql.some((s) => /pairings/.test(s) && !/pairing_id IS NULL/.test(s))).toBe(false);
  });
});
