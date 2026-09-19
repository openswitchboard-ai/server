/**
 * SEARCH AND SHELF, TIERED (Lachlan, 20 September 2026).
 *
 * The shelf stopped being a gate: the matcher also searches the whole board by
 * meaning, and every pair is put in a tier — SURE, POSSIBLE, or nothing (with
 * the near miss kept as it was) — by the pure tierFor in domain/matchTiers.ts.
 *
 * The lines themselves are PROVISIONAL and were fitted on the labelled set in
 * test/calibration, which has its own runner. So this suite pins the SHAPE of
 * the rules on small hand-made cases, and pins everything around them that
 * must hold whatever the lines end up being:
 *   - word agreement reads brands, models and head nouns, and generic words
 *     never agree on their own;
 *   - a cross-shelf pair can be SURE when its specifics agree;
 *   - different brands, or a head noun the other never mentions, are never
 *     SURE, and SURE is never reached on the blend alone;
 *   - every hard rule still applies to a searched candidate, a reserved shelf
 *     never comes back from a search, and the search can fail without taking
 *     the run with it;
 *   - SURE goes ahead of POSSIBLE in the line, and a POSSIBLE never takes a
 *     slot while a SURE waits;
 *   - the POSSIBLE cap holds;
 *   - a POSSIBLE carries its sentence everywhere it is named, in house style.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/crypto.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  decryptFields: vi.fn(async () => ({})),
  writeDecryptAudit: vi.fn(async () => 'decrypt-audit/x'),
}));

import * as db from '../../src/db.js';
import {
  CROSS_SHELF_TOP_N,
  POSSIBLE_MIN_COSINE,
  POSSIBLE_PER_POSTING_PER_DAY,
  POSSIBLE_WORDS_MIN_COSINE,
  SURE_MIN_COSINE,
  SURE_MIN_WORDS,
  headStem,
  tierFor,
  tokensOf,
  wordAgreement,
  type PairFacts,
} from '../../src/domain/matchTiers.js';
import { runMatchingForCard, searchQueryShape } from '../../src/domain/matcher.js';
import { rankByFit, resequenceCard, type FitFacts } from '../../src/domain/sequencer.js';
import {
  POSSIBLE_NOTE_SENTENCE,
  checkMatches,
  getStagePayload,
} from '../../src/domain/matches.js';
import { POSSIBLE_EMAIL_LINE, renderSummons } from '../../src/email/templates.js';
import { lintHumanCopy } from '../../src/email/lint.js';
import type { Config } from '../../src/config.js';

const cfg = { quotas: { maxOpenCards: 20 } } as unknown as Config;

const CANBERRA = {
  bucket: 'AU-ACT',
  lat: -35.28,
  lon: 149.13,
  radius_km: 25,
  reach: 'country' as const,
  country: 'AU',
};
const PERTH_RADIUS = {
  bucket: 'AU-WA',
  lat: -31.95,
  lon: 115.86,
  radius_km: 10,
  reach: 'radius' as const,
  country: 'AU',
};

const pair = (over: Partial<PairFacts>): PairFacts => ({
  semantic: 0.85,
  categoryA: 'goods.electronics.console.sim-racing',
  categoryB: 'goods.electronics.console.sim-racing',
  geoA: CANBERRA as any,
  geoB: CANBERRA as any,
  a: { kind: 'brake spring for Fanatec pedals', attributes: { brand: 'fanatec', model: 'csl elite' } },
  b: { kind: 'Fanatec CSL Elite brake spring', attributes: { brand: 'fanatec', model: 'csl elite pedals' } },
  ...over,
});

// ---------------------------------------------------------------------------
describe('word agreement', () => {
  it('reads brands, models and the head noun, and is symmetric', () => {
    const a = { kind: 'brake spring for Fanatec pedals', attributes: { brand: 'Fanatec', model: 'CSL Elite' } };
    const b = { kind: 'upgraded Fanatec pedal spring', attributes: { brand: 'fanatec', model: 'csl elite' } };
    const w = wordAgreement(a, b);
    expect(w).toMatchObject({ brand: 'agree', model: 'agree', head: 'agree', distinctive: true });
    expect(wordAgreement(b, a)).toEqual(w);
  });

  it('never lets generic words or condition words agree on their own', () => {
    const w = wordAgreement({ kind: 'used spring kit' }, { kind: 'spring part, good condition' });
    expect(w.score).toBe(0);
    expect(w.coverage).toBe(0);
    expect(w.sharedBeyondHead).toBe(false);
  });

  it('catches a head noun the other posting never mentions', () => {
    expect(
      wordAgreement({ kind: 'iPhone', attributes: { model: 'iphone 13' } }, { kind: 'iPhone case', attributes: { model: 'iphone 13' } })
        .head,
    ).toBe('conflict');
    expect(wordAgreement({ kind: 'guitar lessons' }, { kind: 'acoustic guitar' }).head).toBe('conflict');
    // A kit is what springs come in: the head of "pedal spring kit" is spring.
    expect(wordAgreement({ kind: 'fanatec spring' }, { kind: 'ClubSport pedal spring kit' }).head).toBe('agree');
  });

  it('knows a few plain equivalents', () => {
    expect(tokensOf('DualSense')).toEqual(['playstation', 'controller']);
    expect(tokensOf('rocket engines')).toEqual(['rocket', 'motor']);
    expect(
      wordAgreement({ kind: 'PlayStation controller' }, { kind: 'DualSense controller', attributes: { brand: 'sony' } })
        .head,
    ).toBe('agree');
  });

  it('sees two different brands', () => {
    expect(
      wordAgreement({ kind: 'brake spring', attributes: { brand: 'fanatec' } }, { kind: 'brake spring', attributes: { brand: 'thrustmaster' } })
        .brand,
    ).toBe('conflict');
  });
});

describe('the calibration fixes to the words', () => {
  it('never takes a number, a unit or a size for the head noun', () => {
    const w = wordAgreement(
      { kind: 'iPhone 13', attributes: { brand: 'Apple', model: 'iPhone 13' } },
      { kind: 'Apple iPhone 13 128 GB', attributes: { brand: 'Apple', model: 'iPhone 13' } },
    );
    expect(w.head).toBe('agree');
    expect(wordAgreement({ kind: 'Kindle Paperwhite 11th gen' }, { kind: 'Kindle Paperwhite' }).head).toBe('agree');
  });

  it('compares heads on their stems', () => {
    expect(headStem('walker')).toBe(headStem('walking'));
    expect(wordAgreement({ kind: 'dog walker' }, { kind: 'dog walking' }).head).toBe('agree');
    expect(wordAgreement({ kind: 'kombucha SCOBY' }, { kind: 'kombucha scoby and starter tea' }).head).toBe('agree');
  });

  it('calls two brands a conflict only where neither appears in the other posting', () => {
    expect(
      wordAgreement(
        { kind: 'Thermomix TM6', attributes: { brand: 'Vorwerk', model: 'TM6' } },
        { kind: 'Thermomix TM6 with extra bowl', attributes: { brand: 'Thermomix', model: 'TM6' } },
      ).brand,
    ).toBe('agree');
  });

  it('reads a model the same however it is punctuated', () => {
    for (const spelt of ['TB-303', 'TB303', 'tb 303']) {
      expect(tokensOf(spelt), spelt).toContain('tb303');
      expect(
        wordAgreement({ attributes: { model: spelt } }, { attributes: { model: 'TB-303' } }).model,
        spelt,
      ).toBe('agree');
    }
  });
});

describe('the tier', () => {
  it('is SURE where the meaning is close and the words agree', () => {
    const t = tierFor(pair({}));
    expect(t.tier).toBe('sure');
    expect(t.parts.shelvesCompatible).toBe(true);
  });

  it('can be SURE across shelves', () => {
    const t = tierFor(
      pair({
        categoryA: 'goods.motoring.parts',
        a: { kind: 'sim racing brake spring', attributes: { brand: 'fanatec', model: 'csl elite' } },
        b: { kind: 'upgraded Fanatec pedal spring', attributes: { brand: 'fanatec', model: 'csl elite' } },
        semantic: SURE_MIN_COSINE + 0.02,
      }),
    );
    expect(t.parts.shelvesCompatible).toBe(false);
    expect(t.parts.categoryCloseness).toBe(0);
    expect(t.parts.words.score).toBeGreaterThanOrEqual(SURE_MIN_WORDS);
    expect(t.tier).toBe('sure');
  });

  it('is never SURE on the blend alone, however good the shelf', () => {
    const vague = pair({ a: { kind: 'fanatec spring' }, b: { kind: 'ClubSport pedal spring kit' }, semantic: 0.78 });
    const t = tierFor(vague);
    expect(t.parts.blend).toBeGreaterThan(0.75);
    expect(t.tier).not.toBe('sure');
  });

  it('is POSSIBLE on very close meaning, or on a shared word and close enough meaning', () => {
    expect(
      tierFor(pair({ a: { kind: 'fanatec spring' }, b: { kind: 'ClubSport pedal spring kit' }, semantic: POSSIBLE_MIN_COSINE })).tier,
    ).toBe('possible');
    expect(
      tierFor(
        pair({
          a: { kind: 'Fanatec spring' },
          b: { kind: 'Fanatec ClubSport pedal spring kit' },
          semantic: POSSIBLE_WORDS_MIN_COSINE + 0.01,
        }),
      ).tier,
    ).toBe('possible');
  });

  it('is never SURE for two different brands, or a thing and its accessory', () => {
    const brands = tierFor(
      pair({
        a: { kind: 'brake spring', attributes: { brand: 'fanatec' } },
        b: { kind: 'brake spring', attributes: { brand: 'thrustmaster' } },
        semantic: 0.95,
      }),
    );
    expect(brands.parts.words.brand).toBe('conflict');
    expect(brands.tier).not.toBe('sure');
    const accessory = tierFor(
      pair({
        categoryA: 'goods.electronics.phone',
        categoryB: 'goods.electronics.phone-accessories',
        a: { kind: 'iPhone', attributes: { model: 'iphone 13' } },
        b: { kind: 'iPhone case', attributes: { model: 'iphone 13' } },
        semantic: 0.9,
      }),
    );
    expect(accessory.parts.words.head).toBe('conflict');
    expect(accessory.tier).not.toBe('sure');
    const lessons = tierFor(
      pair({
        categoryA: 'services.lessons.guitar',
        categoryB: 'goods.music.guitar',
        a: { kind: 'guitar lessons' },
        b: { kind: 'acoustic guitar', attributes: { brand: 'yamaha' } },
        semantic: 0.45,
      }),
    );
    expect(lessons.tier).toBe('nothing');
  });

  it('still fails on a hard rule, whatever the words say', () => {
    const t = tierFor(pair({ geoA: PERTH_RADIUS as any, geoB: { ...PERTH_RADIUS, lat: -35.28, lon: 149.13, bucket: 'AU-ACT' } as any }));
    expect(t.tier).toBe('nothing');
    expect(t.parts.hardRulesPass).toBe(false);
    expect(t.parts.failed).toBe('geo');
  });

  it('keeps a near miss on a compatible shelf and never across shelves', () => {
    const weak = { a: { kind: 'road bike' }, b: { kind: 'bike trainer' }, semantic: 0.4 };
    const same = tierFor(pair({ ...weak, categoryA: 'goods.bicycle.road', categoryB: 'goods.bicycle.road' }));
    const across = tierFor(pair({ ...weak, categoryA: 'goods.bicycle.road', categoryB: 'goods.sports.fitness.cardio' }));
    expect(['near-miss', 'nothing']).toContain(same.tier);
    expect(across.tier).toBe('nothing');
  });

  it('raises every line by the owner\u2019s bump', () => {
    const base = pair({ semantic: SURE_MIN_COSINE + 0.01 });
    expect(tierFor(base).tier).toBe('sure');
    expect(tierFor({ ...base, bumpHave: 0.05 }).tier).not.toBe('sure');
  });

  it('is pure', () => {
    expect(tierFor(pair({}))).toEqual(tierFor(pair({})));
  });
});

// ---------------------------------------------------------------------------
// The engine, against a board held in memory.
// ---------------------------------------------------------------------------
const SOURCE = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const ANA = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const BEPPE = 'cccccccc-3333-4333-8333-cccccccccccc';
const FOUND = 'dddddddd-4444-4444-8444-dddddddddddd';

const card = (over: Record<string, unknown>) => ({
  id: SOURCE,
  account_id: ANA,
  type: 'WANT',
  category: 'goods.motoring.parts',
  kind: 'sim racing brake spring',
  attributes: { brand: 'fanatec', model: 'csl elite' },
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

interface Board {
  sql: { text: string; params: any[] }[];
  gated: any[];
  searched: any[];
  searchFails: boolean;
  possiblesToday: number;
  inserted: any[][];
}
let board: Board;

function boardPool() {
  return {
    query: async (sql: string, params: any[] = []) => {
      const text = sql.replace(/\s+/g, ' ').trim();
      board.sql.push({ text, params });
      const rows = (r: any[]) => ({ rows: r, rowCount: r.length });
      if (/c\.embedding::text AS embedding_text/.test(sql)) return rows([card({})]);
      if (/\$15::uuid\[\]/.test(sql)) {
        if (board.searchFails) throw new Error('search went away');
        return rows(board.searched);
      }
      if (/LIMIT 50/.test(sql)) return rows(board.gated);
      if (/SELECT count\(\*\)::int AS n FROM \(/.test(sql)) return rows([{ n: board.gated.length }]);
      if (/certainty = 'possible' AND created_at/.test(sql)) {
        return rows([{ a: board.possiblesToday, b: 0 }]);
      }
      if (/INSERT INTO matches/.test(sql)) {
        board.inserted.push(params);
        return rows([{ id: `m-${board.inserted.length}` }]);
      }
      return rows([]);
    },
  } as any;
}

const found = (over: Record<string, unknown> = {}) =>
  card({
    id: FOUND,
    account_id: BEPPE,
    type: 'HAVE',
    category: 'goods.electronics.console.sim-racing',
    kind: 'upgraded Fanatec pedal spring',
    attributes: { brand: 'fanatec', model: 'csl elite' },
    similarity: 0.86,
    ...over,
  });

const log = vi.fn();

describe('the engine searches the whole board, and the hard rules still hold', () => {
  beforeEach(() => {
    board = { sql: [], gated: [], searched: [], searchFails: false, possiblesToday: 0, inserted: [] };
    log.mockReset();
    vi.spyOn(db, 'getPool').mockReturnValue(boardPool());
  });

  it('introduces a cross-shelf pair as SURE when its specifics agree', async () => {
    board.searched = [found()];
    const out = (await runMatchingForCard(cfg, SOURCE, log))!;
    expect(out.searched).toBe(1);
    expect(out.matchesCreated).toHaveLength(1);
    expect(out.possibles).toHaveLength(0);
    // certainty is the last column written.
    expect(board.inserted[0][9]).toBe('sure');
    expect(log).toHaveBeenCalledWith('matcher: match created', expect.objectContaining({ via_search: true, certainty: 'sure' }));
  });

  it('runs one search per posting, limited, and excludes what the shelf already found', async () => {
    board.gated = [found({ id: 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee', category: 'goods.motoring.parts' })];
    await runMatchingForCard(cfg, SOURCE, log);
    const searches = board.sql.filter((s) => /\$15::uuid\[\]/.test(s.text));
    expect(searches).toHaveLength(1);
    expect(searches[0].text).toContain(`LIMIT ${CROSS_SHELF_TOP_N}`);
    expect(searches[0].params[14]).toEqual(['eeeeeeee-5555-4555-8555-eeeeeeeeeeee']);
  });

  it('keeps every other hard rule in the search query', () => {
    const q = searchQueryShape({ account_id: ANA, type: 'WANT', category: 'goods.motoring.parts', geo: CANBERRA as any });
    expect(q.where).toContain("c.lifecycle_state = 'PUBLISHED'");
    expect(q.where).toContain('c.expires_at > now()');
    expect(q.where).toContain('NOT c.paused_by_kill_switch');
    expect(q.where).toContain('c.account_id <> $2::uuid');
    expect(q.where).toContain("a.status = 'active'");
    expect(q.where).toContain('match_mutes');
    expect(q.where).toContain('mm.muted_account = $2::uuid');
    // The geo box is still there; the shelf clause is not.
    expect(q.where).toContain('$4::boolean');
    expect(q.where).not.toContain('c.category = $3::text');
    expect(q.params[0]).toBe('HAVE');
  });

  it('drops a searched posting on a reserved or denied shelf', async () => {
    board.searched = [found({ category: 'services.trades.electrical' }), found({ category: 'social.dating.casual' })];
    const out = (await runMatchingForCard(cfg, SOURCE, log))!;
    expect(out.searched).toBe(0);
    expect(board.inserted).toHaveLength(0);
  });

  it('applies the geo rule to a searched posting', async () => {
    board.searched = [
      found({
        geo: { bucket: 'AU-WA', reach: 'radius', radius_km: 10 },
        geo_lat: -31.95,
        geo_lon: 115.86,
        geo_radius_km: 10,
      }),
    ];
    const out = (await runMatchingForCard(cfg, SOURCE, log))!;
    expect(out.searched).toBe(1);
    expect(board.inserted).toHaveLength(0);
  });

  it('never makes a searched posting about a different thing SURE', async () => {
    board.searched = [found({ kind: 'Fanatec CSL pedals', attributes: { brand: 'fanatec', model: 'csl pedals lc' }, similarity: 0.9 })];
    await runMatchingForCard(cfg, SOURCE, log);
    for (const row of board.inserted) expect(row[9]).not.toBe('sure');
  });

  it('survives a search that fails, with the shelf candidates intact', async () => {
    board.searchFails = true;
    board.gated = [found({ category: 'goods.motoring.parts' })];
    const out = (await runMatchingForCard(cfg, SOURCE, log))!;
    expect(out.searched).toBe(0);
    expect(out.matchesCreated).toHaveLength(1);
    expect(log).toHaveBeenCalledWith(
      'matcher: search across shelves failed, shelf candidates only',
      expect.objectContaining({ error: 'search went away' }),
    );
  });

  it('makes a POSSIBLE, and stops at the cap', async () => {
    const maybe = found({ kind: 'ClubSport pedal spring kit', attributes: {}, category: 'goods.motoring.parts', similarity: 0.85 });
    const src = { kind: 'fanatec spring', attributes: {} };
    board.gated = [maybe];
    const pool = boardPool();
    const q = pool.query;
    pool.query = async (sql: string, params: any[] = []) =>
      /c\.embedding::text AS embedding_text/.test(sql) ? { rows: [card(src)], rowCount: 1 } : q(sql, params);
    vi.spyOn(db, 'getPool').mockReturnValue(pool);

    const out = (await runMatchingForCard(cfg, SOURCE, log))!;
    expect(out.possibles).toHaveLength(1);
    expect(board.inserted[0][9]).toBe('possible');

    board.inserted = [];
    board.possiblesToday = POSSIBLE_PER_POSTING_PER_DAY;
    const capped = (await runMatchingForCard(cfg, SOURCE, log))!;
    expect(capped.possibles).toHaveLength(0);
    expect(board.inserted).toHaveLength(0);
    expect(log).toHaveBeenCalledWith('matcher: possible cap reached, not introduced', expect.anything());
  });
});

// ---------------------------------------------------------------------------
describe('the line: SURE before POSSIBLE', () => {
  const fact = (over: Partial<FitFacts>): FitFacts => ({
    matchId: 'x',
    limitsOverlap: false,
    distanceKm: 5,
    urgencyMatch: false,
    reliability: 0.5,
    arrivedAt: 1,
    ...over,
  });

  it('ranks a sure one first, whatever else the possible has going for it', () => {
    const possible = fact({ matchId: 'possible', certainty: 'possible', limitsOverlap: true, distanceKm: 1, arrivedAt: 0 });
    const sure = fact({ matchId: 'sure', certainty: 'sure', distanceKm: 40, arrivedAt: 9 });
    expect(rankByFit([possible, sure]).map((f) => f.matchId)).toEqual(['sure', 'possible']);
    // Absent reads as sure, as every introduction before tiers is.
    expect(rankByFit([possible, fact({ matchId: 'old' })])[0].matchId).toBe('old');
  });

  it('never gives a slot to a possible while a sure is waiting', async () => {
    const CARD_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
    const OTHER_SURE = 'aaaaaaaa-0000-4000-8000-0000000000b1';
    const OTHER_MAYBE = 'aaaaaaaa-0000-4000-8000-0000000000b2';
    const promotedIds: string[] = [];
    vi.spyOn(db, 'getPool').mockReturnValue({
      query: async (sql: string, params: any[] = []) => {
        const rows = (r: any[]) => ({ rows: r, rowCount: r.length });
        if (/FROM matches m\s+JOIN cards own/.test(sql)) {
          const base = {
            live: false,
            limits_overlap: false,
            own_urgency: null,
            own_slots: 1,
            own_sale: 'straight',
            own_gather_open: false,
            other_urgency: null,
            own_lat: null,
            own_lon: null,
            other_lat: null,
            other_lon: null,
            reliability: 0.5,
          };
          return rows([
            { ...base, id: 'm-sure', certainty: 'sure', other_card: OTHER_SURE, created_at: new Date(2) },
            { ...base, id: 'm-maybe', certainty: 'possible', other_card: OTHER_MAYBE, created_at: new Date(1) },
          ]);
        }
        // The sure one's other side is full, so it cannot go live yet.
        if (/SELECT c\.slots, c\.sale/.test(sql)) {
          return rows([{ slots: 1, sale: 'straight', gather_open: false, live_now: params[0] === OTHER_SURE ? 1 : 0 }]);
        }
        if (/UPDATE matches SET live = true/.test(sql)) {
          promotedIds.push(params[0]);
          return rows([{ id: params[0] }]);
        }
        return rows([]);
      },
    } as any);
    const promoted = await resequenceCard(CARD_A);
    expect(promoted).toEqual([]);
    expect(promotedIds).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe('a POSSIBLE says so, everywhere it is named', () => {
  const MATCH = 'ffffffff-6666-4666-8666-ffffffffffff';
  const theMatch = (certainty: 'sure' | 'possible') => ({
    id: MATCH,
    card_want: SOURCE,
    card_have: FOUND,
    account_want: ANA,
    account_have: BEPPE,
    score: 0.7,
    category: 'goods.electronics.console.sim-racing',
    kind: 'fanatec spring',
    stage: 2,
    interest_want: true,
    interest_have: true,
    state: 'open',
    channel_id: null,
    opened_at: null,
    live: true,
    certainty,
  });

  const use = (certainty: 'sure' | 'possible') =>
    vi.spyOn(db, 'getPool').mockReturnValue({
      query: async (sql: string) => {
        const rows = (r: any[]) => ({ rows: r, rowCount: r.length });
        if (/FROM matches/.test(sql) && /SELECT (\*|m\.\*)/.test(sql)) return rows([theMatch(certainty)]);
        if (/SELECT \* FROM cards WHERE id/.test(sql)) {
          return rows([found({ lifecycle_state: 'PUBLISHED' })]);
        }
        return rows([]);
      },
    } as any);

  it('on the sweep, in its first sentence and in possible_note', async () => {
    use('possible');
    const [entry] = await checkMatches(cfg, ANA);
    expect(entry.certainty).toBe('possible');
    expect(entry.possible_note).toEqual({ text: POSSIBLE_NOTE_SENTENCE, provenance: 'switchboard-system' });
    expect(entry.note.text).toMatch(/might be/);
    expect(entry.attributes.notes).toContainEqual({ text: POSSIBLE_NOTE_SENTENCE, provenance: 'switchboard-system' });
  });

  it('and not on a sure one', async () => {
    use('sure');
    const [entry] = await checkMatches(cfg, ANA);
    expect(entry.possible_note).toBeUndefined();
    expect(entry.certainty).toBeUndefined();
    expect(entry.note.text).not.toMatch(/might be/);
  });

  it('on every step asked about directly', async () => {
    use('possible');
    for (const step of [1, 2]) {
      const p: any = await getStagePayload(cfg, ANA, MATCH, step);
      expect(p.possible_note?.text, String(step)).toBe(POSSIBLE_NOTE_SENTENCE);
    }
  });

  it('in the summons email, and never on a blind one', () => {
    const f = { unsubscribe: 'https://u', preferences: 'https://p' } as any;
    const named = renderSummons({ count: 1, categoryLabel: 'goods.bicycle.mountain', blind: false, side: 'want', possible: true }, f);
    expect(named.text).toContain(POSSIBLE_EMAIL_LINE);
    const sure = renderSummons({ count: 1, categoryLabel: 'goods.bicycle.mountain', blind: false, side: 'want' }, f);
    expect(sure.text).not.toContain(POSSIBLE_EMAIL_LINE);
    const blind = renderSummons({ count: 1, blind: true, possible: true }, f);
    expect(blind.text).not.toContain(POSSIBLE_EMAIL_LINE);
  });

  it('in house style', async () => {
    use('possible');
    const [entry] = await checkMatches(cfg, ANA);
    for (const copy of [POSSIBLE_NOTE_SENTENCE, POSSIBLE_EMAIL_LINE, entry.note.text]) {
      expect(lintHumanCopy(copy), copy).toEqual([]);
      expect(copy).not.toMatch(/\bmatch(es)?\b|\bscores?\b|\bcards?\b/i);
    }
  });
});
