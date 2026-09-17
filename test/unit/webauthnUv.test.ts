/**
 * A passkey here proves the person, not the phone.
 *
 * Every assertion this switchboard asks for either signs somebody in or
 * elevates a session to approve a disclosure or move money. 'preferred' lets
 * an authenticator answer without checking anybody at all, so a device
 * somebody picked up off a table would do. Both halves matter: asking for
 * user verification in the options, and refusing an answer that did not do it.
 */
import { describe, expect, it, vi } from 'vitest';
import * as db from '../../src/db.js';
import * as wa from '../../src/counter/webauthn.js';
import type { Config } from '../../src/config.js';

vi.mock('@simplewebauthn/server', async (orig) => {
  const real = await orig<Record<string, any>>();
  return {
    ...real,
    generateRegistrationOptions: vi.fn(async (opts: any) => ({ ...opts, challenge: 'c' })),
    generateAuthenticationOptions: vi.fn(async (opts: any) => ({ ...opts, challenge: 'c' })),
    verifyRegistrationResponse: vi.fn(async () => ({ verified: false })),
    verifyAuthenticationResponse: vi.fn(async () => ({ verified: false })),
  };
});

const swa = await import('@simplewebauthn/server');

const cfg = { counterOrigin: 'https://my.test' } as unknown as Config;
const ACCOUNT = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

const emptyPool = () => ({ query: async () => ({ rows: [], rowCount: 0 }) }) as any;

describe('what the browser is asked for', () => {
  it('registration asks for the person, not just the device', async () => {
    vi.spyOn(db, 'getPool').mockReturnValue(emptyPool());
    const opts: any = await wa.registrationOptions(cfg, ACCOUNT, 'ana@example.com');
    expect(opts.authenticatorSelection.userVerification).toBe('required');
  });

  it('signing in asks for it too', async () => {
    const opts: any = await wa.authenticationOptions(cfg);
    expect(opts.userVerification).toBe('required');
  });
});

describe('what the answer has to show', () => {
  it('an enrolment that skipped the check is not enrolled', async () => {
    vi.spyOn(db, 'getPool').mockReturnValue(emptyPool());
    await expect(wa.verifyRegistration(cfg, ACCOUNT, 'c', {})).rejects.toThrow(/not verified/);
    const call = vi.mocked(swa.verifyRegistrationResponse).mock.calls.at(-1)![0] as any;
    expect(call.requireUserVerification).toBe(true);
  });

  it('an assertion that skipped it is not accepted either', async () => {
    vi.spyOn(db, 'getPool').mockReturnValue({
      query: async () => ({
        rows: [
          {
            credential_id: 'cred-1',
            account_id: ACCOUNT,
            public_key: Buffer.from([1, 2, 3]),
            sign_count: 0,
            transports: null,
          },
        ],
        rowCount: 1,
      }),
    } as any);
    await expect(
      wa.verifyAuthentication(cfg, 'c', { id: 'cred-1' }),
    ).rejects.toThrow(/not verified/);
    const call = vi.mocked(swa.verifyAuthenticationResponse).mock.calls.at(-1)![0] as any;
    expect(call.requireUserVerification).toBe(true);
  });
});
