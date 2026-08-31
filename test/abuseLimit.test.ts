import { describe, expect, it } from 'vitest';
import { makeIpLimiter } from '../src/abuseLimit.js';

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
    const { rateLimitBypassed } = await import('../src/abuseLimit.js');
    delete process.env.RATELIMIT_BYPASS_TOKEN;
    expect(rateLimitBypassed({ 'x-osb-ratelimit-bypass': 'a'.repeat(40) })).toBe(false);
    process.env.RATELIMIT_BYPASS_TOKEN = 'a'.repeat(40);
    expect(rateLimitBypassed({})).toBe(false);
    expect(rateLimitBypassed({ 'x-osb-ratelimit-bypass': 'b'.repeat(40) })).toBe(false);
    expect(rateLimitBypassed({ 'x-osb-ratelimit-bypass': 'a'.repeat(40) })).toBe(true);
    delete process.env.RATELIMIT_BYPASS_TOKEN;
  });
});

describe('open-experiment category policy', () => {
  it('allows unknown friendly categories, blocks prohibited families', async () => {
    const { categoryKnownAndOpen } = await import('../src/denylist.js');
    expect(categoryKnownAndOpen('social.conversation.language-exchange', 'open-experiment').ok).toBe(true);
    expect(categoryKnownAndOpen('services.tutoring.maths', 'open-experiment').ok).toBe(true);
    expect(categoryKnownAndOpen('goods.weapons.firearms', 'open-experiment').ok).toBe(false);
    expect(categoryKnownAndOpen('services.drugs.delivery', 'open-experiment').ok).toBe(false);
    expect(categoryKnownAndOpen('not a path', 'open-experiment').ok).toBe(false);
    expect(categoryKnownAndOpen('social.conversation.language-exchange', 'taxonomy').ok).toBe(false);
  });
});
