import { createHash, scryptSync, timingSafeEqual } from 'node:crypto';
import { getPool } from '../db.js';
import { encryptField, generateAccountDataKey } from '../crypto.js';

export interface Account {
  id: string;
  email_hash: string;
  data_key_enc: Buffer;
  first_name_enc: Buffer;
  locality_enc: Buffer;
  login_code_hash: string | null;
  status: string;
}

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
