/**
 * Passkeys (WebAuthn) via @simplewebauthn/server v13. RP ID is the counter
 * hostname, so credentials are scoped to the counter origin and structurally
 * useless anywhere else.
 */
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { getPool } from '../db.js';
import type { Config } from '../config.js';

export function rpId(cfg: Config): string {
  return new URL(cfg.counterOrigin).hostname;
}

export interface StoredCredential {
  credential_id: string;
  account_id: string;
  public_key: Buffer;
  sign_count: number;
  transports: string[] | null;
}

export async function listCredentials(accountId: string): Promise<StoredCredential[]> {
  const r = await getPool().query(
    'SELECT * FROM webauthn_credentials WHERE account_id = $1',
    [accountId],
  );
  return r.rows;
}

export async function accountHasPasskey(accountId: string): Promise<boolean> {
  const r = await getPool().query(
    'SELECT 1 FROM webauthn_credentials WHERE account_id = $1 LIMIT 1',
    [accountId],
  );
  return !!r.rowCount;
}

export async function registrationOptions(cfg: Config, accountId: string, label: string) {
  const existing = await listCredentials(accountId);
  return generateRegistrationOptions({
    rpName: 'OpenSwitchboard',
    rpID: rpId(cfg),
    userName: label,
    userID: Buffer.from(accountId.replace(/-/g, ''), 'hex'),
    attestationType: 'none',
    excludeCredentials: existing.map((c) => ({
      id: c.credential_id,
      transports: (c.transports ?? undefined) as any,
    })),
    authenticatorSelection: {
      residentKey: 'preferred',
      // REQUIRED, not preferred. A passkey on this account is a credential for
      // approving disclosures and moving money, and 'preferred' lets an
      // authenticator hand back an assertion that proves possession of the
      // device and nothing about who is holding it — so a phone somebody
      // picked up off a table would do. The face, the fingerprint or the
      // device PIN is the whole point of asking for the passkey.
      userVerification: 'required',
    },
  });
}

export async function verifyRegistration(
  cfg: Config,
  accountId: string,
  expectedChallenge: string,
  response: any,
): Promise<void> {
  const v = await verifyRegistrationResponse({
    response,
    expectedChallenge,
    expectedOrigin: cfg.counterOrigin,
    expectedRPID: rpId(cfg),
    // The asking is worth nothing without the checking: an authenticator that
    // ignored the request and sent back an unverified assertion must not be
    // enrolled as though it had complied.
    requireUserVerification: true,
  });
  if (!v.verified || !v.registrationInfo) throw new Error('passkey registration not verified');
  const cred = v.registrationInfo.credential;
  await getPool().query(
    `INSERT INTO webauthn_credentials (credential_id, account_id, public_key, sign_count, transports)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (credential_id) DO NOTHING`,
    [
      cred.id,
      accountId,
      Buffer.from(cred.publicKey),
      cred.counter,
      JSON.stringify(cred.transports ?? []),
    ],
  );
}

export async function authenticationOptions(cfg: Config) {
  // Discoverable-credential flow: no allow-list, the browser offers the
  // passkeys it holds for this RP.
  //
  // REQUIRED, because every assertion this switchboard asks for either signs
  // somebody in or elevates a session to approve something — there is no
  // reading-only use of a passkey here. Mere possession of an unlocked device
  // is not the credential; the person is.
  return generateAuthenticationOptions({
    rpID: rpId(cfg),
    userVerification: 'required',
  });
}

/** Verify an assertion; returns the credential's account id. */
export async function verifyAuthentication(
  cfg: Config,
  expectedChallenge: string,
  response: any,
): Promise<string> {
  const r = await getPool().query('SELECT * FROM webauthn_credentials WHERE credential_id = $1', [
    response.id,
  ]);
  const stored: StoredCredential | undefined = r.rows[0];
  if (!stored) throw new Error('unknown passkey');
  const v = await verifyAuthenticationResponse({
    response,
    expectedChallenge,
    expectedOrigin: cfg.counterOrigin,
    expectedRPID: rpId(cfg),
    requireUserVerification: true,
    credential: {
      id: stored.credential_id,
      publicKey: new Uint8Array(stored.public_key),
      counter: Number(stored.sign_count),
      transports: (stored.transports ?? undefined) as any,
    },
  });
  if (!v.verified) throw new Error('passkey assertion not verified');
  await getPool().query(
    'UPDATE webauthn_credentials SET sign_count = $2 WHERE credential_id = $1',
    [stored.credential_id, v.authenticationInfo.newCounter],
  );
  return stored.account_id;
}
