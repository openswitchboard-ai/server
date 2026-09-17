import { randomBytes, scryptSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { emailHash, emailHashV1, verifyLoginCode } from '../../src/domain/accounts.js';
import { initCounterKeys } from '../../src/counter/keys.js';

describe('login code hashing', () => {
  it('verifies a scrypt-hashed code and rejects a wrong one', () => {
    const code = 'osb-dev-test-code';
    const salt = randomBytes(16);
    const stored = `scrypt$${salt.toString('hex')}$${scryptSync(code, salt, 32).toString('hex')}`;
    expect(verifyLoginCode(code, stored)).toBe(true);
    expect(verifyLoginCode('wrong', stored)).toBe(false);
    expect(verifyLoginCode(code, 'garbage')).toBe(false);
  });
  it('email hashing is case/whitespace insensitive, and peppered', async () => {
    process.env.COUNTER_LINK_HMAC_KEY = 'ab'.repeat(32);
    process.env.COUNTER_COOKIE_KEY = 'cd'.repeat(32);
    await initCounterKeys({} as any);
    expect(emailHash(' A@B.com ')).toBe(emailHash('a@b.com'));
    // And it is not the bare digest any more: the pepper is the whole point,
    // because a bare SHA-256 of an address is a dictionary away from the name.
    expect(emailHash('a@b.com')).not.toBe(emailHashV1('a@b.com'));
    expect(emailHashV1(' A@B.com ')).toBe(emailHashV1('a@b.com'));
  });
});
