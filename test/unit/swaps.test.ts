/**
 * SWAPS: two wants on the social shelves may meet (Lachlan, 26 September 2026).
 *
 * The first production test posted a language exchange as two wants — one
 * person after Spanish who speaks English, one after English who speaks
 * Spanish — and the matcher never looked at the pair, because it only ever
 * retrieved the opposite type. This suite pins the whole of the change
 * (src/domain/swaps.ts):
 *   - retrieval: a want on social takes wants on social as candidates; a want
 *     on goods or services, and any have, is exactly as before;
 *   - one row per pair, in one canonical order, whichever side ran first;
 *   - the complement rule on a language exchange, and where it stops;
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
  languageComplement,
  languageSidesOf,
  onLanguageExchange,
  swapCategory,
  swapKind,
  swapPairOrder,
  swapsOnShelf,
} from '../../src/domain/swaps.js';
import {
  candidateQueryShape,
  runMatchingForCard,
  searchQueryShape,
} from '../../src/domain/matcher.js';
import {
  SWAP_NO_FIGURE_SENTENCE,
  assertNotSwap,
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
  it('is two wants, both on social', () => {
    expect(swapsOnShelf('social')).toBe(true);
    expect(swapsOnShelf('social.activity-partner.tennis')).toBe(true);
    expect(swapsOnShelf('socialite.x')).toBe(false);
    expect(swapsOnShelf('goods.bicycle.mountain')).toBe(false);
    expect(swapsOnShelf('services.tutoring.languages')).toBe(false);
    const w = (category: string) => ({ type: 'WANT', category });
    const h = (category: string) => ({ type: 'HAVE', category });
    expect(isSwapPair(w('social.language-exchange.tandem'), w('social.language-exchange'))).toBe(true);
    // Have with have stays off, on social too.
    expect(isSwapPair(h('social.hobby-group.book-club'), h('social.hobby-group.book-club'))).toBe(false);
    // A want and a have is an ordinary pair.
    expect(isSwapPair(w('social.activity-partner.tennis'), h('social.activity-partner.tennis'))).toBe(false);
    // Both must be on social: a social want never swaps with a goods want.
    expect(isSwapPair(w('social.activity-partner.tennis'), w('goods.sport.tennis'))).toBe(false);
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

  it('a want on goods or services, and any have, is opposite types only', () => {
    for (const q of [
      candidateQueryShape(src('WANT', 'goods.bicycle.mountain')),
      searchQueryShape(src('WANT', 'services.tutoring.languages')),
      candidateQueryShape(src('HAVE', 'social.language-exchange.tandem')),
      searchQueryShape(src('HAVE', 'social.activity-partner.tennis')),
    ]) {
      expect(q.where).not.toContain(SWAP_CLAUSE);
      expect(q.where.trimStart().startsWith('c.type = $1::text')).toBe(true);
    }
    expect(candidateQueryShape(src('HAVE', 'social.language-exchange.tandem')).params[0]).toBe('WANT');
  });
});

// ---------------------------------------------------------------------------
describe('the complement rule on a language exchange', () => {
  it('reads what each posting is after and what it brings, from kind and attributes', () => {
    expect(languageSidesOf({ kind: 'Spanish conversation partner' })).toEqual({ after: ['spanish'] });
    expect(languageSidesOf({ kind: 'English practice partner, I speak Spanish' })).toEqual({
      after: ['english'],
      brings: ['spanish'],
    });
    expect(languageSidesOf({ kind: 'I’m a native Spanish speaker wanting English practice' })).toEqual({
      after: ['english'],
      brings: ['spanish'],
    });
    expect(languageSidesOf({ kind: 'x', attributes: { language: 'Spanish', speaks: 'English' } })).toEqual({
      after: ['spanish'],
      brings: ['english'],
    });
    expect(languageSidesOf({ attributes: { language: 'Italian', proficiency: 'native' } })).toEqual({
      brings: ['italian'],
    });
    expect(
      languageSidesOf({ attributes: { language: 'Italian', offers: 'native Italian', wants: 'English' } }),
    ).toEqual({ after: ['english'], brings: ['italian'] });
    // A language the list does not know is read from an attribute as itself.
    expect(languageSidesOf({ attributes: { learning: 'Kaurna', speaks: 'English' } })).toEqual({
      after: ['kaurna'],
      brings: ['english'],
    });
  });

  it('never reads a third person as what the poster brings', () => {
    expect(languageSidesOf({ kind: 'looking for a native Spanish speaker' })).toEqual({ after: ['spanish'] });
    expect(languageSidesOf({ kind: 'partner who speaks Spanish' })).toEqual({ after: ['spanish'] });
  });

  it('leaves a kind that names two languages and marks neither undetermined', () => {
    expect(languageSidesOf({ kind: 'Spanish/English exchange' })).toEqual({});
  });

  it('refuses two identical "after Spanish, speak English" postings', () => {
    const same = { kind: 'Spanish conversation partner, I speak English' };
    expect(languageComplement(same, same)).toEqual({ ok: false, determined: true });
    const attrs = { kind: 'Spanish partner', attributes: { language: 'Spanish', speaks: 'English' } };
    expect(languageComplement(attrs, attrs).ok).toBe(false);
  });

  it('accepts the pair from 25 September, where each has the other half', () => {
    const a = { kind: 'Spanish conversation partner', attributes: { language: 'Spanish' } };
    const b = { kind: 'English practice partner, I speak Spanish' };
    expect(languageComplement(a, b)).toEqual({ ok: true, determined: true });
    expect(languageComplement(b, a)).toEqual({ ok: true, determined: true });
    const full = { kind: 'Spanish partner, I speak English' };
    expect(languageComplement(full, b)).toEqual({ ok: true, determined: true });
  });

  it('refuses where one half is known to be missing', () => {
    // B brings French; A is after Spanish.
    const a = { kind: 'Spanish conversation partner' };
    const b = { kind: 'English practice, I speak French' };
    expect(languageComplement(a, b).ok).toBe(false);
  });

  it('never blocks on silence', () => {
    // Two learners of the same language who say nothing of what they speak
    // may still meet: the embedding and the tiers decide.
    expect(languageComplement({ kind: 'Spanish conversation partner' }, { kind: 'Spanish practice' })).toEqual({
      ok: true,
      determined: false,
    });
    expect(languageComplement({ kind: 'language exchange' }, { attributes: {} })).toEqual({
      ok: true,
      determined: false,
    });
  });

  it('runs only on a language exchange shelf', () => {
    expect(onLanguageExchange('social.language-exchange.tandem', 'social.conversation.video-call')).toBe(true);
    expect(onLanguageExchange('social.language-exchange', 'social.language-exchange')).toBe(true);
    expect(onLanguageExchange('social.activity-partner.tennis', 'social.activity-partner.tennis')).toBe(false);
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
