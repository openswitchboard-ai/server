/**
 * The freeze half of a lawful request: hold named ledger entries past the
 * thirty days, without anybody reading them.
 *
 *   DATABASE_URL=postgres://... npx tsx scripts/safety/preserve.mts \
 *     --days 90 <entry-id> [<entry-id> ...]
 *
 * DEV HELPER. It talks to a database over DATABASE_URL, which is the local
 * harness path; against anything else an operator tunnels first. No keyholder
 * is involved and no key is touched — preserving and reading are different
 * acts with different authority behind them, and this is the one that only
 * moves a date.
 */
import { initDb } from '../../src/db.js';
import { preserveEntries } from '../../src/safety/ledger.js';
import type { Config } from '../../src/config.js';

const argv = process.argv.slice(2);
const dayIdx = argv.indexOf('--days');
const days = dayIdx >= 0 ? Number(argv[dayIdx + 1]) : 90;
const ids = argv.filter((a, i) => !a.startsWith('--') && i !== dayIdx + 1);

console.error('OpenSwitchboard ledger preservation');
console.error('-----------------------------------');
console.error(`About to hold ${ids.length} entr${ids.length === 1 ? 'y' : 'ies'} for ${days} days`);
console.error('past today, by moving preserved_until forward. Nothing is decrypted, nothing');
console.error('is read, and no keyholder is needed for this.');
console.error('');

if (!ids.length || !Number.isFinite(days) || days <= 0) {
  console.error('Usage: npx tsx scripts/safety/preserve.mts --days 90 <entry-id> [...]');
  process.exit(2);
}
if (!process.env.DATABASE_URL) {
  console.error('Set DATABASE_URL to the database this ledger lives in.');
  process.exit(2);
}

// initDb takes DATABASE_URL straight when it is set; nothing else on the
// config is read on that path.
await initDb({ dbSecretArn: '' } as unknown as Config);
const until = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
const r = await preserveEntries(ids, until);
console.error(`Held ${r.preserved} of ${ids.length} until ${until.toISOString()}.`);
process.exit(0);
