import { randomBytes, scryptSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { emailHash, verifyLoginCode } from '../../src/domain/accounts.js';

describe('login code hashing', () => {
  it('verifies a scrypt-hashed code and rejects a wrong one', () => {
    const code = 'osb-dev-test-code';
    const salt = randomBytes(16);
    const stored = `scrypt$${salt.toString('hex')}$${scryptSync(code, salt, 32).toString('hex')}`;
    expect(verifyLoginCode(code, stored)).toBe(true);
    expect(verifyLoginCode('wrong', stored)).toBe(false);
    expect(verifyLoginCode(code, 'garbage')).toBe(false);
  });
  it('email hashing is case/whitespace insensitive', () => {
    expect(emailHash(' A@B.com ')).toBe(emailHash('a@b.com'));
  });
});
