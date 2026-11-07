/**
 * The Claude API first, Bedrock behind it (src/claude.ts). Every road is a
 * stand-in here: what is held is which road answers, and what is said when it
 * is not the first one.
 */
import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { askClaude, fallbackReason, type ClaudeAsk, type ClaudeDeps } from '../../src/claude.js';
import type { Config } from '../../src/config.js';

const cfg = {
  anthropicKeySecret: 'openswitchboard/anthropic-api-key',
  anthropicKeyRegion: 'ap-southeast-2',
  anthropicModel: 'claude-haiku-4-5',
  bedrockModelId: 'us.anthropic.claude-haiku-4-5',
} as Config;

const ask: ClaudeAsk = {
  max_tokens: 300,
  system: 'Read the listing and give the verdict.',
  messages: [
    { role: 'user', content: '<untrusted_listing_text>\nkind: mountain bike\n</untrusted_listing_text>' },
    { role: 'assistant', content: '{' },
  ],
};

const KEY = 'sk-ant-test-not-a-real-key';

/** Stand-ins that record what was asked of them. */
function roads(over: Partial<ClaudeDeps> = {}) {
  const seen = { direct: [] as ClaudeAsk[], bedrock: [] as ClaudeAsk[], warnings: [] as Record<string, unknown>[], keys: [] as string[] };
  const deps: ClaudeDeps = {
    loadKey: async () => KEY,
    direct: async (_c, key, a) => {
      seen.keys.push(key);
      seen.direct.push(a);
      return '"spam":false}';
    },
    bedrock: async (_c, a) => {
      seen.bedrock.push(a);
      return '"spam":true}';
    },
    warn: (f) => seen.warnings.push(f),
    ...over,
  };
  return { deps, seen };
}

const apiError = (status: number, message: string, type: string) =>
  Anthropic.APIError.generate(status, { type: 'error', error: { type, message } }, message, new Headers());

describe('askClaude', () => {
  it('answers through the Claude API when the key is there and the call succeeds', async () => {
    const { deps, seen } = roads();
    expect(await askClaude(cfg, ask, deps)).toBe('"spam":false}');
    // The same body, prefill and all, and the key it was handed.
    expect(seen.direct).toEqual([ask]);
    expect(seen.keys).toEqual([KEY]);
    expect(seen.bedrock).toEqual([]);
    expect(seen.warnings).toEqual([]);
  });

  it.each([
    ['a connection that never completed', new Anthropic.APIConnectionError({ message: 'fetch failed' }), 'unreachable'],
    ['a timeout', new Anthropic.APIConnectionTimeoutError(), 'unreachable'],
    ['a 429', apiError(429, 'Number of request tokens has exceeded your rate limit', 'rate_limit_error'), 'rate-limited'],
    ['a 500', apiError(500, 'Internal server error', 'api_error'), 'server-error'],
    ['a 529', apiError(529, 'Overloaded', 'overloaded_error'), 'overloaded'],
    [
      'a 400 saying the credit balance is too low',
      apiError(400, 'Your credit balance is too low to access the Anthropic API.', 'invalid_request_error'),
      'credit-balance',
    ],
    ['a key the API refuses', apiError(401, 'invalid x-api-key', 'authentication_error'), 'key-refused'],
  ])('falls back to Bedrock on %s, with one warning line', async (_what, error, reason) => {
    const { deps, seen } = roads({
      direct: async () => {
        throw error;
      },
    });
    expect(await askClaude(cfg, ask, deps)).toBe('"spam":true}');
    expect(seen.bedrock).toEqual([ask]);
    expect(seen.warnings).toHaveLength(1);
    expect(seen.warnings[0]).toMatchObject({ event: 'claude-api-fallback', reason });
    // Nothing that carries the key reaches the log.
    expect(JSON.stringify(seen.warnings)).not.toContain(KEY);
  });

  it('throws any other 400 as it is: Bedrock would read the same body the same way', async () => {
    const wrong = apiError(400, 'messages: roles must alternate', 'invalid_request_error');
    const { deps, seen } = roads({
      direct: async () => {
        throw wrong;
      },
    });
    await expect(askClaude(cfg, ask, deps)).rejects.toBe(wrong);
    expect(seen.bedrock).toEqual([]);
    expect(seen.warnings).toEqual([]);
  });

  it('falls back to Bedrock when the key is missing, with one warning line', async () => {
    const { deps, seen } = roads({ loadKey: async () => undefined });
    expect(await askClaude(cfg, ask, deps)).toBe('"spam":true}');
    expect(seen.direct).toEqual([]);
    expect(seen.bedrock).toEqual([ask]);
    expect(seen.warnings).toEqual([{ event: 'claude-api-fallback', reason: 'no-key' }]);
  });

  it('falls back to Bedrock when the key cannot be read, naming the error and not its message', async () => {
    const denied = Object.assign(new Error(`not authorized to read ${cfg.anthropicKeySecret}`), {
      name: 'AccessDeniedException',
    });
    const { deps, seen } = roads({
      loadKey: async () => {
        throw denied;
      },
    });
    expect(await askClaude(cfg, ask, deps)).toBe('"spam":true}');
    expect(seen.direct).toEqual([]);
    expect(seen.warnings).toEqual([
      { event: 'claude-api-fallback', reason: 'key-unreadable', error: 'AccessDeniedException' },
    ]);
  });

  it('goes straight to Bedrock, saying nothing, where no secret is named at all', async () => {
    const { deps, seen } = roads();
    const bedrockOnly = { ...cfg, anthropicKeySecret: undefined } as Config;
    expect(await askClaude(bedrockOnly, ask, deps)).toBe('"spam":true}');
    expect(seen.direct).toEqual([]);
    expect(seen.warnings).toEqual([]);
  });
});

describe('fallbackReason', () => {
  it('leaves errors that are not the API\'s own alone', () => {
    expect(fallbackReason(new Error('a bug of ours'))).toBeUndefined();
    expect(fallbackReason(apiError(404, 'model: claude-haiku-4-5', 'not_found_error'))).toBeUndefined();
  });

  it('reads a billing error as one', () => {
    expect(fallbackReason(apiError(402, 'Payment required', 'billing_error'))).toBe('billing');
  });
});
