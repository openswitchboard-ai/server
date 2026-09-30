import { describe, expect, it } from 'vitest';
import { makeIpLimiter } from '../../src/abuseLimit.js';

describe('per-IP abuse limiter', () => {
  it('allows up to the cap, refuses beyond it, per IP independently', async () => {
    const lim = makeIpLimiter(3, 60_000);
    expect(await lim.limited('1.1.1.1')).toBe(false);
    expect(await lim.limited('1.1.1.1')).toBe(false);
    expect(await lim.limited('1.1.1.1')).toBe(false);
    expect(await lim.limited('1.1.1.1')).toBe(true);
    expect(await lim.limited('2.2.2.2')).toBe(false);
  });

  it('resets after the window elapses', async () => {
    const lim = makeIpLimiter(1, 1);
    expect(await lim.limited('1.1.1.1')).toBe(false);
    const until = Date.now() + 5;
    while (Date.now() < until) { /* let the 1ms window lapse */ }
    expect(await lim.limited('1.1.1.1')).toBe(false);
  });
});

describe('rate-limit bypass', () => {
  const DEV = { envName: 'dev' };
  it('refuses without a configured token; accepts only the exact token', async () => {
    const { rateLimitBypassed } = await import('../../src/abuseLimit.js');
    delete process.env.RATELIMIT_BYPASS_TOKEN;
    expect(rateLimitBypassed({ 'x-osb-ratelimit-bypass': 'a'.repeat(40) }, DEV)).toBe(false);
    process.env.RATELIMIT_BYPASS_TOKEN = 'a'.repeat(40);
    expect(rateLimitBypassed({}, DEV)).toBe(false);
    expect(rateLimitBypassed({ 'x-osb-ratelimit-bypass': 'b'.repeat(40) }, DEV)).toBe(false);
    expect(rateLimitBypassed({ 'x-osb-ratelimit-bypass': 'a'.repeat(40) }, DEV)).toBe(true);
    delete process.env.RATELIMIT_BYPASS_TOKEN;
  });

  it('never exempts anything in prod, whatever the token says', async () => {
    // A stray variable on a prod task must not switch the limits off.
    const { rateLimitBypassed } = await import('../../src/abuseLimit.js');
    process.env.RATELIMIT_BYPASS_TOKEN = 'a'.repeat(40);
    try {
      expect(rateLimitBypassed({ 'x-osb-ratelimit-bypass': 'a'.repeat(40) }, { envName: 'prod' })).toBe(false);
      expect(rateLimitBypassed({ 'x-osb-ratelimit-bypass': 'a'.repeat(40) }, { envName: '' })).toBe(false);
    } finally {
      delete process.env.RATELIMIT_BYPASS_TOKEN;
    }
  });
});

describe('the PIN and anonymous-session pacing', () => {
  it('holds ten PIN tries a minute per account, and each account is its own', async () => {
    const { pinAttemptLimiter } = await import('../../src/abuseLimit.js');
    pinAttemptLimiter.reset();
    for (let i = 0; i < 10; i++) expect(await pinAttemptLimiter.limited('acct-a')).toBe(false);
    expect(await pinAttemptLimiter.limited('acct-a')).toBe(true);
    expect(await pinAttemptLimiter.limited('acct-b')).toBe(false);
    pinAttemptLimiter.reset();
    expect(await pinAttemptLimiter.limited('acct-a')).toBe(false);
  });

  it('holds sessions made for nobody to ten a minute per connection', async () => {
    const { anonymousSessionLimiter } = await import('../../src/abuseLimit.js');
    anonymousSessionLimiter.reset();
    for (let i = 0; i < 10; i++) expect(await anonymousSessionLimiter.limited('9.9.9.9')).toBe(false);
    expect(await anonymousSessionLimiter.limited('9.9.9.9')).toBe(true);
    anonymousSessionLimiter.reset();
  });
});

describe('tool schemas are self-contained', () => {
  it('no ref, defs, or grammar-hostile keyword survives in any tool inputSchema', async () => {
    const { TOOLS } = await import('../../src/mcp/tools.js');
    const walk = (n: any, path: string): string[] => {
      if (Array.isArray(n)) return n.flatMap((v, i) => walk(v, `${path}[${i}]`));
      if (n === null || typeof n !== 'object') return [];
      const bad: string[] = [];
      for (const k of [
        '$ref', '$defs', 'propertyNames', 'not', 'if', 'then', 'else', 'allOf', 'anyOf',
        'oneOf', 'format',
      ]) {
        if (k in n) bad.push(`${path}.${k}`);
      }
      for (const [k, v] of Object.entries(n)) bad.push(...walk(v, `${path}.${k}`));
      return bad;
    };
    for (const t of TOOLS) {
      expect(walk(t.inputSchema, t.name)).toEqual([]);
    }
  });
});
