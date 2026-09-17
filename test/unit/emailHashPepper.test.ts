/**
 * A hashed email address is not a hidden one.
 *
 * `email_hash` was a bare SHA-256 of the lowercased address, and for email
 * addresses that is not much of a hash: the plausible space is a few billion
 * real addresses, the leaked-credential corpora everybody has are lists of
 * exactly those, and an afternoon on a laptop puts a name to every row. Three
 * tables key on it — who has an account, whose account was stopped, whose
 * address bounced or complained — so what a copy of the database gave away was
 * a membership list, a moderation record and a deliverability record.
 *
 * The fix costs no new secret: the counter already refuses to boot without a
 * 32-byte HMAC key, and HKDF gives an independent pepper from it. The
 * dictionary attack now needs the key as well as the corpus, and the key is not
 * in the database.
 *
 * WHAT IS PROVED HERE, against a fixed key so the digests are stable:
 *   - v2 is the HMAC under the derived pepper, and v1 is untouched — because
 *     v1 is what is already written down and cannot be recomputed;
 *   - two different keys give two different hashes of the same address, which
 *     is the whole of what a pepper buys;
 *   - every lookup asks v2 and falls back to v1, in one statement;
 *   - the tables that can be rehashed are, and the one that cannot keeps both.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createHash, createHmac, hkdfSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { initCounterKeys } from '../../src/counter/keys.js';
import { emailHash, emailHashV1, emailHashes } from '../../src/domain/accounts.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(join(here, '..', '..', 'src', p), 'utf8');

const KEY_HEX = 'ab'.repeat(32);

beforeAll(async () => {
  process.env.COUNTER_LINK_HMAC_KEY = KEY_HEX;
  process.env.COUNTER_COOKIE_KEY = 'cd'.repeat(32);
  await initCounterKeys({} as any);
});

describe('the pepper, from the key the counter already has', () => {
  it('is HKDF-SHA256 of the link key under one named info string', () => {
    const pepper = Buffer.from(
      hkdfSync('sha256', Buffer.from(KEY_HEX, 'hex'), Buffer.alloc(0), 'email-hash-pepper-v1', 32),
    );
    const expected = createHmac('sha256', pepper).update('a@b.test').digest('hex');
    expect(emailHash('a@b.test')).toBe(expected);
    // Same normalisation as v1 always had: trimmed and lowercased.
    expect(emailHash('  A@B.Test ')).toBe(expected);
  });

  it('leaves v1 exactly as it was, because v1 is already written down', () => {
    expect(emailHashV1('a@b.test')).toBe(
      createHash('sha256').update('a@b.test').digest('hex'),
    );
    expect(emailHash('a@b.test')).not.toBe(emailHashV1('a@b.test'));
  });

  it('gives a different answer under a different key, which is the whole point', () => {
    // A deployment keyed differently hashes the same address differently, so
    // one stolen table says nothing about another — and a dictionary built
    // against either is worth nothing without the key.
    const other = Buffer.from(
      hkdfSync('sha256', Buffer.from('ef'.repeat(32), 'hex'), Buffer.alloc(0), 'email-hash-pepper-v1', 32),
    );
    expect(createHmac('sha256', other).update('a@b.test').digest('hex')).not.toBe(
      emailHash('a@b.test'),
    );
  });

  it('hands both spellings out together, for the tables that hold some of each', () => {
    const both = emailHashes('a@b.test');
    expect(both.v2).toBe(emailHash('a@b.test'));
    expect(both.v1).toBe(emailHashV1('a@b.test'));
  });
});

describe('every lookup asks v2 and takes v1 as the fallback', () => {
  const pairs: [string, string][] = [
    ['domain/accounts.ts', 'findAccountByEmail'],
    ['domain/accounts.ts', 'createAccount'],
    ['domain/counterOps.ts', 'createPendingAccount'],
    ['safety/suspend.ts', 'emailIsSuspended'],
    ['workers/emailEventsWorker.ts', 'accountIdForEmail'],
  ];

  for (const [file, fn] of pairs) {
    it(`${fn} looks for either spelling`, () => {
      const src = read(file);
      const body = src.slice(src.indexOf(fn));
      const scope = body.slice(0, body.indexOf('\n}\n'));
      expect(scope).toMatch(/email_hash_v2 = \$1 OR email_hash = \$2/);
    });
  }

  it('writes both on every table a new row can go into', () => {
    expect(read('domain/accounts.ts')).toContain('email_hash, email_hash_v2, email_enc');
    expect(read('domain/counterOps.ts')).toContain('email_hash, email_hash_v2, email_enc');
    // suspended_emails has the plaintext in hand at the moment it writes, so
    // it writes both and can be looked up by either for good.
    expect(read('safety/suspend.ts')).toContain(
      'INSERT INTO suspended_emails (email_hash, email_hash_v2)',
    );
  });

  it('takes an address off the suspended list under either spelling', () => {
    const src = read('safety/suspend.ts');
    expect(src).toContain(
      "'DELETE FROM suspended_emails WHERE email_hash_v2 = $1 OR email_hash = $2'",
    );
  });
});

describe('the changeover has an end, and it is written down', () => {
  it('adds the columns and the index the code expects', () => {
    const migration = readFileSync(
      join(here, '..', '..', 'migrations', '043_dispute_integrity.sql'),
      'utf8',
    );
    expect(migration).toContain('ALTER TABLE accounts\n  ADD COLUMN IF NOT EXISTS email_hash_v2');
    expect(migration).toContain(
      'ALTER TABLE suspended_emails\n  ADD COLUMN IF NOT EXISTS email_hash_v2',
    );
    // One account per address still, on the new column as on the old.
    expect(migration).toContain('CREATE UNIQUE INDEX IF NOT EXISTS accounts_email_hash_v2');
  });

  it('ships a script that fills v2 from the address each account already holds', () => {
    const script = readFileSync(
      join(here, '..', '..', 'scripts', 'ops', 'rehash-emails.mts'),
      'utf8',
    );
    // A dry run by default: a job that reads every address on the switchboard
    // does not start because somebody typed the command to see what it was.
    expect(script).toContain("const apply = process.argv.includes('--apply')");
    expect(script).toContain('email_hash_v2 IS NULL');
    expect(script).toContain("purpose: 'email-hash-rehash'");
    // Never the address and never the hash in an error line.
    expect(script).toContain("e?.name ?? 'Error'");
    const pkg = JSON.parse(readFileSync(join(here, '..', '..', 'package.json'), 'utf8'));
    expect(pkg.scripts['rehash-emails']).toContain('scripts/ops/rehash-emails.mts');
  });

  it('says in the runbook what to run and what may be dropped afterwards', () => {
    const doc = readFileSync(
      join(here, '..', '..', 'docs', 'trust-and-safety.md'),
      'utf8',
    );
    expect(doc).toContain('npm run rehash-emails -- --apply');
    expect(doc).toContain('email-hash-pepper-v1');
    expect(doc).toContain('may drop `accounts.email_hash`');
    expect(doc).toContain('`suspended_emails` keeps both, permanently');
  });
});
