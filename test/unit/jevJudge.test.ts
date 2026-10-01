/**
 * JEV AS THE JUDGE ON THE BORDERLINE (founder, 29 September 2026;
 * src/domain/jevJudge.ts).
 *
 * What this suite pins:
 *   - JEV_MATCHING: on in dev and off in prod by default, anything else fails boot;
 *   - the prod refusal is lifted for the matching path ONLY: the shadow still
 *     refuses prod, and prod does not call out at all unless the flag is on;
 *   - the thresholds, with the parts guard capping a SURE at POSSIBLE;
 *   - which rules tiers are put to Jev, and which are not;
 *   - a timeout, an error or a half answer leaves the rules' tier;
 *   - the calls are made together, and only for the top N;
 *   - what is sent is the pair state and nothing else;
 *   - in the matcher: flag off is the rules exactly; flag on moves the tier
 *     and records judged_by; Jev timing out leaves the rules' tier.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/crypto.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  decryptFields: vi.fn(async () => ({})),
  writeDecryptAudit: vi.fn(async () => 'decrypt-audit/x'),
}));

import * as db from '../../src/db.js';
import { jevMatchingFrom, type Config } from '../../src/config.js';
import {
  JEV_ENDPOINT,
  JEV_MODEL,
  askJev,
  askJevForMatching,
  initJev,
  jevEnabled,
  jevMatchingEnabled,
  resetJevForTests,
  type JevResult,
} from '../../src/shadow/jev.js';
import {
  JEV_JUDGE_TIMEOUT_MS,
  JEV_JUDGE_TOP_N,
  jevJudgesTier,
  JEV_NEAR_MISS_SAME_KIND_MIN,
  flooredTier,
  jevTier,
  judgeWithJev,
  type JudgeRequest,
} from '../../src/domain/jevJudge.js';
import { partsGuardAllowsSure, tierFor } from '../../src/domain/matchTiers.js';
import { runMatchingForCard } from '../../src/domain/matcher.js';

const STUB_KEY = 'not-a-real-key-0000';

const cfgWith = (over: Partial<Config> = {}): Config =>
  ({
    envName: 'dev',
    jevSecretArn: 'arn:aws:secretsmanager:us-east-1:1:secret:osb/dev/jev',
    jevEndpoint: JEV_ENDPOINT,
    jevModel: JEV_MODEL,
    jevMatching: true,
    quotas: { maxOpenCards: 20 },
    ...over,
  }) as unknown as Config;

async function stubSecret(): Promise<void> {
  const aws = await import('../../src/aws.js');
  vi.spyOn(aws.secretsManager, 'send').mockResolvedValue({
    SecretString: JSON.stringify({ apiKey: STUB_KEY }),
  } as never);
}

/** A Jev answer body with these two nouls. */
const answerBody = (same: number, compatible: number) =>
  JSON.stringify({
    answers: {
      same_kind_of_thing: { type: 'noul', noul: same },
      compatible: { type: 'noul', noul: compatible },
      same_specific_item: { type: 'noul', noul: 0.5 },
      fit: { type: 'score', score: 2, legend: 'Probably what is wanted', probabilities: {}, confidence: 0.8 },
    },
  });

const ok = (same: number, compatible: number): JevResult => ({
  ok: true,
  latencyMs: 5,
  answers: {
    same_kind_of_thing: { type: 'noul', noul: same },
    compatible: { type: 'noul', noul: compatible },
  },
});

beforeEach(() => resetJevForTests());
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetJevForTests();
});

// ---------------------------------------------------------------------------
describe('the JEV_MATCHING flag', () => {
  it('is on in dev and off in prod by default, and either can be set', () => {
    expect(jevMatchingFrom(undefined, 'dev')).toBe(true);
    expect(jevMatchingFrom('', 'dev')).toBe(true);
    expect(jevMatchingFrom(undefined, 'prod')).toBe(false);
    expect(jevMatchingFrom('', 'prod')).toBe(false);
    expect(jevMatchingFrom('on', 'prod')).toBe(true);
    expect(jevMatchingFrom(' ON ', 'prod')).toBe(true);
    expect(jevMatchingFrom('off', 'dev')).toBe(false);
  });

  it('fails boot on anything else', () => {
    for (const v of ['maybe', 'true', '1', 'yes']) {
      expect(() => jevMatchingFrom(v, 'dev'), v).toThrow(/JEV_MATCHING/);
    }
  });
});

// ---------------------------------------------------------------------------
describe('prod: the judge only, and only when switched on', () => {
  it('by default prod never calls out, for the judge or the shadow', async () => {
    await stubSecret();
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    initJev(cfgWith({ envName: 'prod', jevMatching: jevMatchingFrom(undefined, 'prod') }));
    expect(jevMatchingEnabled()).toBe(false);
    expect(jevEnabled()).toBe(false);
    const r = await askJevForMatching({}, { q: { type: 'noul', instructions: 'y' } }, { timeoutMs: 100 });
    expect(r).toEqual({ ok: false, reason: 'disabled' });
    expect(await judgeWithJev([req('a', 0.9)])).toEqual(new Map());
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('switched on in prod, the judge may call out and the shadow still may not', async () => {
    await stubSecret();
    const fetchSpy = vi.fn(async () => new Response(answerBody(0.9, 0.9)));
    vi.stubGlobal('fetch', fetchSpy);
    const said: string[] = [];
    initJev(cfgWith({ envName: 'prod', jevMatching: true }), (m) => void said.push(m));
    expect(jevMatchingEnabled()).toBe(true);
    expect(jevEnabled()).toBe(false);
    expect(said.join(' ')).toContain('jev matching is on');
    expect(await askJev({}, { q: { type: 'noul', instructions: 'y' } })).toEqual({ ok: false, reason: 'prod' });
    expect(fetchSpy).not.toHaveBeenCalled();
    const verdicts = await judgeWithJev([req('a', 0.9)]);
    expect(verdicts.get('a')?.tier).toBe('sure');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('on with no secret configured is the rules, said at boot', () => {
    const said: string[] = [];
    initJev(cfgWith({ jevSecretArn: undefined }), (m) => void said.push(m));
    expect(jevMatchingEnabled()).toBe(false);
    expect(said.join(' ')).toContain('JEV_SECRET_ARN is not set: the rules judge every pair');
  });
});

// ---------------------------------------------------------------------------
const SPRING_WANT = { kind: 'sim racing brake spring', attributes: { brand: 'fanatec', model: 'csl elite' } };
const SPRING_HAVE = { kind: 'upgraded Fanatec pedal spring', attributes: { brand: 'fanatec', model: 'csl elite' } };

describe('the thresholds', () => {
  it('SURE at same kind >= 0.7 and compatible >= 0.7', () => {
    expect(jevTier({ same_kind: 0.7, compatible: 0.7 }, SPRING_WANT, SPRING_HAVE)).toBe('sure');
    expect(jevTier({ same_kind: 0.95, compatible: 0.99 }, SPRING_WANT, SPRING_HAVE)).toBe('sure');
  });

  it('POSSIBLE at same kind >= 0.3 and compatible over 0.3', () => {
    expect(jevTier({ same_kind: 0.9, compatible: 0.69 }, SPRING_WANT, SPRING_HAVE)).toBe('possible');
    expect(jevTier({ same_kind: 0.9, compatible: 0.31 }, SPRING_WANT, SPRING_HAVE)).toBe('possible');
  });

  it("Jev's own NOTHING otherwise (before the near-miss floor)", () => {
    expect(jevTier({ same_kind: 0.9, compatible: 0.3 }, SPRING_WANT, SPRING_HAVE)).toBe('nothing');
    expect(jevTier({ same_kind: 0.69, compatible: 0.99 }, SPRING_WANT, SPRING_HAVE)).toBe('possible');
    expect(jevTier({ same_kind: 0.3, compatible: 0.99 }, SPRING_WANT, SPRING_HAVE)).toBe('possible');
    expect(jevTier({ same_kind: 0.29, compatible: 0.99 }, SPRING_WANT, SPRING_HAVE)).toBe('nothing');
    expect(jevTier({ same_kind: 0.1, compatible: 0.1 }, SPRING_WANT, SPRING_HAVE)).toBe('nothing');
  });

  it('THE PARTS GUARD: a part the want never says it fits is POSSIBLE at most', () => {
    const want = { kind: 'Gaggia steam wand', attributes: { brand: 'Gaggia' } };
    const have = { kind: 'steam wand for Gaggia Classic Pro', attributes: { brand: 'Gaggia', fits: 'Classic Pro' } };
    expect(partsGuardAllowsSure(want, have)).toBe(false);
    expect(jevTier({ same_kind: 0.95, compatible: 0.95 }, want, have)).toBe('possible');
    // The want that says what it fits can be SURE.
    const saysFits = { ...want, attributes: { brand: 'Gaggia', fits: 'Classic Pro' } };
    expect(partsGuardAllowsSure(saysFits, have)).toBe(true);
    expect(jevTier({ same_kind: 0.95, compatible: 0.95 }, saysFits, have)).toBe('sure');
    // "for" in the want's own words is it saying what it fits.
    expect(jevTier({ same_kind: 0.95, compatible: 0.95 }, { kind: 'steam wand for Gaggia Classic' }, have)).toBe('sure');
  });
});

// ---------------------------------------------------------------------------
describe('THE NEAR-MISS FLOOR: a Jev NOTHING on a rules near miss or above, where Jev says same kind >= 0.5', () => {
  it('the bar is 0.5', () => {
    expect(JEV_NEAR_MISS_SAME_KIND_MIN).toBe(0.5);
  });

  it('a Jev NOTHING on a rules SURE, POSSIBLE or NEAR-MISS is a near miss at same kind >= the bar', () => {
    for (const rules of ['sure', 'possible', 'near-miss'] as const) {
      expect(flooredTier('nothing', rules, JEV_NEAR_MISS_SAME_KIND_MIN), rules).toBe('near-miss');
      expect(flooredTier('nothing', rules, 0.9), rules).toBe('near-miss');
    }
  });

  it("below the bar Jev's NOTHING stands: a different kind of thing", () => {
    for (const rules of ['sure', 'possible', 'near-miss'] as const) {
      expect(flooredTier('nothing', rules, JEV_NEAR_MISS_SAME_KIND_MIN - 0.01), rules).toBe('nothing');
    }
  });

  it('never higher than Jev said, and never on a rules NOTHING', () => {
    expect(flooredTier('sure', 'near-miss', 0.9)).toBe('sure');
    expect(flooredTier('possible', 'sure', 0.4)).toBe('possible');
    expect(flooredTier('sure', 'possible', 0.9)).toBe('sure');
    expect(flooredTier('nothing', 'nothing', 0.9)).toBe('nothing');
  });

  it('same kind high with compatible low is a near miss, not nothing (the ladder)', async () => {
    // A borrow want against a lend have with a stated size that conflicts.
    const ask = vi.fn(async () => ok(0.72, 0.28));
    const out = await judgeWithJev([req('ladder', 0.6, { rulesTier: 'near-miss' })], () => {}, { ask, enabled: true });
    expect(out.get('ladder')).toMatchObject({ tier: 'near-miss', jevTier: 'nothing', floored: true });
  });

  it('same kind low on a rules SURE stays nothing (a part against the whole)', async () => {
    const ask = vi.fn(async () => ok(0.14, 0.5));
    const out = await judgeWithJev([req('kit', 0.9, { rulesTier: 'sure' })], () => {}, { ask, enabled: true });
    expect(out.get('kit')).toMatchObject({ tier: 'nothing', jevTier: 'nothing', floored: false });
  });

  it('an answer Jev lifts is not marked floored', async () => {
    const ask = vi.fn(async () => ok(0.9, 0.9));
    const out = await judgeWithJev([req('a', 0.9, { rulesTier: 'possible' })], () => {}, { ask, enabled: true });
    expect(out.get('a')).toMatchObject({ tier: 'sure', jevTier: 'sure', floored: false });
  });
});

// ---------------------------------------------------------------------------
describe('which rules tiers are put to Jev', () => {
  const base = {
    semantic: 0.85,
    categoryA: 'goods.electronics.console.sim-racing',
    categoryB: 'goods.electronics.console.sim-racing',
    geoA: { bucket: 'AU-ACT', reach: 'country' } as any,
    geoB: { bucket: 'AU-ACT', reach: 'country' } as any,
    a: { kind: 'brake spring for Fanatec pedals', attributes: { brand: 'fanatec', model: 'csl elite' } },
    b: { kind: 'Fanatec CSL Elite brake spring', attributes: { brand: 'fanatec', model: 'csl elite pedals' } },
  };

  it('a SURE on closeness of meaning, a POSSIBLE and a NEAR MISS are; NOTHING and a covered SURE are not', () => {
    const sureClose = tierFor(base);
    expect(sureClose.parts.rule).toBe('sure-close');
    expect(jevJudgesTier(sureClose)).toBe(true);

    const possible = tierFor({ ...base, b: { kind: 'Thrustmaster brake spring', attributes: { brand: 'thrustmaster' } } });
    expect(possible.tier).toBe('possible');
    expect(jevJudgesTier(possible)).toBe(true);

    const covered = tierFor({
      semantic: 0.45,
      categoryA: 'goods.bicycle.road',
      categoryB: 'goods.bicycle.road',
      geoA: base.geoA,
      geoB: base.geoB,
      a: { kind: 'used road bike', attributes: { frame_size: '56cm', pedals: 'flat' } },
      b: { kind: 'Giant Contend 2 road bike', attributes: { brand: 'Giant', model: 'Contend 2', frame_size: '56cm' } },
      wantIs: 'a',
    });
    expect(covered.parts.rule).toBe('sure-covered');
    expect(jevJudgesTier(covered)).toBe(false);

    const nothing = tierFor({ ...base, semantic: 0.1, categoryB: 'goods.furniture', b: { kind: 'oak dining table' } });
    expect(nothing.tier).toBe('nothing');
    expect(jevJudgesTier(nothing)).toBe(false);

    const nearMiss = { tier: 'near-miss' as const, parts: { ...nothing.parts, hardRulesPass: true, rule: 'near-miss' as const } };
    expect(jevJudgesTier(nearMiss)).toBe(true);
    const hardRule = { tier: 'nothing' as const, parts: { ...nothing.parts, hardRulesPass: false, rule: 'hard-rule' as const } };
    expect(jevJudgesTier(hardRule)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
function req(key: string, score: number, over: Partial<JudgeRequest> = {}): JudgeRequest {
  return {
    key,
    score,
    rulesTier: 'sure',
    want: { id: `w-${key}`, category: 'goods.electronics.console.sim-racing', ...SPRING_WANT },
    have: { id: `h-${key}`, category: 'goods.electronics.console.sim-racing', ...SPRING_HAVE },
    ...over,
  };
}

describe('asking', () => {
  it('asks nothing when switched off', async () => {
    const ask = vi.fn(async () => ok(0.9, 0.9));
    const out = await judgeWithJev([req('a', 0.9)], () => {}, { ask, enabled: false });
    expect(out.size).toBe(0);
    expect(ask).not.toHaveBeenCalled();
  });

  it('asks about the top N by fit only, and all at once', async () => {
    let inFlight = 0;
    let most = 0;
    const ask = vi.fn(async () => {
      inFlight++;
      most = Math.max(most, inFlight);
      await new Promise((r) => setTimeout(r, 30));
      inFlight--;
      return ok(0.9, 0.9);
    });
    const reqs = Array.from({ length: 8 }, (_, i) => req(`k${i}`, i / 10));
    const out = await judgeWithJev(reqs, () => {}, { ask, enabled: true });
    expect(ask).toHaveBeenCalledTimes(JEV_JUDGE_TOP_N);
    expect(most).toBe(JEV_JUDGE_TOP_N);
    expect([...out.keys()].sort()).toEqual(['k3', 'k4', 'k5', 'k6', 'k7']);
  });

  it('leaves the rules to decide on a timeout, an error, a throw or a half answer', async () => {
    const log = vi.fn();
    const ask = vi.fn(async (state: any) => {
      const k = state.want.kind;
      if (k === 'slow') return new Promise<JevResult>(() => {});
      if (k === 'error') return { ok: false, reason: 'http-500' } as JevResult;
      if (k === 'throw') throw new Error('boom');
      if (k === 'half') return { ok: true, latencyMs: 1, answers: { compatible: { type: 'noul', noul: 0.9 } } } as JevResult;
      return ok(0.9, 0.9);
    });
    const mk = (key: string) =>
      req(key, 0.5, { want: { id: `w-${key}`, category: 'goods', kind: key } });
    const started = Date.now();
    const out = await judgeWithJev([mk('slow'), mk('error'), mk('throw'), mk('half'), mk('fine')], log, {
      ask,
      enabled: true,
      timeoutMs: 50,
    });
    expect(Date.now() - started).toBeLessThan(1000);
    expect([...out.keys()]).toEqual(['fine']);
    expect(log).toHaveBeenCalledWith('matcher: jev gave no answer, the rules decide', expect.objectContaining({ reason: 'timeout' }));
    expect(log).toHaveBeenCalledWith('matcher: jev gave no answer, the rules decide', expect.objectContaining({ reason: 'http-500' }));
    expect(log).toHaveBeenCalledWith('matcher: jev judge failed, the rules decide', expect.anything());
    expect(log).toHaveBeenCalledWith('matcher: jev answer incomplete, the rules decide', expect.anything());
    // Never a posting's words in a log line.
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/fanatec|spring/i);
  });

  it('the timeout on each call is at most two seconds', () => {
    expect(JEV_JUDGE_TIMEOUT_MS).toBeLessThanOrEqual(2000);
  });
});

// ---------------------------------------------------------------------------
describe('what is sent', () => {
  it('the pair state and nothing else: no ids, prices, places, names or contact details', async () => {
    const sent: any[] = [];
    const ask = vi.fn(async (state: unknown) => {
      sent.push(state);
      return ok(0.9, 0.9);
    });
    await judgeWithJev(
      [
        req('a', 0.9, {
          want: {
            id: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
            category: 'goods.bicycle.road',
            kind: 'road bike up to $400, call 0412 345 678',
            also_called: ['racer'],
            not_these: ['mountain bike'],
            attributes: {
              frame_size: '56cm',
              budget: '400',
              max_price: 400,
              suburb: 'Braddon',
              owner_name: 'Tony',
              contact_email: 'tony@example.com',
              note: 'pick up from 12 Smith Street',
            },
          },
          have: {
            id: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',
            category: 'goods.bicycle.road',
            kind: 'Giant Contend 2',
            attributes: { brand: 'Giant', asking_price: '$300', location: 'Canberra', year: 2019 },
          },
        }),
      ],
      () => {},
      { ask, enabled: true },
    );
    expect(sent).toHaveLength(1);
    const s = sent[0];
    expect(Object.keys(s).sort()).toEqual(['have', 'want']);
    for (const side of [s.want, s.have]) {
      expect(Object.keys(side).sort()).toEqual(['attributes', 'category_label', 'kind']);
    }
    expect(s.want.attributes).toEqual({ frame_size: '56cm', note: 'pick up from [removed]' });
    expect(s.have.attributes).toEqual({ brand: 'Giant', year: 2019 });
    const json = JSON.stringify(s);
    for (const forbidden of [
      'aaaaaaaa', 'bbbbbbbb', '400', '300', '$', '0412', 'Braddon', 'Tony', 'example.com', 'Smith',
      'Canberra', 'racer', 'mountain bike', 'budget', 'price',
    ]) {
      expect(json, forbidden).not.toContain(forbidden);
    }
  });
});

// ---------------------------------------------------------------------------
// In the matcher.
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
const found = (over: Record<string, unknown> = {}) =>
  card({
    id: FOUND,
    account_id: BEPPE,
    type: 'HAVE',
    category: 'goods.motoring.parts',
    kind: 'upgraded Fanatec pedal spring',
    attributes: { brand: 'fanatec', model: 'csl elite' },
    similarity: 0.86,
    ...over,
  });

let inserted: any[][];
let gated: any[];
function boardPool() {
  return {
    query: async (sql: string, params: any[] = []) => {
      const rows = (r: any[]) => ({ rows: r, rowCount: r.length });
      if (/c\.embedding::text AS embedding_text/.test(sql)) return rows([card({})]);
      if (/\$15::uuid\[\]/.test(sql)) return rows([]);
      if (/LIMIT 50/.test(sql)) return rows(gated);
      if (/SELECT count\(\*\)::int AS n FROM \(/.test(sql)) return rows([{ n: gated.length }]);
      if (/certainty = 'possible' AND created_at/.test(sql)) return rows([{ a: 0, b: 0 }]);
      if (/INSERT INTO matches/.test(sql)) {
        inserted.push(params);
        return rows([{ id: `m-${inserted.length}` }]);
      }
      return rows([]);
    },
  } as any;
}

describe('in the matcher', () => {
  const log = vi.fn();
  // Columns: certainty is $10, judged_by is $12.
  const CERTAINTY = 9;
  const JUDGED_BY = 11;

  beforeEach(async () => {
    inserted = [];
    gated = [found()];
    log.mockReset();
    vi.spyOn(db, 'getPool').mockReturnValue(boardPool());
    await stubSecret();
  });

  it('FLAG OFF: the rules alone, exactly as before, and Jev is never asked', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    // No Jev at all: today's behaviour.
    const baseline = (await runMatchingForCard(cfgWith(), SOURCE, log))!;
    const before = inserted;
    inserted = [];
    initJev(cfgWith({ jevMatching: false, jevSecretArn: undefined }));
    const off = (await runMatchingForCard(cfgWith(), SOURCE, log))!;
    expect(off).toEqual(baseline);
    expect(inserted).toEqual(before);
    expect(inserted[0][CERTAINTY]).toBe('sure');
    expect(inserted[0][JUDGED_BY]).toBe('rules');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalledWith('matcher: jev judged a pair', expect.anything());
  });

  it('FLAG ON: Jev saying it is a different kind of thing turns a rules SURE into nothing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(answerBody(0.2, 0.2))));
    initJev(cfgWith({ jevMatching: true }));
    const out = (await runMatchingForCard(cfgWith(), SOURCE, log))!;
    expect(out.matchesCreated).toHaveLength(0);
    expect(out.nearMisses).toBe(0);
    expect(log).toHaveBeenCalledWith(
      'matcher: jev judged a pair',
      expect.objectContaining({ rules_tier: 'sure', jev_tier: 'nothing', tier: 'nothing', floored: false }),
    );
  });

  it('FLAG ON: same kind with a stated conflict (compatible low) is a near miss', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(answerBody(0.72, 0.28))));
    initJev(cfgWith({ jevMatching: true }));
    const out = (await runMatchingForCard(cfgWith(), SOURCE, log))!;
    expect(out.matchesCreated).toHaveLength(0);
    expect(out.nearMisses).toBe(1);
  });

  it('FLAG ON: Jev turns a rules POSSIBLE into SURE, and the row says Jev decided', async () => {
    gated = [found({ kind: 'ClubSport pedal spring kit', attributes: {}, similarity: 0.85 })];
    vi.spyOn(db, 'getPool').mockReturnValue({
      query: async (sql: string, params: any[] = []) =>
        /c\.embedding::text AS embedding_text/.test(sql)
          ? { rows: [card({ kind: 'fanatec spring', attributes: {} })], rowCount: 1 }
          : boardPool().query(sql, params),
    } as any);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(answerBody(0.9, 0.8))));
    initJev(cfgWith({ jevMatching: true }));
    const out = (await runMatchingForCard(cfgWith(), SOURCE, log))!;
    expect(out.matchesCreated).toHaveLength(1);
    expect(out.possibles).toHaveLength(0);
    expect(inserted[0][CERTAINTY]).toBe('sure');
    expect(inserted[0][JUDGED_BY]).toBe('jev');
    expect(log).toHaveBeenCalledWith(
      'matcher: jev judged a pair',
      expect.objectContaining({ rules_tier: 'possible', jev_tier: 'sure' }),
    );
    expect(log).toHaveBeenCalledWith('matcher: match created', expect.objectContaining({ judged_by: 'jev', certainty: 'sure' }));
  });

  it('FLAG ON, Jev compatible but not sure: POSSIBLE', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(answerBody(0.9, 0.5))));
    initJev(cfgWith({ jevMatching: true }));
    const out = (await runMatchingForCard(cfgWith(), SOURCE, log))!;
    expect(out.possibles).toHaveLength(1);
    expect(inserted[0][CERTAINTY]).toBe('possible');
    expect(inserted[0][JUDGED_BY]).toBe('jev');
  });

  it('FLAG ON, Jev errors: the rules tier stands', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    initJev(cfgWith({ jevMatching: true }));
    const out = (await runMatchingForCard(cfgWith(), SOURCE, log))!;
    expect(out.matchesCreated).toHaveLength(1);
    expect(inserted[0][CERTAINTY]).toBe('sure');
    expect(inserted[0][JUDGED_BY]).toBe('rules');
  });

  it(
    'FLAG ON, Jev hangs: the rules tier stands, and the run waits one timeout at most',
    async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(
          (_url: string, init: any) =>
            new Promise((_, reject) =>
              init.signal.addEventListener('abort', () =>
                reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
              ),
            ),
        ),
      );
      initJev(cfgWith({ jevMatching: true }));
      const started = Date.now();
      const out = (await runMatchingForCard(cfgWith(), SOURCE, log))!;
      expect(Date.now() - started).toBeLessThan(JEV_JUDGE_TIMEOUT_MS + 1000);
      expect(out.matchesCreated).toHaveLength(1);
      expect(inserted[0][CERTAINTY]).toBe('sure');
      expect(inserted[0][JUDGED_BY]).toBe('rules');
      expect(log).toHaveBeenCalledWith(
        'matcher: jev gave no answer, the rules decide',
        expect.objectContaining({ reason: 'timeout' }),
      );
    },
    10_000,
  );
});
