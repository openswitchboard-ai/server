/**
 * The safety review queue: what a machine flagged and nobody has looked at yet
 * (docs/trust-and-safety.md, "The checks" and "Verdicts, and how much of
 * review is automatic").
 *
 *   DATABASE_URL=postgres://... npx tsx scripts/safety/reviews.mts
 *   DATABASE_URL=postgres://... npx tsx scripts/safety/reviews.mts --reviewed <id>
 *   DATABASE_URL=postgres://... npx tsx scripts/safety/reviews.mts --dismissed <id>
 *
 * NO CONTENT IS SHOWN HERE, AND NONE CAN BE. What this prints is ids, flag
 * names and ages. The words behind a review are in the ledger, sealed to a key
 * this service does not hold, and the only way to read them is the
 * two-keyholder export ceremony (scripts/safety/export.mts) against the ledger
 * entry id printed beside each line. That is the whole point of the split:
 * seeing that something needs looking at is an ordinary operator act, and
 * reading a private message is not.
 *
 * DEV HELPER, like the rest of scripts/safety: it talks to a database over
 * DATABASE_URL, and against anything else an operator tunnels first.
 */
import { initDb } from '../../src/db.js';
import { listOpenReviews, resolveReview } from '../../src/safety/reviews.js';
import type { Config } from '../../src/config.js';

const argv = process.argv.slice(2);
const reviewedIdx = argv.indexOf('--reviewed');
const dismissedIdx = argv.indexOf('--dismissed');

console.error('OpenSwitchboard safety review queue');
console.error('-----------------------------------');
console.error('Ids, flags and ages only. No message text is shown here, and none is');
console.error('available to this script: the words are sealed in the ledger and are read');
console.error('only through the two-keyholder ceremony (scripts/safety/export.mts).');
console.error('');

if (!process.env.DATABASE_URL) {
  console.error('Set DATABASE_URL to the database these reviews live in.');
  process.exit(2);
}

await initDb({ dbSecretArn: '' } as unknown as Config);

if (reviewedIdx >= 0 || dismissedIdx >= 0) {
  const status = reviewedIdx >= 0 ? 'reviewed' : 'dismissed';
  const id = String(argv[(reviewedIdx >= 0 ? reviewedIdx : dismissedIdx) + 1] ?? '');
  if (!id) {
    console.error(`Usage: npx tsx scripts/safety/reviews.mts --${status} <review-id>`);
    process.exit(2);
  }
  const done = await resolveReview(id, status);
  console.error(done ? `Marked ${status}: ${id}` : `Nothing open with id ${id}.`);
  process.exit(done ? 0 : 1);
}

const rows = await listOpenReviews();
if (!rows.length) {
  console.error('Nothing open.');
  process.exit(0);
}

const hours = (d: Date) => Math.floor((Date.now() - new Date(d).getTime()) / 3600_000);
console.error(`${rows.length} open:`);
console.error('');
for (const r of rows) {
  console.error(`  ${r.id}`);
  console.error(`    flags        ${(r.flags ?? []).join(', ') || '(none recorded)'}`);
  console.error(`    introduction ${r.match_id ?? '(none)'}`);
  console.error(`    sender       ${r.sender_account ?? '(none)'}`);
  console.error(`    ledger entry ${r.ledger_entry_id ?? '(nothing kept)'}`);
  console.error(`    waiting      ${hours(r.created_at)}h`);
  console.error('');
}
console.error('To read the words behind one, take its ledger entry id to the ceremony.');
process.exit(0);
