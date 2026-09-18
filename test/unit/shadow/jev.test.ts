/**
 * THE SHADOW, AND THE FOUR PROMISES IT MAKES.
 * (src/shadow/jev.ts, src/shadow/jevTrials.ts, docs/jev-shadow.md.)
 *
 * What is asserted here:
 *
 *  - IT IS OFF UNLESS SOMEBODY SWITCHED IT ON, and it is off in prod even
 *    when somebody did. Two separate tests, because these are two separate
 *    failures and the second one is the one that would matter.
 *  - THE THREE ANSWER SHAPES ARE READ AS THE API DOCUMENTS THEM, and anything
 *    that is not one of them is dropped rather than stored half-understood.
 *  - IT NEVER THROWS. A timeout, a 429, a 401, a dead socket, a body that will
 *    not parse: every one of them is a value, because a shadow that can fail a
 *    screening worker or a matching run is worse than no shadow at all.
 *  - NOTHING PRIVATE LEAVES. The state builders are asserted on their EXACT
 *    key sets, not on the absence of a few names, because "we only send a bit
 *    of it" has to be checkable rather than promised. No price, no geography,
 *    no account, no id, no free text beyond the poster's own word for the
 *    thing and the facts they stated.
 *
 * No network, and no key: the secret is a stub string this file invents, and
 * the only assertion about it is that it goes in the Authorization header and
 * nowhere else.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  JEV_ENDPOINT,
  JEV_MODEL,
  JEV_RETRY_STATUSES,
  JEV_TIMEOUT_MS,
  askJev,
  initJev,
  jevEnabled,
  readJevAnswers,
  resetJevForTests,
} from '../../../src/shadow/jev.js';
import {
  JEV_CANDIDATE_LIMIT,
  JEV_CHOICE_DECIDED_MIN_P,
  JEV_FIT_LEVELS,
  JEV_MAX_OPTIONS,
  JEV_NONE_OPTION,
  JEV_NOUL_NO,
  JEV_NOUL_YES,
  JEV_PAIR_LIMIT,
  JEV_PAIR_MIN_SCORE,
  jevCategoryQuestion,
  jevCategoryState,
  jevPairQuestions,
  jevPairState,
  noulBand,
  shadowCategoryTrial,
  shadowPairTrials,
  topProbability,
} from '../../../src/shadow/jevTrials.js';
import type { Config } from '../../../src/config.js';

const STUB_KEY = 'not-a-real-key-0000';

const cfgWith = (over: Partial<Config> = {}): Config =>
  ({
    envName: 'dev',
    jevSecretArn: 'arn:aws:secretsmanager:us-east-1:1:secret:osb/dev/jev',
    jevEndpoint: JEV_ENDPOINT,
    jevModel: JEV_MODEL,
    ...over,
  }) as unknown as Config;

/** The secret, stubbed. Nothing in this file reads a real one. */
async function stubSecret(): Promise<void> {
  const aws = await import('../../../src/aws.js');
  vi.spyOn(aws.secretsManager, 'send').mockResolvedValue({
    SecretString: JSON.stringify({ apiKey: STUB_KEY }),
  } as never);
}

/** A card with far more on it than the shadow is allowed to send. */
const fullCard = {
  id: '11111111-1111-1111-1111-111111111111',
  account_id: '22222222-2222-2222-2222-222222222222',
  type: 'WANT' as const,
  kind: 'road bike, 56cm',
  category: 'goods.bicycle.road',
  category_as_posted: 'goods.bikes.roadracing',
  attributes: { size: '56cm', condition: 'used', frame: 'aluminium', speeds: 22 },
  geo: { bucket: 'r3gh', country: 'AU' },
  geo_lat: -35.28,
  geo_lon: 149.13,
  geo_radius_km: 25,
  geo_country: 'AU',
  price_enc: Buffer.from('nope'),
  ask: { amount_minor: 40000, currency: 'AUD' },
  urgency: 'soon',
  expires_at: new Date(),
};

beforeEach(() => {
  resetJevForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetJevForTests();
});

// ---------------------------------------------------------------------------

describe('whether it is on at all', () => {
  it('is off when no secret ARN is configured', () => {
    const said: string[] = [];
    initJev(cfgWith({ jevSecretArn: undefined }), (m) => void said.push(m));
    expect(jevEnabled()).toBe(false);
    expect(said[0]).toContain('off for this deployment');
    expect(said[0]).toContain('JEV_SECRET_ARN');
  });

  it('is on for dev with an ARN, and says the answers change nothing', () => {
    const said: string[] = [];
    initJev(cfgWith(), (m) => void said.push(m));
    expect(jevEnabled()).toBe(true);
    expect(said[0]).toContain('change nothing');
  });

  it('REFUSES IN PROD even with an ARN, and says why', () => {
    const said: string[] = [];
    initJev(cfgWith({ envName: 'prod' }), (m) => void said.push(m));
    expect(jevEnabled()).toBe(false);
    expect(said.join(' ')).toContain('refuses to start in prod');
  });

  it('is off in prod with no ARN, quietly: there is nothing to report', () => {
    const said: string[] = [];
    initJev(cfgWith({ envName: 'prod', jevSecretArn: undefined }), (m) => void said.push(m));
    expect(jevEnabled()).toBe(false);
    expect(said).toHaveLength(0);
  });

  it('will not call out when it is off, whatever a caller passes', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    initJev(cfgWith({ jevSecretArn: undefined }));
    const r = await askJev({ kind: 'thing' }, { q: { type: 'noul', instructions: 'x' } });
    expect(r).toEqual({ ok: false, reason: 'disabled' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('will not call out in prod, which is the belt to the brace above', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    initJev(cfgWith({ envName: 'prod' }));
    const r = await askJev({ kind: 'thing' }, { q: { type: 'noul', instructions: 'x' } });
    expect(r).toEqual({ ok: false, reason: 'prod' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

describe('what goes on the wire', () => {
  beforeEach(async () => {
    await stubSecret();
    initJev(cfgWith());
  });

  it('is the documented endpoint, bearer key, model and questions', async () => {
    let seen: { url: string; init: any } | undefined;
    vi.stubGlobal('fetch', async (url: string, init: any) => {
      seen = { url: String(url), init };
      return { ok: true, status: 200, json: async () => ({ answers: {} }) } as any;
    });
    await askJev({ kind: 'a bike' }, { fit: { type: 'noul', instructions: 'is it?' } });

    expect(seen!.url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(seen!.init.method).toBe('POST');
    expect(seen!.init.headers.Authorization).toBe(`Bearer ${STUB_KEY}`);
    expect(seen!.init.headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(seen!.init.body);
    expect(body.model).toBe('jev-latest');
    // A JSON OBJECT, not a string: the API takes either and an object is the
    // one the model reads as structure rather than as prose.
    expect(typeof body.state).toBe('object');
    expect(body.questions.fit).toEqual({ type: 'noul', instructions: 'is it?' });
    // No `uid`. Their throwaway field is for independent repeat sampling in
    // their own experiments; we want the same posting to get the same answer.
    expect(body).not.toHaveProperty('uid');
    expect(body.questions.fit).not.toHaveProperty('uid');
    // Every call is on a leash.
    expect(seen!.init.signal).toBeTruthy();
    expect(JEV_TIMEOUT_MS).toBe(4_000);
  });

  it('says so and calls nobody when handed no questions', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    expect(await askJev({ kind: 'x' }, {})).toEqual({ ok: false, reason: 'no-questions' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

describe('the three answer shapes', () => {
  it('reads a choice, with its probabilities and confidence', () => {
    const a = readJevAnswers({
      answers: {
        category: {
          type: 'choice',
          choice: 'goods.bicycle.road',
          probabilities: { 'goods.bicycle.road': 0.82, 'goods.bicycle.gravel': 0.18 },
          confidence: 0.77,
        },
      },
    });
    expect(a.category).toEqual({
      type: 'choice',
      choice: 'goods.bicycle.road',
      probabilities: { 'goods.bicycle.road': 0.82, 'goods.bicycle.gravel': 0.18 },
      confidence: 0.77,
    });
  });

  it('reads a noul', () => {
    const a = readJevAnswers({ answers: { compatible: { type: 'noul', noul: 0.91 } } });
    expect(a.compatible).toEqual({ type: 'noul', noul: 0.91 });
  });

  it('reads a score, which is the one shape with no type field', () => {
    const a = readJevAnswers({
      answers: {
        fit: {
          score: 3,
          legend: 'Probably what is wanted',
          probabilities: { '3': 0.6, '4': 0.4 },
          confidence: 0.6,
        },
      },
    });
    expect(a.fit).toEqual({
      type: 'score',
      score: 3,
      legend: 'Probably what is wanted',
      probabilities: { '3': 0.6, '4': 0.4 },
      confidence: 0.6,
    });
  });

  it('drops anything it does not recognise rather than storing half of it', () => {
    expect(readJevAnswers({ answers: { q: { type: 'vibes', mood: 'good' } } })).toEqual({});
    expect(readJevAnswers({ answers: { q: { type: 'choice' } } })).toEqual({});
    expect(readJevAnswers(null)).toEqual({});
    expect(readJevAnswers('a string')).toEqual({});
  });

  it('keeps only numeric probabilities', () => {
    const a = readJevAnswers({
      answers: {
        c: { type: 'choice', choice: 'x', probabilities: { x: 0.5, y: 'lots' }, confidence: 1 },
      },
    });
    expect((a.c as any).probabilities).toEqual({ x: 0.5 });
  });

  it('carries the usage and a latency back with a good answer', async () => {
    await stubSecret();
    initJev(cfgWith());
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        answers: { q: { type: 'noul', noul: 0.4 } },
        usage: { input_tokens: 120, output_tokens: 8 },
      }),
    }));
    const r = await askJev({ kind: 'x' }, { q: { type: 'noul', instructions: 'y' } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.usage).toEqual({ input_tokens: 120, output_tokens: 8 });
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('calls a body it cannot read unreadable rather than inventing an answer', async () => {
    await stubSecret();
    initJev(cfgWith());
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      json: async () => ({ something: 'else' }),
    }));
    expect(await askJev({ kind: 'x' }, { q: { type: 'noul', instructions: 'y' } })).toEqual({
      ok: false,
      reason: 'unreadable',
    });
  });
});

// ---------------------------------------------------------------------------

describe('nothing gets out through a failure', () => {
  beforeEach(async () => {
    await stubSecret();
    initJev(cfgWith());
  });

  it('gives up on a timeout and says timeout', async () => {
    vi.stubGlobal('fetch', (_url: string, init: any) =>
      new Promise((_res, rej) => {
        init.signal.addEventListener('abort', () => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          rej(e);
        });
      }),
    );
    const r = await askJev({ kind: 'x' }, { q: { type: 'noul', instructions: 'y' } }, {
      timeoutMs: 5,
    });
    expect(r).toEqual({ ok: false, reason: 'timeout' });
  });

  for (const status of JEV_RETRY_STATUSES) {
    it(`retries once on ${status} and gives the status back if it happens again`, async () => {
      const calls: number[] = [];
      vi.stubGlobal('fetch', async () => {
        calls.push(1);
        return { ok: false, status } as any;
      });
      const r = await askJev({ kind: 'x' }, { q: { type: 'noul', instructions: 'y' } });
      expect(r).toEqual({ ok: false, reason: `http-${status}` });
      expect(calls).toHaveLength(2);
    });

    it(`takes the answer when the retry after ${status} succeeds`, async () => {
      let n = 0;
      vi.stubGlobal('fetch', async () => {
        n++;
        if (n === 1) return { ok: false, status } as any;
        return {
          ok: true,
          status: 200,
          json: async () => ({ answers: { q: { type: 'noul', noul: 0.9 } } }),
        } as any;
      });
      const r = await askJev({ kind: 'x' }, { q: { type: 'noul', instructions: 'y' } });
      expect(r.ok).toBe(true);
    });
  }

  it('does NOT retry a 401 — a bad key will be bad again in four hundred ms', async () => {
    const calls: number[] = [];
    vi.stubGlobal('fetch', async () => {
      calls.push(1);
      return { ok: false, status: 401 } as any;
    });
    expect(await askJev({ kind: 'x' }, { q: { type: 'noul', instructions: 'y' } })).toEqual({
      ok: false,
      reason: 'http-401',
    });
    expect(calls).toHaveLength(1);
  });

  it('does not retry a 422 either', async () => {
    const calls: number[] = [];
    vi.stubGlobal('fetch', async () => {
      calls.push(1);
      return { ok: false, status: 422 } as any;
    });
    expect(await askJev({ kind: 'x' }, { q: { type: 'noul', instructions: 'y' } })).toEqual({
      ok: false,
      reason: 'http-422',
    });
    expect(calls).toHaveLength(1);
  });

  it('survives a dead socket', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('fetch failed');
    });
    expect(await askJev({ kind: 'x' }, { q: { type: 'noul', instructions: 'y' } })).toEqual({
      ok: false,
      reason: 'network',
    });
  });

  it('survives a secret that is not the shape it expects, without saying what it saw', async () => {
    const aws = await import('../../../src/aws.js');
    vi.spyOn(aws.secretsManager, 'send').mockResolvedValue({
      SecretString: JSON.stringify({ wrong_field: 'x' }),
    } as never);
    resetJevForTests();
    initJev(cfgWith());
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const r = await askJev({ kind: 'x' }, { q: { type: 'noul', instructions: 'y' } });
    expect(r).toEqual({ ok: false, reason: 'no-key' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

describe('what the state builders are allowed to send', () => {
  it('trial A sends the poster’s words and their stated facts, and NOTHING else', () => {
    const state = jevCategoryState(fullCard);
    // The exact key set. Not "does not contain price" — the whole list, so a
    // field added to a card later cannot quietly join the request.
    expect(Object.keys(state).sort()).toEqual(['attributes', 'kind']);
    const json = JSON.stringify(state);
    for (const forbidden of [
      'account_id',
      '2222',
      'geo',
      'bucket',
      'r3gh',
      '149.13',
      'price',
      'ask',
      'amount_minor',
      '40000',
      'urgency',
      'expires',
      '1111',
    ]) {
      expect(json).not.toContain(forbidden);
    }
  });

  it('trial B sends two sides of three fields each, and NOTHING else', () => {
    const state = jevPairState(fullCard, { ...fullCard, kind: 'road bike' });
    expect(Object.keys(state).sort()).toEqual(['have', 'want']);
    for (const side of [state.want, state.have]) {
      expect(Object.keys(side).sort()).toEqual(['attributes', 'category_label', 'kind']);
    }
    const json = JSON.stringify(state);
    for (const forbidden of ['account_id', '2222', 'r3gh', '149.13', 'amount_minor', 'price']) {
      expect(json).not.toContain(forbidden);
    }
  });

  it('sends the category as words rather than as a database key', () => {
    const state = jevPairState(fullCard, fullCard);
    expect(state.want.category_label).toBe('Secondhand consumer goods > Bicycles > Road bikes');
    expect(state.want.category_label).not.toContain('goods.bicycle');
  });

  it('drops any attribute that is not a plain scalar, where free text could hide', () => {
    const state = jevCategoryState({
      kind: 'bike',
      attributes: {
        size: '56cm',
        seller_note: { text: 'call me on 0400 000 000' },
        photos: ['a', 'b'],
        ok: true,
        n: 3,
      },
    });
    expect(state.attributes).toEqual({ size: '56cm', ok: true, n: 3 });
  });

  it('is happy with a posting that has no words and no attributes', () => {
    expect(jevCategoryState({ category: 'goods.bicycle' } as any)).toEqual({
      kind: null,
      attributes: {},
    });
  });
});

// ---------------------------------------------------------------------------

describe('the category ballot', () => {
  const candidates = (n: number) =>
    [
      'goods.bicycle.mountain',
      'goods.bicycle.gravel',
      'goods.bicycle.hybrid',
      'goods.bicycle.kids',
      'goods.bicycle.electric',
      'goods.bicycle.folding',
      'goods.bicycle.bmx',
      'goods.bicycle.cargo',
    ]
      .slice(0, n)
      .map((id, i) => ({ id, score: 0.9 - i * 0.05 }));

  it('is small: TypeSafe’s tested range is four to six real options', () => {
    expect(JEV_CANDIDATE_LIMIT).toBe(5);
    expect(JEV_MAX_OPTIONS).toBe(7);
  });

  it('always offers a way of saying none of them fits', () => {
    const q = jevCategoryQuestion(candidates(3), 'goods.bicycle.road');
    expect(q.criteria[JEV_NONE_OPTION]).toBe('None of these fits the thing');
  });

  it('includes the node we filed it under and the one the assistant wrote', () => {
    const q = jevCategoryQuestion(candidates(3), 'goods.bicycle.road', 'goods.bicycle.gravel');
    expect(Object.keys(q.criteria)).toContain('goods.bicycle.road');
    expect(Object.keys(q.criteria)).toContain('goods.bicycle.gravel');
  });

  it('caps the real options at seven, with none_of_these outside the count', () => {
    const q = jevCategoryQuestion(candidates(8), 'goods.bicycle.road', 'goods.bicycle.cargo');
    const keys = Object.keys(q.criteria);
    expect(keys.filter((k) => k !== JEV_NONE_OPTION).length).toBeLessThanOrEqual(JEV_MAX_OPTIONS);
    expect(keys).toContain(JEV_NONE_OPTION);
    // The two the trial is about survive the cap; a low-scored candidate does not.
    expect(keys).toContain('goods.bicycle.road');
    expect(keys).toContain('goods.bicycle.cargo');
  });

  it('takes only the highest-scored candidates, whatever order they arrive in', () => {
    const shuffled = [
      { id: 'goods.bicycle.bmx', score: 0.1 },
      { id: 'goods.bicycle.road', score: 0.95 },
      { id: 'goods.bicycle.cargo', score: 0.2 },
      { id: 'goods.bicycle.gravel', score: 0.9 },
      { id: 'goods.bicycle.kids', score: 0.3 },
      { id: 'goods.bicycle.hybrid', score: 0.85 },
      { id: 'goods.bicycle.folding', score: 0.4 },
    ];
    const q = jevCategoryQuestion(shuffled, 'goods.bicycle.road');
    expect(Object.keys(q.criteria)).not.toContain('goods.bicycle.bmx');
    expect(Object.keys(q.criteria)).toContain('goods.bicycle.gravel');
  });

  it('never repeats an option', () => {
    const q = jevCategoryQuestion(
      [
        { id: 'goods.bicycle.road', score: 0.9 },
        { id: 'goods.bicycle.road', score: 0.8 },
        { id: 'goods.bicycle.gravel', score: 0.7 },
      ],
      'goods.bicycle.road',
      'goods.bicycle.road',
    );
    const keys = Object.keys(q.criteria);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('leaves off a path the catalogue has never heard of', () => {
    // An assistant's invented branch has no label path, so its description
    // would be its own slug read back at the model.
    const q = jevCategoryQuestion(candidates(3), 'goods.bicycle.road', 'goods.gaming.sim-racing');
    expect(Object.keys(q.criteria)).not.toContain('goods.gaming.sim-racing');
  });

  it('describes each option in plain words rather than by its key', () => {
    const q = jevCategoryQuestion(candidates(2), 'goods.bicycle.road');
    expect(q.criteria['goods.bicycle.road']).toBe(
      'Secondhand consumer goods > Bicycles > Road bikes',
    );
    expect(q.type).toBe('choice');
  });
});

// ---------------------------------------------------------------------------

describe('the pair rubric and its bands', () => {
  it('asks three nouls and one score in one request', () => {
    const q = jevPairQuestions();
    expect(Object.keys(q).sort()).toEqual([
      'compatible',
      'fit',
      'same_kind_of_thing',
      'same_specific_item',
    ]);
    expect(q.same_kind_of_thing.type).toBe('noul');
    expect(q.compatible.type).toBe('noul');
    expect(q.same_specific_item.type).toBe('noul');
    expect(q.fit.type).toBe('score');
  });

  it('phrases every noul so that yes means the condition holds', () => {
    // A rubric half of whose questions are negations cannot be read through
    // one set of bands, and these bands are one set.
    for (const id of ['same_kind_of_thing', 'compatible', 'same_specific_item'] as const) {
      const instructions = (jevPairQuestions()[id] as any).instructions as string;
      expect(instructions).toMatch(/^Is /);
      expect(instructions.toLowerCase()).not.toMatch(/\bnot\b|\bnever\b|\bunless\b/);
    }
  });

  it('gives the score four ordered levels, worst first', () => {
    expect((jevPairQuestions().fit as any).criteria).toEqual(JEV_FIT_LEVELS);
    expect(JEV_FIT_LEVELS).toHaveLength(4);
    expect(JEV_FIT_LEVELS[0]).toBe('Different things');
    expect(JEV_FIT_LEVELS[3]).toBe('Exactly what is wanted');
  });

  it('uses TypeSafe’s bands: yes over 0.70, no under 0.30, nothing in between', () => {
    expect(JEV_NOUL_YES).toBe(0.7);
    expect(JEV_NOUL_NO).toBe(0.3);
    expect(noulBand(0.95)).toBe('yes');
    expect(noulBand(0.71)).toBe('yes');
    expect(noulBand(0.7)).toBe('uncertain');
    expect(noulBand(0.5)).toBe('uncertain');
    expect(noulBand(0.3)).toBe('uncertain');
    expect(noulBand(0.29)).toBe('no');
    expect(noulBand(0)).toBe('no');
  });

  it('has no band for an answer that never came', () => {
    expect(noulBand(null)).toBeNull();
    expect(noulBand(undefined)).toBeNull();
    expect(noulBand(Number.NaN)).toBeNull();
  });
});

describe('reading a choice through the application policy', () => {
  it('holds TypeSafe’s illustrative threshold, which is not ours yet', () => {
    expect(JEV_CHOICE_DECIDED_MIN_P).toBe(0.6);
  });

  it('takes the top probability off the ballot', () => {
    expect(topProbability({ a: 0.55, b: 0.4, c: 0.05 })).toBe(0.55);
    expect(topProbability({})).toBe(0);
    expect(topProbability({ a: Number.NaN })).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe('migration 047 creates every column the code writes', () => {
  // A column the code writes and the migration never created is a green suite
  // and a broken deployment.
  const sql = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'migrations', '047_jev_shadow.sql'),
    'utf8',
  );

  it('has all eight of them', () => {
    for (const col of [
      'trial',
      'card_id',
      'other_card_id',
      'ours',
      'jev',
      'latency_ms',
      'input_tokens',
      'output_tokens',
    ]) {
      expect(sql).toContain(col);
    }
  });

  it('allows the two trials the code writes and nothing else', () => {
    expect(sql).toContain("CHECK (trial IN ('category', 'pair'))");
  });

  it('holds no account column, which is the point of the table’s comment', () => {
    expect(sql).not.toContain('account_id');
    expect(sql).toContain('safe to truncate');
  });
});

// ---------------------------------------------------------------------------

describe('the hooks swallow everything', () => {
  it('does nothing at all, quietly, when the shadow is off', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    initJev(cfgWith({ jevSecretArn: undefined }));
    await shadowCategoryTrial(cfgWith({ jevSecretArn: undefined }), fullCard);
    await shadowPairTrials([
      { want: fullCard, have: fullCard, score: 0.9, decision: 'match' },
    ]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('swallows a refusal from the API and logs a status word, never the posting', async () => {
    await stubSecret();
    initJev(cfgWith());
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 401 }) as any);
    const lines: { msg: string; extra: any }[] = [];
    await expect(
      shadowCategoryTrial(cfgWith(), fullCard, (msg, extra) => void lines.push({ msg, extra })),
    ).resolves.toBeUndefined();
    expect(lines.some((l) => l.msg.includes('no answer'))).toBe(true);
    const logged = JSON.stringify(lines);
    expect(logged).toContain('http-401');
    // The posting's own words are not a thing to put in a log line.
    expect(logged).not.toContain('road bike, 56cm');
    expect(logged).not.toContain(STUB_KEY);
  });

  it('swallows the database write failing — the verdict is already written', async () => {
    await stubSecret();
    initJev(cfgWith());
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        answers: {
          category: {
            type: 'choice',
            choice: 'goods.bicycle.road',
            probabilities: { 'goods.bicycle.road': 0.9 },
            confidence: 0.9,
          },
        },
      }),
    }));
    const lines: string[] = [];
    // No pool is initialised in a unit run, so recordJevShadow throws inside.
    await expect(
      shadowCategoryTrial(cfgWith(), fullCard, (m) => void lines.push(m)),
    ).resolves.toBeUndefined();
    expect(lines.some((l) => l.includes('failed'))).toBe(true);
  });

  it('swallows everything on the pair side too', async () => {
    await stubSecret();
    initJev(cfgWith());
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('fetch failed');
    });
    await expect(
      shadowPairTrials([{ want: fullCard, have: fullCard, score: 0.9, decision: 'match' }]),
    ).resolves.toBeUndefined();
  });

  it('asks about nothing below the floor, and about at most five above it', async () => {
    await stubSecret();
    initJev(cfgWith());
    const asked: any[] = [];
    vi.stubGlobal('fetch', async (_u: string, init: any) => {
      asked.push(JSON.parse(init.body));
      return {
        ok: true,
        status: 200,
        json: async () => ({ answers: { compatible: { type: 'noul', noul: 0.5 } } }),
      } as any;
    });
    const pairs = Array.from({ length: 12 }, (_, i) => ({
      want: fullCard,
      have: fullCard,
      // The first four sit under the floor and are never asked about.
      score: 0.2 + i * 0.06,
      decision: 'near-miss',
    }));
    await shadowPairTrials(pairs);
    expect(asked.length).toBeLessThanOrEqual(JEV_PAIR_LIMIT);
    expect(pairs.filter((p) => p.score >= JEV_PAIR_MIN_SCORE).length).toBeGreaterThan(
      JEV_PAIR_LIMIT,
    );
  });

  it('stops asking about further pairs once the API has said no', async () => {
    await stubSecret();
    initJev(cfgWith());
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls++;
      return { ok: false, status: 401 } as any;
    });
    await shadowPairTrials(
      Array.from({ length: 5 }, () => ({
        want: fullCard,
        have: fullCard,
        score: 0.9,
        decision: 'match',
      })),
    );
    // One pair asked, one refusal, and no four more four-second waits after it.
    expect(calls).toBe(1);
  });
});
