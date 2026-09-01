import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/aws.js', () => ({ bedrock: { send: vi.fn() }, sqs: { send: vi.fn() } }));

import {
  cosine,
  lexicalScore,
  lexicalSuggestions,
  nodeText,
  resetCategoryCorpus,
  suggestCategories,
  suggestionSentence,
  warmCategoryCorpus,
} from '../../src/domain/categorySuggest.js';
import * as embeddings from '../../src/domain/embeddings.js';

const cfg = { bedrockEmbedModelId: 'test-embed' } as any;

beforeEach(() => {
  resetCategoryCorpus();
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
  it('names the closest open categories, plainly', () => {
    expect(suggestionSentence('unknown', ['goods.electronics.laptop', 'goods.electronics.tablet'])).toBe(
      "That category isn't in the taxonomy. Closest open ones: goods.electronics.laptop, goods.electronics.tablet.",
    );
    expect(suggestionSentence('reserved', ['social.activity-partner.walking'])).toContain(
      'Closest open ones: social.activity-partner.walking.',
    );
  });

  it('still says something useful with nothing to suggest', () => {
    expect(suggestionSentence('unknown', [])).toBe("That category isn't in the taxonomy.");
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

  it('embeds the path together with its human label path', () => {
    expect(nodeText('goods.electronics.laptop')).toContain('goods.electronics.laptop');
    expect(nodeText('goods.electronics.laptop')).toContain('Laptops');
  });
});
