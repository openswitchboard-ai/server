import { createHash, createHmac, hkdfSync, scryptSync, timingSafeEqual } from 'node:crypto';
import { getPool } from '../db.js';
import { encryptField, generateAccountDataKey, writeConsentEvent } from '../crypto.js';
import { counterKeys } from '../counter/keys.js';

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

/**
 * THE ADDRESS, HASHED, AND WHY THE OLD ONE WAS NOT ENOUGH (2026-09-17 audit).
 *
 * This was a bare SHA-256 of the lowercased address, and a bare SHA-256 of an
 * email address is not a one-way function in any sense that matters. The
 * whole plausible space is small — a few billion real addresses, and the
 * leaked-credential corpora everybody has are lists of exactly those — so
 * anyone holding a copy of these columns can put a name to every row in an
 * afternoon on a laptop. Three tables keyed on it: who has an account, whose
 * account was stopped, and whose address bounced or complained. That is a
 * membership list, a moderation record and a deliverability record, all
 * readable by anyone who reads the database and nothing else.
 *
 * A PEPPER IS THE WHOLE OF THE FIX, and it costs no new secret. The counter
 * already boots with a 32-byte HMAC key it will not run without, and HKDF
 * gives a second, independent key from it under a different info string. The
 * pepper lives only in the process; the dictionary attack now needs the key as
 * well as the corpus, and the key is not in the database.
 *
 * VERSIONS, because the old hashes cannot be recomputed. v1 is the bare
 * SHA-256 that is already written down. v2 is HMAC-SHA256 under the pepper.
 * New writes carry v2; every lookup asks v2 first and falls back to v1, so
 * nothing breaks on the way. scripts/ops/rehash-emails.mts fills v2 on accounts
 * from the encrypted address each one already holds, and after it has run a
 * later migration can drop v1 there. On suspended_emails there is no plaintext
 * to rehash from — the account it belonged to may be gone — so v1 stays on that
 * table permanently and both are checked.
 */
export function emailHashV1(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
}

/** The derived pepper, recomputed if the process is re-keyed (tests do). */
let pepperFor: { key: Buffer; pepper: Buffer } | undefined;

function emailPepper(): Buffer {
  const { linkHmacKey } = counterKeys();
  if (pepperFor?.key === linkHmacKey) return pepperFor.pepper;
  const pepper = Buffer.from(
    hkdfSync('sha256', linkHmacKey, Buffer.alloc(0), 'email-hash-pepper-v1', 32),
  );
  pepperFor = { key: linkHmacKey, pepper };
  return pepper;
}

/** The hash new writes carry. Needs the counter keys, the same as every other
 *  keyed thing on the switchboard; a process without them cannot write. */
export function emailHash(email: string): string {
  return createHmac('sha256', emailPepper()).update(email.trim().toLowerCase()).digest('hex');
}

/**
 * Both spellings of one address, for the tables that still hold some of each.
 * A lookup asks for v2 first and takes v1 as the fallback — the SQL below
 * spells that as one OR rather than two round trips.
 */
export function emailHashes(email: string): { v2: string; v1: string } {
  return { v2: emailHash(email), v1: emailHashV1(email) };
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
  const eh = emailHashes(input.email);
  const existing = await pool.query(
    'SELECT id FROM accounts WHERE email_hash_v2 = $1 OR email_hash = $2',
    [eh.v2, eh.v1],
  );
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
    encryptField(id, wrapped, input.email, 'email'),
    encryptField(id, wrapped, input.first_name, 'first_name'),
    encryptField(id, wrapped, input.locality, 'locality'),
  ]);
  await pool.query(
    `INSERT INTO accounts (id, email_hash, email_hash_v2, email_enc, first_name_enc, locality_enc,
                           login_code_hash, data_key_enc)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, eh.v1, eh.v2, emailEnc, nameEnc, locEnc, input.login_code_hash, wrapped],
  );
  await pool.query(
    'INSERT INTO reputation (account_id) VALUES ($1) ON CONFLICT DO NOTHING',
    [id],
  );
  return id;
}

export async function findAccountByEmail(email: string): Promise<Account | undefined> {
  // v2 first, v1 as the fallback, in one statement: an account that has been
  // rehashed and one that has not answer the same question the same way.
  const eh = emailHashes(email);
  const r = await getPool().query(
    'SELECT * FROM accounts WHERE email_hash_v2 = $1 OR email_hash = $2 LIMIT 1',
    [eh.v2, eh.v1],
  );
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
 * The sentence that rides beside hears_via on every sweep.
 *
 * A bare field name is a word an agent reads out, and in the run-7 rehearsal
 * one did. Every field that changes what the agent should say now carries the
 * saying of it, so the agent has the sentence and never has to invent a noun
 * for the machinery. The field is for the agent; this is what it means.
 */
export function hearsViaNote(hearsVia: HearsVia): {
  text: string;
  provenance: 'switchboard-system';
} {
  return {
    text:
      hearsVia === 'assistant'
        ? 'You are the one who brings this human the news. The switchboard sends them no mail about any of it, so anything you do not pass on, they never hear.'
        : 'This human is emailed about anything that needs them, because you only act when they speak to you. Assume they have read nothing since you last talked, and tell them what has happened before you ask them anything.',
    provenance: 'switchboard-system',
  };
}

/**
 * The human's IANA time zone, or null when never captured. Read on every
 * sweep and on publish, so it stays one cheap query and swallows a missing
 * column the way getHearsVia does.
 */
export async function getTimezone(accountId: string): Promise<string | null> {
  try {
    const r = await getPool().query('SELECT timezone FROM accounts WHERE id = $1', [accountId]);
    const tz = r.rows[0]?.timezone;
    return typeof tz === 'string' && tz ? tz : null;
  } catch {
    return null;
  }
}

/** Record it. A preference rather than a consent, so no event is written. */
export async function setTimezone(accountId: string, tz: string): Promise<void> {
  const { isValidTimeZone } = await import('./localTime.js');
  if (!isValidTimeZone(tz)) throw new Error(`unknown time zone '${String(tz).slice(0, 64)}'`);
  await getPool().query('UPDATE accounts SET timezone = $2 WHERE id = $1', [accountId, tz]);
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
