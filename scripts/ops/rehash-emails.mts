/**
 * Fill accounts.email_hash_v2, once, after migration 043 is deployed.
 *
 * WHY THERE IS A SCRIPT AT ALL. email_hash was a bare SHA-256 of the address,
 * which is not a one-way function for a space as small and as well catalogued
 * as email addresses (see the header on emailHash in src/domain/accounts.ts).
 * v2 is HMAC-SHA256 under a pepper the database never sees. Nothing can turn a
 * v1 hash into a v2 hash — that is the whole point of both — so the only way to
 * fill the new column is to go back to the address itself, and every account
 * already holds one, encrypted under its own data key.
 *
 * WHAT IT DOES. For every account with no email_hash_v2: unwrap the account's
 * data key, decrypt email_enc, compute the peppered hash, write it. Nothing
 * else on the row is touched, the address never leaves this process, and a
 * decrypt that fails leaves that one account for a human to look at rather than
 * stopping the run.
 *
 * WHY IT IS SAFE TO RUN TWICE. The pass selects only rows with a NULL v2, and
 * every write is one column on one row. Run it again after a partial run and it
 * picks up where it left off.
 *
 * WHAT IT COSTS. One decrypt audit line per account, in the WORM consent log,
 * exactly as every other read of a person's own details writes. That is
 * deliberate: a job that reads every address on the switchboard should leave a
 * record that it did.
 *
 * AFTERWARDS. Every lookup already asks v2 first and falls back to v1, so
 * nothing changes the moment this finishes. Once the count of remaining rows is
 * zero, a later migration can drop accounts.email_hash. suspended_emails keeps
 * both spellings permanently: there is no plaintext behind those rows.
 *
 *   npm run rehash-emails            # a dry run: counts, writes nothing
 *   npm run rehash-emails -- --apply
 *
 * It runs against whatever DATABASE_URL / the deployment's own config names,
 * the same as the server, and needs the same KMS and counter-keys access the
 * server has.
 */
import { loadConfig } from '../../src/config.js';
import { getPool, initDb } from '../../src/db.js';
import { decryptFields, initEnvelope } from '../../src/crypto.js';
import { initCounterKeys } from '../../src/counter/keys.js';
import { emailHash } from '../../src/domain/accounts.js';

const apply = process.argv.includes('--apply');
const batch = 200;

const cfg = loadConfig();
await initDb(cfg);
initEnvelope(cfg);
await initCounterKeys(cfg);
const pool = getPool();

const todo = await pool.query(
  `SELECT count(*)::int AS n FROM accounts WHERE email_hash_v2 IS NULL AND email_enc IS NOT NULL`,
);
const orphans = await pool.query(
  `SELECT count(*)::int AS n FROM accounts WHERE email_hash_v2 IS NULL AND email_enc IS NULL`,
);
console.log(`accounts to rehash: ${todo.rows[0].n}`);
if (orphans.rows[0].n) {
  // An account with no encrypted address cannot be rehashed by anything. It
  // keeps its v1 hash and goes on working; it is named here so that the
  // count of remaining rows never looks like an unfinished run.
  console.log(`accounts with no stored address (kept on v1): ${orphans.rows[0].n}`);
}
if (!apply) {
  console.log('dry run: nothing written. Pass --apply to write.');
  process.exit(0);
}

let done = 0;
let failed = 0;
for (;;) {
  const page = await pool.query(
    `SELECT id, data_key_enc, email_enc FROM accounts
      WHERE email_hash_v2 IS NULL AND email_enc IS NOT NULL
      ORDER BY id LIMIT $1`,
    [batch],
  );
  if (!page.rowCount) break;
  const before = done;
  for (const row of page.rows as { id: string; data_key_enc: Buffer; email_enc: Buffer }[]) {
    try {
      const { email } = await decryptFields(
        row.id,
        row.data_key_enc,
        { email: row.email_enc },
        { purpose: 'email-hash-rehash', actor: 'operator', refs: { account_id: row.id } },
      );
      if (!email) throw new Error('stored address is empty');
      await pool.query('UPDATE accounts SET email_hash_v2 = $2 WHERE id = $1', [
        row.id,
        emailHash(email),
      ]);
      done += 1;
    } catch (e: any) {
      // Never the address, and never the hash: an account that could not be
      // rehashed is named by its id and looked at by a person.
      failed += 1;
      console.error(`account ${row.id}: could not rehash (${e?.name ?? 'Error'})`);
    }
  }
  // A page that wrote nothing would come back identical next time round: a
  // failed account still has a NULL v2, so it is selected again forever. One
  // page with no progress on it is where this stops.
  if (done === before) {
    console.error('a whole page failed; stopping rather than looping on it');
    break;
  }
  console.log(`rehashed ${done}, failed ${failed}`);
}
console.log(`done: ${done} rehashed, ${failed} left for a human to look at`);
process.exit(failed ? 1 : 0);
