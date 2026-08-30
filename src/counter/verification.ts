/**
 * Email verification: 6-digit code + link token, single-use, 15-minute TTL,
 * 5 code attempts per verification. The email address is KMS-encrypted at
 * rest (no per-account data key exists yet at registration time).
 */
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { DecryptCommand, EncryptCommand } from '@aws-sdk/client-kms';
import { kms } from '../aws.js';
import { getPool } from '../db.js';
import { emailHash } from '../domain/accounts.js';
import type { Config } from '../config.js';

export const VERIFICATION_TTL_MINUTES = 15;
const MAX_CODE_ATTEMPTS = 5;

const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex');

export interface VerificationRow {
  id: string;
  email_hash: string;
  email_kms_enc: Buffer;
  purpose: 'register' | 'login';
  code_hash: string;
  attempts: number;
  used: boolean;
  expires_at: Date;
}

async function kmsEncryptEmail(cfg: Config, email: string): Promise<Buffer> {
  const r = await kms.send(
    new EncryptCommand({
      KeyId: cfg.identityKeyArn,
      Plaintext: Buffer.from(email, 'utf8'),
      EncryptionContext: { purpose: 'email-verification', env: cfg.envName },
    }),
  );
  return Buffer.from(r.CiphertextBlob!);
}

async function kmsDecryptEmail(cfg: Config, blob: Buffer): Promise<string> {
  const r = await kms.send(
    new DecryptCommand({
      CiphertextBlob: blob,
      EncryptionContext: { purpose: 'email-verification', env: cfg.envName },
    }),
  );
  return Buffer.from(r.Plaintext!).toString('utf8');
}

/** Create a verification. Returns the plaintext code + link token (for the email). */
export async function createVerification(
  cfg: Config,
  email: string,
  purpose: 'register' | 'login',
): Promise<{ id: string; code: string; linkToken: string }> {
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const linkToken = `osb_ev_${randomBytes(24).toString('base64url')}`;
  const enc = await kmsEncryptEmail(cfg, email);
  const r = await getPool().query(
    `INSERT INTO email_verifications (email_hash, email_kms_enc, purpose, code_hash, link_token_hash, expires_at)
     VALUES ($1,$2,$3,$4,$5, now() + make_interval(mins => ${VERIFICATION_TTL_MINUTES}))
     RETURNING id`,
    [emailHash(email), enc, purpose, '', sha256hex(linkToken)],
  );
  const id = r.rows[0].id as string;
  // Code hash is salted with the row id so equal codes hash differently.
  await getPool().query('UPDATE email_verifications SET code_hash = $2 WHERE id = $1', [
    id,
    sha256hex(`${code}:${id}`),
  ]);
  return { id, code, linkToken };
}

/** Simple per-email rate limit: max 3 open verifications per 15 minutes. */
export async function verificationRateLimited(email: string): Promise<boolean> {
  const r = await getPool().query(
    `SELECT count(*)::int AS n FROM email_verifications
     WHERE email_hash = $1 AND created_at > now() - interval '15 minutes'`,
    [emailHash(email)],
  );
  return r.rows[0].n >= 3;
}

export interface VerifyResult {
  ok: boolean;
  reason?: 'expired' | 'used' | 'bad-code' | 'locked' | 'not-found';
  email?: string;
  purpose?: 'register' | 'login';
}

/** Consume a verification by 6-digit code. Single-use. */
export async function verifyByCode(
  cfg: Config,
  verificationId: string,
  code: string,
): Promise<VerifyResult> {
  const r = await getPool().query('SELECT * FROM email_verifications WHERE id = $1', [
    verificationId,
  ]);
  const row: VerificationRow | undefined = r.rows[0];
  if (!row) return { ok: false, reason: 'not-found' };
  if (row.used) return { ok: false, reason: 'used' };
  if (new Date(row.expires_at) < new Date()) return { ok: false, reason: 'expired' };
  if (row.attempts >= MAX_CODE_ATTEMPTS) return { ok: false, reason: 'locked' };
  const expected = Buffer.from(row.code_hash, 'utf8');
  const actual = Buffer.from(sha256hex(`${code.trim()}:${row.id}`), 'utf8');
  const match = expected.length === actual.length && timingSafeEqual(expected, actual);
  if (!match) {
    await getPool().query(
      'UPDATE email_verifications SET attempts = attempts + 1 WHERE id = $1',
      [verificationId],
    );
    return { ok: false, reason: 'bad-code' };
  }
  const upd = await getPool().query(
    'UPDATE email_verifications SET used = true WHERE id = $1 AND NOT used RETURNING id',
    [verificationId],
  );
  if (!upd.rowCount) return { ok: false, reason: 'used' };
  const email = await kmsDecryptEmail(cfg, row.email_kms_enc);
  return { ok: true, email, purpose: row.purpose };
}

/** Consume a verification by emailed link token. Single-use. */
export async function verifyByLinkToken(cfg: Config, linkToken: string): Promise<VerifyResult> {
  const r = await getPool().query(
    'SELECT * FROM email_verifications WHERE link_token_hash = $1',
    [sha256hex(linkToken)],
  );
  const row: VerificationRow | undefined = r.rows[0];
  if (!row) return { ok: false, reason: 'not-found' };
  if (row.used) return { ok: false, reason: 'used' };
  if (new Date(row.expires_at) < new Date()) return { ok: false, reason: 'expired' };
  const upd = await getPool().query(
    'UPDATE email_verifications SET used = true WHERE id = $1 AND NOT used RETURNING id',
    [(row as any).id],
  );
  if (!upd.rowCount) return { ok: false, reason: 'used' };
  const email = await kmsDecryptEmail(cfg, row.email_kms_enc);
  return { ok: true, email, purpose: row.purpose };
}
