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

describe('which credential an enrolment is (10 November 2026)', () => {
  const verified = (id: string) =>
    vi.mocked(swa.verifyRegistrationResponse).mockResolvedValueOnce({
      verified: true,
      registrationInfo: { credential: { id, publicKey: new Uint8Array([1]), counter: 0, transports: [] } },
    } as any);

  it('is the id in the signed authenticator data, not the body\'s id', async () => {
    const stored: any[] = [];
    vi.spyOn(db, 'getPool').mockReturnValue({
      query: async (_sql: string, params: any[]) => {
        stored.push(params[0]);
        return { rows: [{ credential_id: params[0] }], rowCount: 1 };
      },
    } as any);
    verified('attested');
    const id = await wa.verifyRegistration(cfg, ACCOUNT, 'c', { id: 'decoy', rawId: 'decoy' });
    expect(id).toBe('attested');
    expect(stored).toEqual(['attested']);
  });

  it('an id already on file is refused, not counted as that passkey', async () => {
    vi.spyOn(db, 'getPool').mockReturnValue(emptyPool());
    verified('somebody-elses');
    await expect(wa.verifyRegistration(cfg, ACCOUNT, 'c', { id: 'x', rawId: 'x' })).rejects.toThrow(
      /already enrolled/,
    );
  });

  it('each refusal carries a code the route answers as a 400 (14 November 2026)', async () => {
    vi.spyOn(db, 'getPool').mockReturnValue(emptyPool());
    verified('on-file');
    await expect(wa.verifyRegistration(cfg, ACCOUNT, 'c', { id: 'x', rawId: 'x' })).rejects.toMatchObject({
      code: 'passkey_already_enrolled',
    });
    vi.mocked(swa.verifyRegistrationResponse).mockRejectedValueOnce(new Error('bad attestation object'));
    const thrown = await wa.verifyRegistration(cfg, ACCOUNT, 'c', {}).catch((e) => e);
    expect(thrown).toBeInstanceOf(wa.EnrolmentRefused);
    expect(thrown.code).toBe('passkey_not_verified');
  });

  it('an assertion with no string id is refused before any lookup', async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    vi.spyOn(db, 'getPool').mockReturnValue({ query } as any);
    await expect(wa.verifyAuthentication(cfg, 'c', { id: 123 })).rejects.toThrow(/unknown passkey/);
    expect(query).not.toHaveBeenCalled();
  });
});
