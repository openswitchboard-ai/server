import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/aws.js', () => ({ bedrock: { send: vi.fn() }, sqs: { send: vi.fn() } }));

import {
  RELATED_OPEN,
  askText,
  cosine,
  lexicalScore,
  lexicalSuggestions,
  nodeText,
  relatedOpenShelves,
  SUGGEST_CACHE_MAX,
  resetCategoryCorpus,
  resetSuggestCache,
  suggestCacheSize,
  suggestCategories,
  suggestionSentence,
  warmCategoryCorpus,
} from '../../src/domain/categorySuggest.js';
import * as embeddings from '../../src/domain/embeddings.js';
import { assertCategoryOpen } from '../../src/domain/cards.js';
import { categoryGate } from '../../src/denylist.js';
import { lintHumanCopy } from '../../src/email/lint.js';

const cfg = { bedrockEmbedModelId: 'test-embed' } as any;

beforeEach(() => {
  resetCategoryCorpus();
  resetSuggestCache();
  vi.restoreAllMocks();
});

describe('lexical closeness', () => {
  it('lands a free-typed path on the node that shares its leaf word', () => {
    const s = lexicalSuggestions('goods.laptop.macbook-air');
    expect(s[0].category).toBe('goods.electronics.laptop');
  });

  it('finds the language-exchange node from a path that predates it', () => {
    const s = lexicalSuggestions('social.conversation.language-exchange');
    expect(s.map((x) => x.category)).toContain('social.language-exchange');
  });

  it('finds a services node from an invented one', () => {
    const s = lexicalSuggestions('services.tutoring.high-school-maths');
    expect(s[0].category.startsWith('services.tutoring')).toBe(true);
  });

  it('never suggests a reserved category', () => {
    for (const q of ['social.dating.italian', 'services.electrical.rewiring', 'property.rent']) {
      for (const s of lexicalSuggestions(q, 3)) {
        expect(s.category.startsWith('social.dating')).toBe(false);
        expect(s.category.startsWith('services.trades')).toBe(false);
        expect(s.category.startsWith('property')).toBe(false);
        expect(s.category.startsWith('work')).toBe(false);
      }
    }
  });

  it('never suggests a bare top level', () => {
    for (const q of ['property.rental', 'services.trades.electrical', 'social.dating.serious']) {
      for (const s of lexicalSuggestions(q, 3)) expect(s.category).toContain('.');
    }
  });

  it('returns at most three, ordered, and scores an exact node highest', () => {
    const s = lexicalSuggestions('goods.electronics.laptop', 3);
    expect(s.length).toBeLessThanOrEqual(3);
    expect(s[0].category).toBe('goods.electronics.laptop');
    for (let i = 1; i < s.length; i++) expect(s[i - 1].score).toBeGreaterThanOrEqual(s[i].score);
    expect(lexicalScore('goods.electronics.laptop', 'goods.electronics.laptop')).toBeGreaterThan(
      lexicalScore('goods.electronics.laptop', 'goods.furniture.sofa'),
    );
  });
});

describe('the sentence a human reads', () => {
  // 26 September 2026: the probe on dev heard "Closest open ones:
  // services.garden, services.repairs.computer, goods.home.decor." for a
  // dentist. Paths are for the machine field; the sentence names shelves.
  it('names the nearest open shelves in words, never as paths', () => {
    const s = suggestionSentence('unknown', ['goods.electronics.laptop', 'goods.electronics.tablet']);
    expect(s).toBe(
      "That heading isn't one the switchboard uses. The nearest open shelves are laptops and tablets.",
    );
    expect(s).not.toMatch(/\b[a-z-]+\.[a-z-]+/);
    expect(suggestionSentence('reserved', ['services.moving'], 'services.driving.removals')).toBe(
      "The switchboard isn't open to paid driving, like lessons, passenger rides and removals yet, because that work needs licence checks it doesn't do. The nearest open shelf is moving and lifting.",
    );
  });

  it('still says something useful with nothing to suggest', () => {
    expect(suggestionSentence('unknown', [])).toBe("That heading isn't one the switchboard uses.");
  });

  it('names a closed family in plain words, with the real reason where there is one', () => {
    const cases: [string, RegExp][] = [
      ['property.share.room', /^The switchboard isn't open to rooms, rentals and other property yet\.$/],
      ['services.trades.plumbing', /licensed trades like plumbing and electrical work yet, because that work needs licence checks/],
      ['services.health.dental', /isn't open to health care yet, because that work needs licence checks/],
      ['goods.vehicles.trailer', /isn't open to vehicles and trailers yet, while the right rules for that are worked out\.$/],
      ['social.dating.casual', /isn't open to dating yet, while the right rules/],
    ];
    for (const [path, reads] of cases) {
      const s = suggestionSentence('reserved', relatedOpenShelves(path), path);
      expect(s, path).toMatch(reads);
      expect(s, path).not.toContain(path);
      expect(s, path).not.toMatch(/\b(goods|services|social|property|work)\.[a-z]/);
      expect(lintHumanCopy(s), path).toEqual([]);
      expect(s.length, path).toBeLessThanOrEqual(300);
    }
  });

  it('offers nothing for a closed family unless something is genuinely related', () => {
    // The three the probe heard nonsense for now hear nothing at all.
    expect(relatedOpenShelves('services.health.dental')).toEqual([]);
    expect(relatedOpenShelves('services.trades.plumbing')).toEqual([]);
    expect(relatedOpenShelves('property.share.room')).toEqual([]);
    expect(relatedOpenShelves('goods.vehicles.trailer')).toEqual([]);
    // Where the same errand is done between neighbours, that shelf is offered.
    expect(relatedOpenShelves('services.driving.removals')).toEqual(['services.moving']);
    // Every curated suggestion is itself open.
    for (const list of Object.values(RELATED_OPEN)) {
      for (const c of list) expect(categoryGate(c).ok, c).toBe(true);
    }
  });

  it('refuses a closed family at the door without asking the embedder', async () => {
    const spy = vi.spyOn(embeddings, 'embedText');
    const payload = await assertCategoryOpen(cfg, 'services.health.dental', 'acct').then(
      () => {
        throw new Error('the gate did not refuse');
      },
      (e: any) => e.payload,
    );
    expect(payload.code).toBe('CATEGORY_PROHIBITED');
    expect(payload.suggestions).toBeUndefined();
    expect(payload.human_action).toContain('health care');
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('embedding closeness', () => {
  // A stand-in embedder: one dimension per keyword, so "laptop" texts point
  // the same way and cosine has something real to measure.
  const KEYWORDS = ['laptop', 'language', 'exchange', 'bicycle', 'tutoring', 'sofa'];
  const fakeEmbed = (text: string): number[] => {
    const v = KEYWORDS.map((k) => (text.toLowerCase().includes(k) ? 1 : 0));
    return [...v, 0.01];
  };

  it('warms the corpus once and answers from it', async () => {
    const spy = vi.spyOn(embeddings, 'embedText').mockImplementation(async (_c, t) => fakeEmbed(t));
    await warmCategoryCorpus(cfg);
    const calls = spy.mock.calls.length;
    expect(calls).toBeGreaterThan(300);

    const r = await suggestCategories(cfg, 'goods.laptop.macbook-air');
    expect(r.source).toBe('embedding');
    expect(r.categories).toContain('goods.electronics.laptop');
    expect(r.categories.length).toBeLessThanOrEqual(3);
    // One more call for the query, and the corpus is not rebuilt.
    expect(spy.mock.calls.length).toBe(calls + 1);
  });

  it('falls back to the lexical answer when Bedrock is unavailable', async () => {
    vi.spyOn(embeddings, 'embedText').mockRejectedValue(new Error('bedrock unavailable'));
    const r = await suggestCategories(cfg, 'goods.laptop.macbook-air');
    expect(r.source).toBe('lexical');
    expect(r.categories[0]).toBe('goods.electronics.laptop');
  });

  it('answers lexically while the corpus is still cold, without waiting on it', async () => {
    // The warm-up never settles; the request must not hang on it.
    vi.spyOn(embeddings, 'embedText').mockImplementation(() => new Promise(() => {}));
    const r = await Promise.race([
      suggestCategories(cfg, 'goods.laptop.macbook-air'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('blocked on warm-up')), 2000)),
    ]);
    expect((r as any).source).toBe('lexical');
  });

  /**
   * HOW FAR IN FRONT OF THE FIELD, and why anybody needs it.
   *
   * A raw cosine moves with the shape of the question — the same path asked
   * alone and asked with the posting's words scored 0.52 and 0.24 against the
   * same node on dev, with nothing about the right answer changed. So the
   * suggester reports the raw score AND how far the answer stands out from the
   * whole catalogue, and the door decides on the second.
   */
  it('says how far each answer leads the field, as well as what it scored', async () => {
    vi.spyOn(embeddings, 'embedText').mockImplementation(async (_c, t) => fakeEmbed(t));
    await warmCategoryCorpus(cfg);
    const r = await suggestCategories(cfg, 'goods.laptop.macbook-air');
    expect(r.source).toBe('embedding');
    expect(r.scored[0].score).toBeGreaterThan(0);
    // One node points the same way as the query and hundreds do not, so the
    // top answer is a long way out in front.
    expect(r.scored[0].lead!).toBeGreaterThan(3);
    for (let i = 1; i < r.scored.length; i++) {
      expect(r.scored[i].lead!).toBeLessThanOrEqual(r.scored[i - 1].lead!);
    }
  });

  it('gives the lexical answer no lead, because it is not on that scale', async () => {
    vi.spyOn(embeddings, 'embedText').mockRejectedValue(new Error('bedrock unavailable'));
    const r = await suggestCategories(cfg, 'goods.laptop.macbook-air');
    expect(r.source).toBe('lexical');
    expect(r.scored[0].lead).toBeUndefined();
  });

  /** The lexical scorer is a last resort, and a last resort says so. */
  it('never answers lexically in silence', async () => {
    const said: { msg: string; extra?: any }[] = [];
    const log = (msg: string, extra?: any) => said.push({ msg, extra });
    vi.spyOn(embeddings, 'embedText').mockRejectedValue(new Error('bedrock unavailable'));
    await suggestCategories(cfg, 'goods.laptop.macbook-air', 3, log);
    const line = said.find((s) => s.msg.includes('answering lexically'));
    expect(line, JSON.stringify(said)).toBeTruthy();
    expect(line!.extra.why).toBeTruthy();
  });

  /**
   * A WARM-UP THAT FAILED IS NOT AN ANSWER. Holding on to the failure left a
   * process that started while Bedrock was unhappy answering lexically for as
   * long as it lived, with one line in the log at boot and nothing after it.
   */
  it('tries the corpus again after a warm-up that failed', async () => {
    vi.spyOn(embeddings, 'embedText').mockRejectedValue(new Error('bedrock unavailable'));
    expect((await suggestCategories(cfg, 'goods.laptop.macbook-air')).source).toBe('lexical');
    // The warm-up the refused call started has to settle before its failure
    // can be let go of; the one after it is the retry.
    await warmCategoryCorpus(cfg);
    vi.spyOn(embeddings, 'embedText').mockImplementation(async (_c, t) => fakeEmbed(t));
    await warmCategoryCorpus(cfg);
    expect((await suggestCategories(cfg, 'goods.laptop.macbook-air')).source).toBe('embedding');
  });

  it('cosine behaves', () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosine([0, 0], [1, 1])).toBe(0);
  });

  it('reports how close each answer is, so a caller can set a floor', async () => {
    vi.spyOn(embeddings, 'embedText').mockRejectedValue(new Error('bedrock unavailable'));
    const r = await suggestCategories(cfg, 'goods.laptop.macbook-air');
    expect(r.scored[0].category).toBe(r.categories[0]);
    expect(r.scored[0].score).toBeGreaterThan(0);
    const far = await suggestCategories(cfg, 'intg-email.a3f2b1c9');
    expect(far.scored[0]?.score ?? 0).toBeLessThan(r.scored[0].score);
  });

  /**
   * A node is embedded as what it IS, in the words a person would use, not as
   * the breadcrumb a database would print. The breadcrumb framing put most of
   * its characters into punctuation, the word "category" and the same formal
   * top-level name every node in the branch carries, and a posting's own words
   * matched none of it.
   */
  it('describes a node in words, with no dotted path and no top level in it', () => {
    const t = nodeText('goods.electronics.laptop');
    expect(t).toContain('Laptops');
    expect(t).toContain('Electronics');
    expect(t).not.toContain('goods.electronics.laptop');
    expect(t).not.toContain('Secondhand consumer goods');
  });

  it('uses the phrase the catalogue already holds for a node', () => {
    // 'Mountain bikes' and 'mountain bike' are not the same string, and the
    // second is the one somebody would type.
    expect(nodeText('goods.bicycle.mountain')).toContain('mountain bike');
    // Where the phrase only restates the label, it is not said twice.
    expect(nodeText('goods.electronics.console.accessories')).toBe(
      'Console accessories. Electronics, Game consoles, Console accessories.',
    );
  });

  /** The question is put in the same register the nodes are described in. */
  it('asks in plain words: the posting first, the assistant’s path last', () => {
    const t = askText('goods.sim-racing.pedals', {
      kind: 'Fanatec ClubSport brake performance spring',
      attributes: { brand: 'fanatec', model: 'clubsport v3' },
    });
    expect(t).toContain('fanatec clubsport brake performance spring');
    expect(t).toContain('clubsport v3');
    // The path is named as a filing, not as a fact, and it reads as words.
    expect(t).toContain('filed as sim racing pedals');
    expect(t).not.toContain('goods.sim-racing.pedals');
    // No schema keys: the corpus has no schema in it.
    expect(t).not.toContain('brand:');
    // With nothing but a path, the path's own words are the whole question.
    expect(askText('goods.sim-racing.pedals')).toBe('sim racing pedals');
  });
});

// ---------------------------------------------------------------------------
/**
 * THE QUERY EMBEDDING, REMEMBERED (2026-09-17 audit).
 *
 * A refusal is cheap to provoke and cheap to repeat, and an agent that keeps
 * sending the same wrong category — which is exactly what a confused agent
 * does — bought a Titan call each time for an answer that could not possibly
 * have changed. The corpus side was always warmed once and kept; the query side
 * was the half nobody cached.
 */
describe('the same wrong category is embedded once', () => {
  const fakeEmbed = (text: string): number[] => [text.length % 7, text.length % 5, 0.01];

  const warm = async () => {
    const spy = vi.spyOn(embeddings, 'embedText').mockImplementation(async (_c, t) => fakeEmbed(t));
    await warmCategoryCorpus(cfg);
    spy.mockClear();
    return spy;
  };

  it('asks the embedder once, however many times the agent asks', async () => {
    const spy = await warm();
    for (let i = 0; i < 5; i++) await suggestCategories(cfg, 'goods.laptop.macbook-air');
    expect(spy.mock.calls.length).toBe(1);
  });

  it('and gives the same answer every time', async () => {
    await warm();
    const first = await suggestCategories(cfg, 'goods.laptop.macbook-air');
    const again = await suggestCategories(cfg, 'goods.laptop.macbook-air');
    expect(again.categories).toEqual(first.categories);
    expect(again.source).toBe('embedding');
  });

  it('one key however the whitespace and case were spelled', async () => {
    const spy = await warm();
    await suggestCategories(cfg, 'goods.laptop.macbook-air');
    await suggestCategories(cfg, '  GOODS.laptop.macbook-air  ');
    expect(spy.mock.calls.length).toBe(1);
  });

  it('a different category is a different call', async () => {
    const spy = await warm();
    await suggestCategories(cfg, 'goods.laptop.macbook-air');
    await suggestCategories(cfg, 'social.conversation.language-exchange');
    expect(spy.mock.calls.length).toBe(2);
  });

  /**
   * THE KEY IS THE TEXT THAT WAS SENT, and nothing else.
   *
   * Keyed on what the caller asked ABOUT, the same path asked two ways shared
   * one entry, and the second caller was handed the first caller's vector for
   * a string it never sent. The rule that stops that class of bug coming back
   * is that one string is keyed, embedded, and remembered.
   */
  it('keys on what was embedded, so two framings of one path are two entries', async () => {
    const spy = await warm();
    await suggestCategories(cfg, 'goods.laptop.macbook-air');
    await suggestCategories(cfg, 'goods.laptop.macbook-air', 3, undefined, {
      posting: { kind: 'MacBook Air M1', attributes: { brand: 'apple' } },
    });
    expect(spy.mock.calls.length).toBe(2);
    expect(suggestCacheSize()).toBe(2);
    // The two calls sent two different strings; neither was handed the other's.
    expect(spy.mock.calls[0][1]).not.toBe(spy.mock.calls[1][1]);
    // Asking either of them again is free.
    await suggestCategories(cfg, 'goods.laptop.macbook-air');
    expect(spy.mock.calls.length).toBe(2);
  });

  it('holds five hundred and lets the least recently asked for go', async () => {
    await warm();
    for (let i = 0; i < SUGGEST_CACHE_MAX + 20; i++) {
      await suggestCategories(cfg, `goods.made-up.${i}`);
    }
    expect(suggestCacheSize()).toBe(SUGGEST_CACHE_MAX);
  });

  it('an embedder that throws caches nothing, so it is tried again', async () => {
    vi.spyOn(embeddings, 'embedText').mockRejectedValue(new Error('bedrock unavailable'));
    await suggestCategories(cfg, 'goods.laptop.macbook-air');
    expect(suggestCacheSize()).toBe(0);
  });
});
