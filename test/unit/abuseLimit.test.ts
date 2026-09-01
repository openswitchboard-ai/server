import { describe, expect, it } from 'vitest';
import { makeIpLimiter } from '../../src/abuseLimit.js';

describe('per-IP abuse limiter', () => {
  it('allows up to the cap, refuses beyond it, per IP independently', () => {
    const lim = makeIpLimiter(3, 60_000);
    expect(lim.limited('1.1.1.1')).toBe(false);
    expect(lim.limited('1.1.1.1')).toBe(false);
    expect(lim.limited('1.1.1.1')).toBe(false);
    expect(lim.limited('1.1.1.1')).toBe(true);
    expect(lim.limited('2.2.2.2')).toBe(false);
  });

  it('resets after the window elapses', () => {
    const lim = makeIpLimiter(1, 1);
    expect(lim.limited('1.1.1.1')).toBe(false);
    const until = Date.now() + 5;
    while (Date.now() < until) { /* let the 1ms window lapse */ }
    expect(lim.limited('1.1.1.1')).toBe(false);
  });
});

describe('rate-limit bypass', () => {
  it('refuses without a configured token; accepts only the exact token', async () => {
    const { rateLimitBypassed } = await import('../../src/abuseLimit.js');
    delete process.env.RATELIMIT_BYPASS_TOKEN;
    expect(rateLimitBypassed({ 'x-osb-ratelimit-bypass': 'a'.repeat(40) })).toBe(false);
    process.env.RATELIMIT_BYPASS_TOKEN = 'a'.repeat(40);
    expect(rateLimitBypassed({})).toBe(false);
    expect(rateLimitBypassed({ 'x-osb-ratelimit-bypass': 'b'.repeat(40) })).toBe(false);
    expect(rateLimitBypassed({ 'x-osb-ratelimit-bypass': 'a'.repeat(40) })).toBe(true);
    delete process.env.RATELIMIT_BYPASS_TOKEN;
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
