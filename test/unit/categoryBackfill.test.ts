import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/aws.js', () => ({ bedrock: { send: vi.fn() }, sqs: { send: vi.fn() } }));
vi.mock('../../src/db.js', () => ({ getPool: () => ({ query: vi.fn() }) }));

import { DEFAULT_MIN_SCORE, ISLAND_PREFIX } from '../../src/domain/categoryBackfill.js';

describe('what the category sweep leaves alone', () => {
  it('recognises the integration suite islands', () => {
    expect(ISLAND_PREFIX.test('intg-email.a3f2b1c9')).toBe(true);
    expect(ISLAND_PREFIX.test('intg.matching.7f21')).toBe(true);
    expect(ISLAND_PREFIX.test('goods.laptop.macbook-air')).toBe(false);
    expect(ISLAND_PREFIX.test('social.conversation.language-exchange')).toBe(false);
  });

  it('sets a floor under both ways of measuring closeness', () => {
    expect(DEFAULT_MIN_SCORE.embedding).toBeGreaterThan(0);
    expect(DEFAULT_MIN_SCORE.embedding).toBeLessThan(1);
    expect(DEFAULT_MIN_SCORE.lexical).toBeGreaterThan(0);
    expect(DEFAULT_MIN_SCORE.lexical).toBeLessThan(1);
  });
});
