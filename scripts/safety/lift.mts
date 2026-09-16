/**
 * Lift a suspension (docs/trust-and-safety.md, "Enforcement").
 *
 *   DATABASE_URL=postgres://... npx tsx scripts/safety/lift.mts <account-id>
 *
 * The flag comes off and the address is let go in the same act, so the person
 * can sign in and use the switchboard again. What came down STAYS down: their
 * wants and haves were withdrawn and putting them back up without asking is
 * not the switchboard's to do, so tell them to post again.
 *
 * DEV HELPER, like the rest of scripts/safety.
 */
import { initDb, getPool } from '../../src/db.js';
import { liftSuspension } from '../../src/safety/suspend.js';
import type { Config } from '../../src/config.js';

const argv = process.argv.slice(2);
const accountId = argv.find((a) => !a.startsWith('--'));

console.error('OpenSwitchboard: lifting a suspension');
console.error('-------------------------------------');

if (!accountId) {
  console.error('Usage: npx tsx scripts/safety/lift.mts <account-id>');
  process.exit(2);
}
if (!process.env.DATABASE_URL) {
  console.error('Set DATABASE_URL to the database this account lives in.');
  process.exit(2);
}

await initDb({ dbSecretArn: '' } as unknown as Config);
const before = await getPool().query(
  'SELECT suspended_at, suspended_reason FROM accounts WHERE id = $1',
  [accountId],
);
if (!before.rowCount) {
  console.error(`No account with id ${accountId}.`);
  process.exit(1);
}
if (!before.rows[0].suspended_at) {
  console.error('That account is not suspended. Nothing done.');
  process.exit(0);
}
console.error(`Suspended since: ${new Date(before.rows[0].suspended_at).toISOString()}`);
console.error(`Reason on file:  ${before.rows[0].suspended_reason ?? '(none written)'}`);

const r = await liftSuspension(accountId);
console.error('');
console.error(`Lifted:          ${r.lifted ? 'yes' : 'it was not suspended'}`);
console.error('Their wants and haves stay down: ask them to post again if they want to.');
process.exit(0);
