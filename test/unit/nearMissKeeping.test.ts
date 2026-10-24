/**
 * WHICH NEAR MISSES ARE WORTH KEEPING (October 2026, domain/nearMisses.ts).
 *
 * Found in a rehearsal of lists: one want whose identifier matched exactly
 * one item on a 29-item list got a sure introduction on that item AND twenty
 * near misses against nearly every other item on the same list, each with an
 * identifier that differed from the want's. Three rules now hold, where a near
 * miss is written (matcher.ts) and where one is read (nearMissesForCards):
 *
 *   1. a posting introduced to somebody records no near miss against that
 *      person's other postings;
 *   2. at most one near miss between a posting and any one other person's
 *      postings, the best, in both directions;
 *   3. two postings carrying different identifiers of the same kind are no
 *      near miss.
 *
 * And an ordinary pair, one posting each side, no identifiers, no list and no
 * introduction, is written and read exactly as before.
 *
 * The examples are made-up products of no particular sort on purpose.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/crypto.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  decryptFields: vi.fn(async () => ({})),
  writeDecryptAudit: vi.fn(async () => 'decrypt-audit/x'),
}));
// The tier is the engine's business and is held fixed here: a candidate whose
// closeness is 0.9 or more is sure, anything else is a near miss at that
// closeness. What is under test is what happens to the near misses after.
vi.mock('../../src/domain/matchTiers.js', async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return {
    ...actual,
    tierFor: (p: { semantic: number }) => ({
      tier: p.semantic >= 0.9 ? 'sure' : 'near-miss',
      score: p.semantic,
      parts: {
        hardRulesPass: true,
        shelvesCompatible: true,
        weights: {},
        thinness: 'rich',
        why: 'test',
        semantic: p.semantic,
        words: { coverage: 0 },
      },
    }),
  };
});

import * as db from '../../src/db.js';
import { runMatchingForCard } from '../../src/domain/matcher.js';
import {
  introducedBetween,
  keepNearMisses,
  nearMissRuledOut,
  nearMissesForCards,
  nearMissesToWrite,
  type NearMissPair,
} from '../../src/domain/nearMisses.js';
import { differentByIdentifier, readIdentifiers } from '../../src/domain/identifiers.js';
import type { Config } from '../../src/config.js';

const cfg = { quotas: { maxOpenCards: 20 } } as unknown as Config;

const BUYER = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const SELLER = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const OTHER = 'cccccccc-3333-4333-8333-cccccccccccc';
const WANT = 'dddddddd-4444-4444-8444-dddddddddddd';

const ids = (...values: [string, string][]) => {
  const r = readIdentifiers(values.map(([kind, value]) => ({ kind, value })));
  if (!r.ok) throw new Error(r.error);
  return r.identifiers;
};

const item = (n: number) => `eeeeeeee-5555-4555-8555-${String(n).padStart(12, '0')}`;

const card = (over: Record<string, unknown>) => ({
  id: WANT,
  account_id: BUYER,
  type: 'WANT',
  category: 'goods.collectibles',
  kind: 'boxed figure',
  attributes: {},
  geo: { bucket: 'AU-ACT', reach: 'country' },
  geo_lat: -35.28,
  geo_lon: 149.13,
  geo_radius_km: 25,
  geo_country: 'AU',
  urgency: 'none',
  lifecycle_state: 'PUBLISHED',
  expires_at: new Date(Date.now() + 86_400_000),
  price_enc: null,
  data_key_enc: Buffer.from('k'),
  account_is_business: false,
  agent_seen_recently: false,
  threshold_bump: 0,
  embedding_text: '[0.1,0.2]',
  ask: null,
  ...over,
});

const listItem = (n: number, over: Record<string, unknown> = {}) =>
  card({ id: item(n), account_id: SELLER, type: 'HAVE', kind: `boxed figure ${'i'.repeat(n % 4)}`, similarity: 0.6, ...over });

interface Board {
  source: any;
  gated: any[];
  matches: { card_want: string; card_have: string; account_want: string; account_have: string }[];
  storedNear: any[];
  nearInserted: any[][];
}
let board: Board;

function boardPool() {
  return {
    query: async (sql: string, params: any[] = []) => {
      const rows = (r: any[]) => ({ rows: r, rowCount: r.length });
      if (/c\.embedding::text AS embedding_text/.test(sql)) return rows([board.source]);
      if (/\$15::uuid\[\]/.test(sql)) return rows([]);
      if (/identifier_norms/.test(sql)) return rows([]);
      if (/LIMIT 50/.test(sql)) return rows(board.gated);
      if (/SELECT count\(\*\)::int AS n FROM \(/.test(sql)) return rows([{ n: board.gated.length }]);
      if (/INSERT INTO matches/.test(sql)) {
        board.matches.push({ card_want: params[0], card_have: params[1], account_want: params[2], account_have: params[3] });
        return rows([{ id: `m-${board.matches.length}` }]);
      }
      if (/SELECT card_want, card_have, account_want, account_have FROM matches/.test(sql)) {
        const want = new Set(params[0] as string[]);
        return rows(board.matches.filter((m) => want.has(m.card_want) || want.has(m.card_have)));
      }
      if (/FROM near_misses nm JOIN cards cw/.test(sql.replace(/\s+/g, ' '))) return rows(board.storedNear);
      if (/INSERT INTO near_misses/.test(sql)) {
        board.nearInserted.push(params);
        return rows([]);
      }
      return rows([]);
    },
  } as any;
}

const log = vi.fn();

beforeEach(() => {
  board = { source: card({}), gated: [], matches: [], storedNear: [], nearInserted: [] };
  log.mockReset();
  vi.spyOn(db, 'getPool').mockReturnValue(boardPool());
});

// ---------------------------------------------------------------------------
describe('the three rules, pure', () => {
  const pair = (over: Partial<NearMissPair>): NearMissPair => ({
    a: WANT,
    aAccount: BUYER,
    b: item(1),
    bAccount: SELLER,
    score: 0.6,
    ...over,
  });

  it('keeps an ordinary pair exactly as it is', () => {
    const p = pair({});
    expect(nearMissRuledOut(p)).toBe(false);
    expect(keepNearMisses([p])).toEqual([p]);
  });

  it('rule 1: drops a pair where an introduction already runs between the two people', () => {
    expect(keepNearMisses([pair({ introduced: true })])).toEqual([]);
    // On either posting of the pair, and only between these two accounts.
    const intro = { card_want: WANT, card_have: item(9), account_want: BUYER, account_have: SELLER };
    expect(introducedBetween(intro, pair({}))).toBe(true);
    expect(introducedBetween({ ...intro, card_want: 'x', card_have: item(1) }, pair({}))).toBe(true);
    expect(introducedBetween({ ...intro, account_have: OTHER }, pair({}))).toBe(false);
    expect(introducedBetween({ ...intro, card_want: 'x', card_have: 'y' }, pair({}))).toBe(false);
  });

  it('rule 2: keeps one near miss per posting per other person, the best, in both directions', () => {
    const many = Array.from({ length: 20 }, (_, n) => pair({ b: item(n), score: 0.55 + n / 1000 }));
    const kept = keepNearMisses(many);
    expect(kept).toHaveLength(1);
    expect(kept[0].b).toBe(item(19));
    // From the other side: one want near several of one person's postings,
    // seen by that person, is one near miss for them too.
    const fromSeller = Array.from({ length: 5 }, (_, n) =>
      pair({ a: item(n), aAccount: SELLER, b: WANT, bAccount: BUYER, score: 0.6 + n / 100 }),
    );
    expect(keepNearMisses(fromSeller).map((p) => p.a)).toEqual([item(4)]);
    // Different people each keep their own.
    expect(keepNearMisses([pair({}), pair({ b: item(2), bAccount: OTHER })])).toHaveLength(2);
  });

  it('rule 3: two different identifiers of the same kind are two different products', () => {
    const mine = ids(['catalogue number', 'QX-1001']);
    expect(differentByIdentifier(mine, ids(['Catalogue  Number', 'QX-2002']))).toBe(true);
    expect(differentByIdentifier(mine, ids(['catalogue number', 'qx 1001']))).toBe(false);
    // A different kind says nothing either way, and neither does none.
    expect(differentByIdentifier(mine, ids(['model number', 'QX-2002']))).toBe(false);
    expect(differentByIdentifier(mine, [])).toBe(false);
    expect(differentByIdentifier([], mine)).toBe(false);
    expect(keepNearMisses([pair({ aIdentifiers: mine, bIdentifiers: ids(['catalogue number', 'QX-2002']) })])).toEqual([]);
  });

  it('writes only fresh pairs, and none where a stored one is better for the same person', () => {
    const fresh = [pair({ score: 0.6 })];
    const better: NearMissPair = { a: item(7), aAccount: SELLER, b: WANT, bAccount: BUYER, score: 0.65 };
    expect(nearMissesToWrite(fresh, [better])).toEqual([]);
    const worse = { ...better, score: 0.55 };
    expect(nearMissesToWrite(fresh, [worse])).toEqual(fresh);
    // The stored row for the very same pair never blocks it.
    expect(nearMissesToWrite(fresh, [{ ...better, a: item(1), b: WANT, score: 0.9 }])).toEqual(fresh);
  });
});

// ---------------------------------------------------------------------------
describe('where the matcher writes them', () => {
  it('writes an ordinary near miss exactly as before', async () => {
    board.gated = [listItem(1)];
    const out = (await runMatchingForCard(cfg, WANT, log))!;
    expect(out.nearMisses).toBe(1);
    expect(board.nearInserted).toEqual([[WANT, item(1), 0.6, 'goods.collectibles']]);
  });

  it('writes none against a list once one of its items is introduced in the same run (the rehearsal)', async () => {
    const wanted = ids(['catalogue number', 'QX-1001']);
    board.source = card({ identifiers: wanted });
    board.gated = [
      listItem(0, { identifiers: wanted, similarity: 0.95 }),
      ...Array.from({ length: 20 }, (_, n) =>
        listItem(n + 1, { identifiers: ids(['catalogue number', `QX-${2000 + n}`]), similarity: 0.55 + n / 100 }),
      ),
    ];
    const out = (await runMatchingForCard(cfg, WANT, log))!;
    expect(out.matchesCreated).toHaveLength(1);
    expect(out.nearMisses).toBe(0);
    expect(board.nearInserted).toEqual([]);
  });

  it('writes none against a person already introduced in an earlier run', async () => {
    board.matches = [{ card_want: WANT, card_have: item(40), account_want: BUYER, account_have: SELLER }];
    board.gated = [listItem(1), listItem(2)];
    const out = (await runMatchingForCard(cfg, WANT, log))!;
    expect(out.nearMisses).toBe(0);
  });

  it('writes none from a list item whose near miss already has an introduction with that list', async () => {
    // The list item is the posting being matched; the want is the candidate,
    // and it already has an introduction with another item on the same list.
    board.source = listItem(3);
    board.gated = [card({ similarity: 0.6 })];
    board.matches = [{ card_want: WANT, card_have: item(0), account_want: BUYER, account_have: SELLER }];
    const out = (await runMatchingForCard(cfg, item(3), log))!;
    expect(out.nearMisses).toBe(0);
  });

  it('writes one near miss for a whole list, the best, where nobody is introduced', async () => {
    board.gated = Array.from({ length: 20 }, (_, n) => listItem(n, { similarity: 0.55 + n / 100 }));
    const out = (await runMatchingForCard(cfg, WANT, log))!;
    expect(out.nearMisses).toBe(1);
    expect(board.nearInserted[0][1]).toBe(item(19));
  });

  it('keeps one per person, so two people each get theirs', async () => {
    board.gated = [listItem(1), listItem(2, { account_id: OTHER })];
    const out = (await runMatchingForCard(cfg, WANT, log))!;
    expect(out.nearMisses).toBe(2);
  });

  it('writes none between different identifiers of the same kind, and does where the kinds differ', async () => {
    board.source = card({ identifiers: ids(['catalogue number', 'QX-1001']) });
    board.gated = [listItem(1, { identifiers: ids(['catalogue number', 'QX-2002']) })];
    expect((await runMatchingForCard(cfg, WANT, log))!.nearMisses).toBe(0);
    board.gated = [listItem(1, { identifiers: ids(['model number', 'QX-2002']) })];
    expect((await runMatchingForCard(cfg, WANT, log))!.nearMisses).toBe(1);
  });

  it('counts what is already written, so a list matched one item at a time still leaves one', async () => {
    board.source = listItem(5, { similarity: undefined });
    board.gated = [card({ similarity: 0.6 })];
    board.storedNear = [
      { card_want: WANT, card_have: item(4), score: 0.62, created_at: new Date(), account_want: BUYER, account_have: SELLER },
    ];
    expect((await runMatchingForCard(cfg, item(5), log))!.nearMisses).toBe(0);
    board.storedNear[0].score = 0.58;
    expect((await runMatchingForCard(cfg, item(5), log))!.nearMisses).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe('where the sweep reads them, on both sides', () => {
  const row = (over: Record<string, unknown>) => ({
    card_id: item(1),
    other_id: WANT,
    other_type: 'WANT',
    other_category: 'goods.collectibles',
    other_kind: 'boxed figure',
    created_at: new Date('2026-10-20T10:00:00Z'),
    other_account: BUYER,
    score: 0.6,
    introduced: false,
    mine_identifiers: null,
    other_identifiers: null,
    ...over,
  });
  let rows: any[];
  beforeEach(() => {
    vi.spyOn(db, 'getPool').mockReturnValue({ query: async () => ({ rows, rowCount: rows.length }) } as any);
  });
  const sellerItems = [item(1), item(2), item(3)];

  it('tells the list owner about one want once, under the item it came closest to', async () => {
    rows = [
      row({ card_id: item(1), score: 0.58 }),
      row({ card_id: item(2), score: 0.66 }),
      row({ card_id: item(3), score: 0.61 }),
    ];
    const found = await nearMissesForCards(SELLER, sellerItems);
    expect([...found.keys()]).toEqual([item(2)]);
    expect(found.get(item(2))!.count).toBe(1);
  });

  it('tells nobody about a near miss where an introduction already runs between the two', async () => {
    rows = [row({ introduced: true }), row({ card_id: item(2), introduced: true })];
    expect((await nearMissesForCards(SELLER, sellerItems)).size).toBe(0);
  });

  it('tells nobody about two different numbers of the same kind', async () => {
    rows = [
      row({
        mine_identifiers: ids(['catalogue number', 'QX-2002']),
        other_identifiers: ids(['catalogue number', 'QX-1001']),
      }),
    ];
    expect((await nearMissesForCards(SELLER, sellerItems)).size).toBe(0);
  });

  it('tells the want one near miss per list, however many items came close', async () => {
    rows = Array.from({ length: 20 }, (_, n) =>
      row({ card_id: WANT, other_id: item(n), other_type: 'HAVE', other_account: SELLER, score: 0.55 + n / 100 }),
    );
    const e = (await nearMissesForCards(BUYER, [WANT])).get(WANT)!;
    expect(e.count).toBe(1);
    expect(e.items).toHaveLength(1);
  });

  it('answers only for the postings asked about, though it reads them all to keep one per person', async () => {
    rows = [row({ card_id: item(1), score: 0.7 }), row({ card_id: item(2), score: 0.6 })];
    // Asked about item 2 alone: the want is nearer item 1, so item 2 hears nothing.
    expect((await nearMissesForCards(SELLER, [item(2)])).size).toBe(0);
    expect((await nearMissesForCards(SELLER, [item(1)])).get(item(1))!.count).toBe(1);
  });
});
