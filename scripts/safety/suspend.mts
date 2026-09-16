/**
 * Stop an account: nothing in, nothing out
 * (docs/trust-and-safety.md, "Enforcement").
 *
 *   DATABASE_URL=postgres://... npx tsx scripts/safety/suspend.mts \
 *     --reason "what happened, for whoever lifts this" <account-id>
 *
 * It PRINTS WHAT IT WILL DO FIRST and asks, because this is the one operator
 * act that reaches into somebody's live conversations: their wants and haves
 * come down, every open introduction of theirs is closed with the other side
 * told only that the switchboard closed it, and the address cannot open a new
 * account until the suspension is lifted.
 *
 * The reason is written on the account for whoever lifts it. It is never
 * served to an agent, never emailed and never shown on a page.
 *
 * DEV HELPER, like the rest of scripts/safety: it talks to a database over
 * DATABASE_URL, and against anything else an operator tunnels first.
 */
import { createInterface } from 'node:readline/promises';
import { initDb, getPool } from '../../src/db.js';
import { suspendAccount } from '../../src/safety/suspend.js';
import type { Config } from '../../src/config.js';

const argv = process.argv.slice(2);
const reasonIdx = argv.indexOf('--reason');
const reason = reasonIdx >= 0 ? String(argv[reasonIdx + 1] ?? '') : '';
const yes = argv.includes('--yes');
const accountId = argv.find((a, i) => !a.startsWith('--') && i !== reasonIdx + 1);

console.error('OpenSwitchboard account suspension');
console.error('----------------------------------');

if (!accountId || !reason.trim()) {
  console.error('Usage: npx tsx scripts/safety/suspend.mts --reason "<why>" <account-id> [--yes]');
  process.exit(2);
}
if (!process.env.DATABASE_URL) {
  console.error('Set DATABASE_URL to the database this account lives in.');
  process.exit(2);
}

await initDb({ dbSecretArn: '' } as unknown as Config);

// What it will do, before it does any of it.
const pool = getPool();
const live = await pool.query(
  `SELECT count(*)::int AS n FROM cards
    WHERE account_id = $1 AND lifecycle_state IN ('PENDING_SCREENING', 'PUBLISHED')`,
  [accountId],
);
const open = await pool.query(
  `SELECT count(*)::int AS n FROM matches
    WHERE (account_want = $1 OR account_have = $1) AND state = 'open'`,
  [accountId],
);
const already = await pool.query('SELECT suspended_at FROM accounts WHERE id = $1', [accountId]);
if (!already.rowCount) {
  console.error(`No account with id ${accountId}.`);
  process.exit(1);
}

console.error(`Account:               ${accountId}`);
console.error(`Already suspended:     ${already.rows[0].suspended_at ? 'yes' : 'no'}`);
console.error(`Wants and haves down:  ${live.rows[0].n}`);
console.error(`Introductions closed:  ${open.rows[0].n}`);
console.error('Their address is remembered, so it cannot open another account.');
console.error('The other side of each introduction is told only that the switchboard closed it.');
console.error(`Reason (operator-facing only): ${reason.trim()}`);
console.error('');

if (!yes) {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const said = await rl.question('Type "suspend" to go ahead: ');
  rl.close();
  if (said.trim() !== 'suspend') {
    console.error('Nothing done.');
    process.exit(1);
  }
}

const r = await suspendAccount(accountId, reason.trim());
console.error('');
console.error(`Suspended:             ${r.newly_suspended ? 'now' : 'it already was'}`);
console.error(`Wants and haves down:  ${r.postings_withdrawn}`);
console.error(`Introductions closed:  ${r.introductions_severed}`);
console.error(`Address remembered:    ${r.email_remembered ? 'yes' : 'no'}`);
process.exit(0);
