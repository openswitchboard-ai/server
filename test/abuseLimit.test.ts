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
