/**
 * SWAPS: two wants on the social shelves may meet (Lachlan, 26 September 2026).
 *
 * The first production test posted a language exchange as two wants — one
 * person after Spanish who speaks English, one after English who speaks
 * Spanish — and the matcher never looked at the pair, because it only ever
 * retrieved the opposite type. This suite pins the whole of the change
 * (src/domain/swaps.ts):
 *   - retrieval: a want on social takes wants on social as candidates, and a
 *     want on services takes wants on services (only ones that offer
 *     something, where it offers nothing itself); a want on goods, and any
 *     have, is exactly as before;
 *   - one row per pair, in one canonical order, whichever side ran first;
 *   - the complement rule, one general rule for every swap (the same day it
 *     replaced the language-only one), and where it stops;
 *   - no band is opened for a swap, and no figure or payment can be put on one;
 *   - every sentence either side reads says they are both looking.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/crypto.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  decryptFields: vi.fn(async () => ({ price: JSON.stringify({ band: { min: 1, max: 2 }, ccy: 'AUD' }) })),
  writeDecryptAudit: vi.fn(async () => 'decrypt-audit/x'),
}));

import * as db from '../../src/db.js';
import * as crypto from '../../src/crypto.js';
import {
  isSwapPair,
  statesAnOffer,
  swapCategory,
  swapComplement,
  swapKind,
  swapPairOrder,
  swapSidesOf,
  swapTopLevel,
  swapWords,
  swapsOnShelf,
} from '../../src/domain/swaps.js';
import {
  candidateQueryShape,
  runMatchingForCard,
  searchQueryShape,
} from '../../src/domain/matcher.js';
import {
  LOST_PET_NO_FIGURE_SENTENCE,
  SWAP_NO_FIGURE_SENTENCE,
  assertNotSwap,
  noMoneySentence,
  buildSignal,
  checkMatches,
  readerSide,
  signalNote,
  type MatchRow,
} from '../../src/domain/matches.js';
import { proposeOffer } from '../../src/domain/offers.js';
import { proposeSettlement } from '../../src/domain/settlements.js';
import { sendNumberLink } from '../../src/domain/humanLinks.js';
import { renderSummons } from '../../src/email/templates.js';
import { lintHumanCopy } from '../../src/email/lint.js';
import { OsbError } from '../../src/protocol.js';
import type { Config } from '../../src/config.js';

const cfg = { quotas: { maxOpenCards: 20, maxOffersPerHour: 10 } } as unknown as Config;

const CANBERRA = { bucket: 'AU-ACT', lat: -35.28, lon: 149.13, radius_km: 25, reach: 'anywhere' as const };

// Two posting ids in a known order: LOW sorts before HIGH.
const LOW = '11111111-1111-4111-8111-111111111111';
const HIGH = '99999999-9999-4999-8999-999999999999';
const ANA = 'aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa';
const BEN = 'bbbbbbbb-3333-4333-8333-bbbbbbbbbbbb';

// ---------------------------------------------------------------------------
describe('which pairs are swaps', () => {
  it('is two wants on the same top level, social or services', () => {
    expect(swapsOnShelf('social')).toBe(true);
    expect(swapsOnShelf('social.activity-partner.tennis')).toBe(true);
    expect(swapsOnShelf('services.lessons.guitar')).toBe(true);
    expect(swapsOnShelf('services')).toBe(true);
    expect(swapsOnShelf('socialite.x')).toBe(false);
    expect(swapsOnShelf('servicesx.y')).toBe(false);
    expect(swapsOnShelf('goods.bicycle.mountain')).toBe(false);
    // Lost and found pets: two owners are not each other's answer.
    expect(swapsOnShelf('social.community.lost-pet')).toBe(false);
    expect(swapTopLevel('services.repairs.bike')).toBe('services');
    expect(swapTopLevel('goods.bicycle')).toBeUndefined();
    const w = (category: string) => ({ type: 'WANT', category });
    const h = (category: string) => ({ type: 'HAVE', category });
    expect(isSwapPair(w('social.language-exchange.tandem'), w('social.language-exchange'))).toBe(true);
    expect(isSwapPair(w('services.lessons.guitar'), w('services.repairs.bike'))).toBe(true);
    // Have with have stays off, on social too.
    expect(isSwapPair(h('social.hobby-group.book-club'), h('social.hobby-group.book-club'))).toBe(false);
    // A want and a have is an ordinary pair.
    expect(isSwapPair(w('social.activity-partner.tennis'), h('social.activity-partner.tennis'))).toBe(false);
    // Same top level: a social want never swaps with a goods or a services want.
    expect(isSwapPair(w('social.activity-partner.tennis'), w('goods.sport.tennis'))).toBe(false);
    expect(isSwapPair(w('social.activity-partner.tennis'), w('services.lessons.tennis'))).toBe(false);
    expect(isSwapPair(w('social.community.lost-pet'), w('social.community.lost-pet'))).toBe(false);
  });

  it('orders a pair the same way whichever side is processed', () => {
    const a = { id: HIGH };
    const b = { id: LOW };
    expect(swapPairOrder(a, b).map((x) => x.id)).toEqual([LOW, HIGH]);
    expect(swapPairOrder(b, a).map((x) => x.id)).toEqual([LOW, HIGH]);
    expect(swapPairOrder({ id: HIGH.toUpperCase() }, b).map((x) => x.id)).toEqual([LOW, HIGH.toUpperCase()]);
  });

  it('files a swap under a shelf true of both, and keeps a word only where both agree', () => {
    expect(swapCategory('social.language-exchange.tandem', 'social.language-exchange.tandem')).toBe(
      'social.language-exchange.tandem',
    );
    expect(swapCategory('social.language-exchange.tandem', 'social.language-exchange.conversation-practice')).toBe(
      'social.language-exchange',
    );
    // Sharing only the top level: the first posting's shelf stands.
    expect(swapCategory('social.activity-partner.tennis', 'social.hobby-group.book-club')).toBe(
      'social.activity-partner.tennis',
    );
    expect(swapKind('Tennis partner', ' tennis  PARTNER ')).toBe('Tennis partner');
    expect(swapKind('Spanish conversation partner', 'English practice partner')).toBeNull();
    expect(swapKind(null, 'tennis partner')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe('retrieval', () => {
  const src = (type: string, category: string) => ({ account_id: 'acct-1', type, category, geo: CANBERRA as any });
  const SWAP_CLAUSE = "c.type = 'WANT'";

  it('a want on social takes other wants on social as well as haves', () => {
    for (const q of [
      candidateQueryShape(src('WANT', 'social.language-exchange.tandem')),
      searchQueryShape(src('WANT', 'social.language-exchange.tandem')),
    ]) {
      expect(q.params[0]).toBe('HAVE');
      expect(q.where).toContain('c.type = $1::text');
      expect(q.where).toContain(SWAP_CLAUSE);
      expect(q.where).toContain("c.category = 'social'");
      expect(q.where).toContain("left(c.category, 7) = 'social.'");
      // Every other rule still applies to a swap candidate.
      expect(q.where).toContain('c.account_id <> $2::uuid');
      expect(q.where).toContain('match_mutes');
      expect(q.where).toContain("c.lifecycle_state = 'PUBLISHED'");
      expect(q.where).toContain('$4::boolean');
    }
  });

  it('a want on services takes other services wants, and only ones that offer, where it offers nothing', () => {
    const bare = candidateQueryShape(src('WANT', 'services.trades-help.plumbing'));
    expect(bare.where).toContain(SWAP_CLAUSE);
    expect(bare.where).toContain("c.category = 'services'");
    expect(bare.where).toContain("left(c.category, 9) = 'services.'");
    expect(bare.where).toContain("c.attributes ?| ARRAY['offers'");
    expect(bare.where).not.toContain("'social.'");
    // A source that offers something needs no filter on the other side.
    const offering = candidateQueryShape({
      ...src('WANT', 'services.lessons.guitar'),
      attributes: { offers: 'help with a bike' },
    } as any);
    expect(offering.where).toContain(SWAP_CLAUSE);
    expect(offering.where).not.toContain('?|');
    // Social never filters on an offer.
    expect(candidateQueryShape(src('WANT', 'social.activity-partner.tennis')).where).not.toContain('?|');
  });

  it('a want on goods, a want on lost and found pets, and any have, is opposite types only', () => {
    for (const q of [
      candidateQueryShape(src('WANT', 'goods.bicycle.mountain')),
      searchQueryShape(src('WANT', 'goods.bicycle.mountain')),
      candidateQueryShape(src('WANT', 'social.community.lost-pet')),
      candidateQueryShape(src('HAVE', 'social.language-exchange.tandem')),
      searchQueryShape(src('HAVE', 'social.activity-partner.tennis')),
      candidateQueryShape(src('HAVE', 'services.lessons.guitar')),
    ]) {
      expect(q.where).not.toContain(SWAP_CLAUSE);
      expect(q.where.trimStart().startsWith('c.type = $1::text')).toBe(true);
    }
    expect(candidateQueryShape(src('HAVE', 'social.language-exchange.tandem')).params[0]).toBe('WANT');
  });
});

// ---------------------------------------------------------------------------
describe('the complement rule, one rule for every swap', () => {
  it('normalises words for case, punctuation and a plural, and drops the empty ones', () => {
    expect(swapWords('Guitar LESSONS, for beginners!')).toEqual(['guitar', 'beginner']);
    expect(swapWords('Bike repairs')).toEqual(['bike', 'repair']);
    expect(swapWords('a partner to practise with')).toEqual([]);
  });

  it('reads what a posting offers from the offer keys and first-person words, and what it wants from the rest', () => {
    expect(
      swapSidesOf({
        category: 'social.language-exchange.tandem',
        kind: 'Spanish conversation partner',
        attributes: { language: 'Spanish', offers: 'English' },
      }),
    ).toEqual({ offers: ['english'], wants: ['spanish', 'language', 'tandem'] });
    expect(swapSidesOf({ kind: 'English practice partner, I speak Spanish' })).toEqual({
      offers: ['spanish'],
      wants: ['english'],
    });
    expect(swapSidesOf({ kind: 'I’m a native Spanish speaker wanting English practice' })).toEqual({
      offers: ['spanish'],
      wants: ['english'],
    });
    expect(
      swapSidesOf({ category: 'services.repairs.bike', kind: 'bike service', attributes: { in_exchange: 'Guitar lessons' } }),
    ).toEqual({ offers: ['guitar'], wants: ['bike', 'service', 'repair'] });
    // Any key on the offered list, and any word: nothing here is a language list.
    expect(swapSidesOf({ attributes: { learning: 'Kaurna', speaks: 'English' } })).toEqual({
      offers: ['english'],
      wants: ['kaurna'],
    });
    // Silence about an offer is silence.
    expect(swapSidesOf({ kind: 'tennis partner' }).offers).toBeUndefined();
    expect(statesAnOffer({ kind: 'tennis partner' })).toBe(false);
    expect(statesAnOffer({ kind: 'plumber, I can teach guitar' })).toBe(true);
    expect(statesAnOffer({ attributes: { offers: 'a lift to the station' } })).toBe(true);
  });

  it('never reads a third person as what the poster offers', () => {
    expect(swapSidesOf({ kind: 'looking for a native Spanish speaker' }).offers).toBeUndefined();
    expect(swapSidesOf({ kind: 'partner who speaks Spanish' }).offers).toBeUndefined();
  });

  it('refuses two identical "after Spanish, offer English" postings', () => {
    const same = { category: 'social.language-exchange.tandem', kind: 'Spanish partner', attributes: { language: 'Spanish', offers: 'English' } };
    expect(swapComplement(same, same)).toEqual({ ok: false, determined: true });
    const inWords = { kind: 'Spanish conversation partner, I speak English' };
    expect(swapComplement(inWords, inWords).ok).toBe(false);
  });

  it('accepts the pair from 25 September, where each has the other half', () => {
    const a = { category: 'social.language-exchange.tandem', kind: 'Spanish conversation partner', attributes: { language: 'Spanish', offers: 'English' } };
    const b = { category: 'social.language-exchange.tandem', kind: 'English practice partner', attributes: { language: 'English', speaks: 'Spanish' } };
    expect(swapComplement(a, b)).toEqual({ ok: true, determined: true });
    expect(swapComplement(b, a)).toEqual({ ok: true, determined: true });
    // One side silent on its offer: only the stated half is checked.
    expect(swapComplement(a, { kind: 'English practice partner' })).toEqual({ ok: true, determined: true });
  });

  it('pairs a services swap where each offers what the other is after, whatever the thing', () => {
    const guitarist = {
      category: 'services.repairs.bike',
      kind: 'bike repair',
      attributes: { offers: 'guitar lessons' },
    };
    const mechanic = {
      category: 'services.lessons.guitar',
      kind: 'guitar lessons',
      attributes: { offers: 'bike repairs' },
    };
    expect(swapComplement(guitarist, mechanic)).toEqual({ ok: true, determined: true });
    // A stated offer the other side is not after blocks.
    const baker = { category: 'services.lessons.guitar', kind: 'guitar lessons', attributes: { offers: 'dog walking' } };
    expect(swapComplement(guitarist, baker).ok).toBe(false);
  });

  it('never pairs two services wants where neither offers anything', () => {
    const a = { category: 'services.trades-help.plumbing', kind: 'plumber for a leaking tap' };
    const b = { category: 'services.trades-help.plumbing', kind: 'plumber, blocked drain' };
    expect(swapComplement(a, b)).toEqual({ ok: false, determined: false });
    // One offer is enough to ask the question.
    expect(swapComplement({ ...a, attributes: { offers: 'plumbing' } }, b)).toEqual({ ok: true, determined: true });
  });

  it('never blocks on silence on social', () => {
    // Two tennis partners, and two learners who say nothing of what they
    // offer, may still meet: the embedding and the tiers decide.
    const t = { category: 'social.activity-partner.tennis', kind: 'tennis partner' };
    expect(swapComplement(t, t)).toEqual({ ok: true, determined: false });
    expect(swapComplement({ kind: 'Spanish conversation partner' }, { kind: 'Spanish practice' })).toEqual({
      ok: true,
      determined: false,
    });
  });

  it('refuses where one half is known to be missing', () => {
    // B offers French; A is after Spanish.
    const a = { kind: 'Spanish conversation partner' };
    const b = { kind: 'English practice, I speak French' };
    expect(swapComplement(a, b).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The engine, against a board held in memory (the shape matchTiers.test.ts uses).
// ---------------------------------------------------------------------------
const posting = (over: Record<string, unknown>) => ({
  id: LOW,
  account_id: ANA,
  type: 'WANT',
  category: 'social.activity-partner.tennis',
  kind: 'tennis partner',
  attributes: { experience: 'some', frequency: 'weekly' },
  geo: { bucket: 'AU-ACT', reach: 'anywhere' },
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

interface Board {
  source: any;
  gated: any[];
  inserted: any[][];
  nearMisses: any[][];
}
let board: Board;

function boardPool() {
  return {
    query: async (sql: string, params: any[] = []) => {
      const rows = (r: any[]) => ({ rows: r, rowCount: r.length });
      if (/c\.embedding::text AS embedding_text/.test(sql)) return rows([board.source]);
      if (/\$15::uuid\[\]/.test(sql)) return rows([]);
      if (/LIMIT 50/.test(sql)) return rows(board.gated);
      if (/SELECT count\(\*\)::int AS n FROM \(/.test(sql)) return rows([{ n: board.gated.length }]);
      if (/certainty = 'possible' AND created_at/.test(sql)) return rows([{ a: 0, b: 0 }]);
      if (/INSERT INTO matches/.test(sql)) {
        // The unique key over (card_want, card_have), as Postgres keeps it.
        const dup = board.inserted.some((p) => p[0] === params[0] && p[1] === params[1]);
        if (dup) return rows([]);
        board.inserted.push(params);
        return rows([{ id: `m-${board.inserted.length}` }]);
      }
      if (/INSERT INTO near_misses/.test(sql)) {
        board.nearMisses.push(params);
        return rows([]);
      }
      return rows([]);
    },
  } as any;
}

const log = vi.fn();

describe('the engine introduces two wants on social, once', () => {
  beforeEach(() => {
    board = { source: posting({}), gated: [], inserted: [], nearMisses: [] };
    log.mockReset();
    vi.mocked(crypto.decryptFields).mockClear();
    vi.spyOn(db, 'getPool').mockReturnValue(boardPool());
  });

  const lowPosting = () => posting({ id: LOW, account_id: ANA });
  const highPosting = () => posting({ id: HIGH, account_id: BEN, similarity: 0.97 });

  it('writes one swap row, in canonical order, from either side', async () => {
    // HIGH is processed first and finds LOW.
    board.source = posting({ id: HIGH, account_id: BEN });
    board.gated = [{ ...lowPosting(), similarity: 0.97 }];
    const first = (await runMatchingForCard(cfg, HIGH, log))!;
    expect(first.matchesCreated).toHaveLength(1);
    const row = board.inserted[0];
    expect(row[0]).toBe(LOW); // card_want: the smaller id
    expect(row[1]).toBe(HIGH); // card_have: the larger, a want as well
    expect(row[2]).toBe(ANA);
    expect(row[3]).toBe(BEN);
    expect(row[5]).toBe('social.activity-partner.tennis');
    expect(row[8]).toBe('tennis partner'); // both said it, so it is true of both
    expect(row[10]).toBe(true); // swap
    expect(log).toHaveBeenCalledWith('matcher: match created', expect.objectContaining({ swap: true }));

    // Then LOW is processed and finds HIGH: the same key, so nothing new.
    board.source = lowPosting();
    board.gated = [highPosting()];
    const second = (await runMatchingForCard(cfg, LOW, log))!;
    expect(second.matchesCreated).toHaveLength(0);
    expect(board.inserted).toHaveLength(1);
  });

  it('opens no price band for a swap, even where one is stored', async () => {
    board.source = posting({ id: LOW, price_enc: Buffer.from('band') });
    board.gated = [posting({ id: HIGH, account_id: BEN, price_enc: Buffer.from('band'), similarity: 0.97 })];
    const out = (await runMatchingForCard(cfg, LOW, log))!;
    expect(out.matchesCreated).toHaveLength(1);
    expect(crypto.decryptFields).not.toHaveBeenCalled();
    // No limits and no room over an ask on a swap.
    expect(board.inserted[0][6]).toBe(false);
    expect(board.inserted[0][7]).toBe(false);
  });

  it('keeps a want and a have exactly as before', async () => {
    board.source = posting({ id: HIGH, account_id: BEN });
    board.gated = [posting({ id: LOW, account_id: ANA, type: 'HAVE', similarity: 0.97 })];
    await runMatchingForCard(cfg, HIGH, log);
    expect(board.inserted).toHaveLength(1);
    // The want in card_want even though its id is the larger.
    expect(board.inserted[0][0]).toBe(HIGH);
    expect(board.inserted[0][1]).toBe(LOW);
    expect(board.inserted[0][10]).toBe(false);
  });

  it('refuses two identical language postings that say so, and records no near miss', async () => {
    const same = {
      category: 'social.language-exchange.tandem',
      kind: 'Spanish conversation partner, I speak English',
      attributes: { language: 'Spanish', speaks: 'English', format: 'online' },
    };
    board.source = posting({ id: LOW, ...same });
    board.gated = [posting({ id: HIGH, account_id: BEN, ...same, similarity: 0.99 })];
    const out = (await runMatchingForCard(cfg, LOW, log))!;
    expect(out.matchesCreated).toHaveLength(0);
    expect(board.inserted).toHaveLength(0);
    expect(board.nearMisses).toHaveLength(0);
    expect(log).toHaveBeenCalledWith('matcher: swap is not a complement', expect.anything());
  });

  it('never introduces two services wants that offer nothing, and never a want to a want of another shape', async () => {
    const plumber = {
      category: 'services.trades-help.plumbing',
      kind: 'plumber',
      attributes: { day_part: 'weekend' },
    };
    board.source = posting({ id: LOW, ...plumber });
    board.gated = [posting({ id: HIGH, account_id: BEN, ...plumber, similarity: 0.99 })];
    let out = (await runMatchingForCard(cfg, LOW, log))!;
    expect(out.matchesCreated).toHaveLength(0);
    expect(board.inserted).toHaveLength(0);
    expect(board.nearMisses).toHaveLength(0);

    // A lost pet is a want on social, and a tennis partner is too: not a swap
    // by shape, and never an ordinary want-and-have pair either.
    log.mockReset();
    board.source = posting({ id: LOW });
    board.gated = [
      posting({ id: HIGH, account_id: BEN, category: 'social.community.lost-pet', kind: 'lost kelpie', similarity: 0.97 }),
    ];
    out = (await runMatchingForCard(cfg, LOW, log))!;
    expect(out.matchesCreated).toHaveLength(0);
    expect(board.inserted).toHaveLength(0);
  });

  it('introduces a services swap where each offers what the other is after', async () => {
    board.source = posting({
      id: LOW,
      category: 'services.lessons.guitar',
      kind: 'guitar lessons',
      attributes: { offers: 'bike repairs', format: 'in-person' },
    });
    board.gated = [
      posting({
        id: HIGH,
        account_id: BEN,
        category: 'services.lessons.guitar',
        kind: 'guitar lessons',
        attributes: { offers: 'dog walking', format: 'in-person' },
        similarity: 0.99,
      }),
    ];
    // Each wants guitar lessons; one offers bike repairs, which the other is
    // not after. A stated mismatch blocks.
    await runMatchingForCard(cfg, LOW, log);
    expect(board.inserted).toHaveLength(0);
    expect(log).toHaveBeenCalledWith('matcher: swap is not a complement', expect.anything());

    log.mockReset();
    board.source = posting({
      id: LOW,
      category: 'services.repairs.bike',
      kind: 'bike repair',
      attributes: { offers: 'guitar lessons', format: 'in-person' },
    });
    board.gated = [
      posting({
        id: HIGH,
        account_id: BEN,
        category: 'services.lessons.guitar',
        kind: 'guitar lessons',
        attributes: { offers: 'bike repairs', format: 'in-person' },
        similarity: 0.95,
      }),
    ];
    await runMatchingForCard(cfg, LOW, log);
    expect(log).not.toHaveBeenCalledWith('matcher: swap is not a complement', expect.anything());
    for (const row of board.inserted) expect(row[10]).toBe(true);
  });

  it('lets the complementary pair through the rule', async () => {
    board.source = posting({
      id: LOW,
      category: 'social.language-exchange.tandem',
      kind: 'Spanish conversation partner, I speak English',
      attributes: { language: 'Spanish', format: 'online' },
    });
    board.gated = [
      posting({
        id: HIGH,
        account_id: BEN,
        category: 'social.language-exchange.tandem',
        kind: 'English practice partner, I speak Spanish',
        attributes: { language: 'English', format: 'online' },
        similarity: 0.95,
      }),
    ];
    await runMatchingForCard(cfg, LOW, log);
    expect(log).not.toHaveBeenCalledWith('matcher: swap is not a complement', expect.anything());
    // Whatever the tiers made of it, anything written is one swap row, with
    // no word that belongs to only one of them.
    for (const row of board.inserted) {
      expect(row[10]).toBe(true);
      expect(row[8]).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
describe('downstream: both people are looking, and there is no figure', () => {
  const MATCH = 'ffffffff-6666-4666-8666-ffffffffffff';
  const swapMatch = (over: Partial<MatchRow> = {}): MatchRow =>
    ({
      id: MATCH,
      card_want: LOW,
      card_have: HIGH,
      account_want: ANA,
      account_have: BEN,
      score: 0.9,
      category: 'social.activity-partner.tennis',
      kind: 'tennis partner',
      stage: 2,
      interest_want: true,
      interest_have: true,
      state: 'open',
      channel_id: null,
      opened_at: null,
      live: true,
      certainty: 'sure',
      swap: true,
      ...over,
    }) as MatchRow;

  const usePool = (m: MatchRow) =>
    vi.spyOn(db, 'getPool').mockReturnValue({
      query: async (sql: string) => {
        const rows = (r: any[]) => ({ rows: r, rowCount: r.length });
        if (/FROM matches/.test(sql) && /SELECT (\*|m\.\*)/.test(sql)) return rows([m]);
        if (/SELECT \* FROM cards WHERE id/.test(sql)) {
          return rows([posting({ id: HIGH, account_id: BEN, kind: 'tennis partner' })]);
        }
        return rows([]);
      },
    } as any);

  it('reads "looking for" on both sides, whichever column each is in', async () => {
    const m = swapMatch();
    expect((await buildSignal(m, ANA)).counterparty_type).toBe('looking_for');
    expect((await buildSignal(m, BEN)).counterparty_type).toBe('looking_for');
    expect(readerSide(m, ANA)).toBe('want');
    expect(readerSide(m, BEN)).toBe('want');
    // An ordinary pair is untouched.
    const plain = swapMatch({ swap: false });
    expect((await buildSignal(plain, ANA)).counterparty_type).toBe('offering');
    expect(readerSide(plain, BEN)).toBe('have');
    expect(() => readerSide(m, 'someone-else')).toThrow();
  });

  it('says they are looking too, and never that they have one or want "yours"', () => {
    for (const certainty of ['sure', 'possible'] as const) {
      const note = signalNote('social.activity-partner.tennis', 'looking_for', 'tennis partner', certainty, true);
      expect(note.text).toContain('looking for');
      expect(note.text).toContain('too');
      expect(note.text).not.toContain('like yours');
      expect(note.text).not.toContain('has a');
      expect(lintHumanCopy(note.text)).toEqual([]);
    }
  });

  it('the sweep carries the swap sentence and the flag, for both people', async () => {
    usePool(swapMatch());
    for (const who of [ANA, BEN]) {
      const [entry] = await checkMatches(cfg, who);
      expect(entry.swap).toBe(true);
      expect(entry.signal.counterparty_type).toBe('looking_for');
      expect(entry.note.text).toContain('looking for a tennis partner too');
      expect(entry.offers).toBeUndefined();
    }
  });

  it('refuses a figure, a figure page and a payment on a swap, in words', async () => {
    expect(() => assertNotSwap({ swap: true })).toThrow(OsbError);
    expect(() => assertNotSwap({ swap: false })).not.toThrow();
    usePool(swapMatch());
    const offer = proposeOffer(cfg, ANA, {
      match_id: MATCH,
      amount: 20,
      ccy: 'AUD',
      expiry: new Date(Date.now() + 86_400_000).toISOString(),
    });
    await expect(offer).rejects.toMatchObject({
      payload: { code: 'NOT_UNLOCKED_YET', human_action: SWAP_NO_FIGURE_SENTENCE },
    });
    await expect(sendNumberLink(cfg, BEN, MATCH, { amount: 20, ccy: 'AUD' })).rejects.toMatchObject({
      payload: { code: 'NOT_UNLOCKED_YET', human_action: SWAP_NO_FIGURE_SENTENCE },
    });
    usePool(swapMatch({ stage: 3 }));
    await expect(
      proposeSettlement(cfg, ANA, { match_id: MATCH, amount: 20, ccy: 'AUD' }),
    ).rejects.toMatchObject({ payload: { code: 'SETTLEMENT_UNAVAILABLE', human_action: SWAP_NO_FIGURE_SENTENCE } });
    expect(lintHumanCopy(SWAP_NO_FIGURE_SENTENCE)).toEqual([]);
  });

  it('refuses a figure, a figure page and a payment on lost and found pets, in words', async () => {
    const pets = swapMatch({ swap: false, category: 'social.community.lost-pet', kind: 'lost kelpie' });
    expect(() => assertNotSwap(pets)).toThrow(OsbError);
    expect(noMoneySentence(pets)).toBe(LOST_PET_NO_FIGURE_SENTENCE);
    expect(noMoneySentence(swapMatch({ swap: false }))).toBeUndefined();
    usePool(pets);
    await expect(
      proposeOffer(cfg, ANA, {
        match_id: MATCH,
        amount: 50,
        ccy: 'AUD',
        expiry: new Date(Date.now() + 86_400_000).toISOString(),
      }),
    ).rejects.toMatchObject({ payload: { code: 'NOT_UNLOCKED_YET', human_action: LOST_PET_NO_FIGURE_SENTENCE } });
    await expect(sendNumberLink(cfg, BEN, MATCH, { amount: 50, ccy: 'AUD' })).rejects.toMatchObject({
      payload: { code: 'NOT_UNLOCKED_YET', human_action: LOST_PET_NO_FIGURE_SENTENCE },
    });
    usePool({ ...pets, stage: 3 });
    await expect(
      proposeSettlement(cfg, ANA, { match_id: MATCH, amount: 50, ccy: 'AUD' }),
    ).rejects.toMatchObject({ payload: { code: 'SETTLEMENT_UNAVAILABLE', human_action: LOST_PET_NO_FIGURE_SENTENCE } });
    expect(lintHumanCopy(LOST_PET_NO_FIGURE_SENTENCE)).toEqual([]);
  });

  it('the summons names the reader’s own thing and says the other is looking too', () => {
    const f = { settingsUrl: 'https://x/settings', unsubUrl: 'https://x/unsub' };
    const mail = renderSummons(
      { count: 1, categoryLabel: 'Spanish conversation partner', blind: false, side: 'want', swap: true },
      f,
    );
    expect(mail.text).toContain('has come forward about the spanish conversation partner you are after.');
    expect(mail.text).toContain('They are looking too');
    expect(mail.text).not.toContain('what they have');
    expect(mail.text).not.toContain(' with ');
    // And an ordinary want is exactly as it was.
    const plain = renderSummons({ count: 1, categoryLabel: 'mountain bike', blind: false, side: 'want' }, f);
    expect(plain.text).toContain('has come forward with a mountain bike.');
  });
});
