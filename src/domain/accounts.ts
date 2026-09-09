import { createHash, scryptSync, timingSafeEqual } from 'node:crypto';
import { getPool } from '../db.js';
import { encryptField, generateAccountDataKey, writeConsentEvent } from '../crypto.js';

export interface Account {
  id: string;
  email_hash: string;
  data_key_enc: Buffer;
  first_name_enc: Buffer;
  locality_enc: Buffer;
  login_code_hash: string | null;
  status: string;
  hears_via?: HearsVia;
}

/**
 * How this person hears about their own switchboard.
 *
 *   'email'     — their assistant only acts when spoken to, so every match,
 *                 reply, figure on the table and acceptance has to reach them
 *                 by email or it reaches them the next time they happen to
 *                 open a chat.
 *   'assistant' — an always-on agent brings them the news, and email is the
 *                 backup for the times it cannot get through.
 *
 * 'email' is the default because it is the safe one: someone nobody has told
 * us about gets told rather than left in silence. See migrations/026.
 */
export type HearsVia = 'email' | 'assistant';
export const HEARS_VIA: HearsVia[] = ['email', 'assistant'];

export function emailHash(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
}

/** scrypt hash format: scrypt$<salt-hex>$<hash-hex> (salt chosen by caller/CLI). */
export function verifyLoginCode(code: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  const actual = scryptSync(code, salt, expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * Create an account (0.C: dev-bootstrap only, driven by the internal ops
 * queue; 0.D replaces this with the counter's registration).
 * login_code_hash arrives ALREADY scrypt-hashed from the bootstrap CLI.
 */
export async function createAccount(input: {
  email: string;
  first_name: string;
  locality: string;
  login_code_hash: string;
}): Promise<string> {
  const pool = getPool();
  const eh = emailHash(input.email);
  const existing = await pool.query('SELECT id FROM accounts WHERE email_hash = $1', [eh]);
  if (existing.rowCount) {
    // Idempotent bootstrap: refresh the login code hash.
    const id = existing.rows[0].id as string;
    await pool.query('UPDATE accounts SET login_code_hash = $2 WHERE id = $1', [
      id,
      input.login_code_hash,
    ]);
    return id;
  }
  const idRow = await pool.query('SELECT gen_random_uuid() AS id');
  const id = idRow.rows[0].id as string;
  const wrapped = await generateAccountDataKey(id);
  const [emailEnc, nameEnc, locEnc] = await Promise.all([
    encryptField(id, wrapped, input.email),
    encryptField(id, wrapped, input.first_name),
    encryptField(id, wrapped, input.locality),
  ]);
  await pool.query(
    `INSERT INTO accounts (id, email_hash, email_enc, first_name_enc, locality_enc, login_code_hash, data_key_enc)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, eh, emailEnc, nameEnc, locEnc, input.login_code_hash, wrapped],
  );
  await pool.query(
    'INSERT INTO reputation (account_id) VALUES ($1) ON CONFLICT DO NOTHING',
    [id],
  );
  return id;
}

export async function findAccountByEmail(email: string): Promise<Account | undefined> {
  const r = await getPool().query('SELECT * FROM accounts WHERE email_hash = $1', [
    emailHash(email),
  ]);
  return r.rows[0];
}

export async function getAccount(id: string): Promise<Account | undefined> {
  const r = await getPool().query('SELECT * FROM accounts WHERE id = $1', [id]);
  return r.rows[0];
}

/**
 * How this person hears about their switchboard. Falls back to 'email' for an
 * account that has never said — the safe answer, because the cost of guessing
 * wrong that way is one email too many, and the cost of guessing wrong the
 * other way is a person who never learns their bike sold.
 */
export async function getHearsVia(accountId: string): Promise<HearsVia> {
  try {
    const r = await getPool().query('SELECT hears_via FROM accounts WHERE id = $1', [accountId]);
    return r.rows[0]?.hears_via === 'assistant' ? 'assistant' : 'email';
  } catch {
    return 'email';
  }
}

/**
 * Change it. Consent-logged first, the way every other settings change on this
 * account is (blind mode, email frequency) — the log names the new value and
 * who recorded it.
 */
export async function setHearsVia(
  accountId: string,
  value: HearsVia,
  recordedVia = 'counter',
): Promise<void> {
  if (!HEARS_VIA.includes(value)) throw new Error(`unknown hears_via '${value}'`);
  await writeConsentEvent({
    event: 'hears-via-changed',
    account_id: accountId,
    hears_via: value,
    recorded_via: recordedVia,
  });
  await getPool().query('UPDATE accounts SET hears_via = $2 WHERE id = $1', [accountId, value]);
}
