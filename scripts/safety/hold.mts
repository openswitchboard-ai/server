/**
 * The two marks that keep a safety record past its time: a referral to police,
 * and a lawful preservation hold (src/safety/retention.ts,
 * src/safety/photoQuarantine.ts; migrations/059_safety_retention.sql).
 *
 *   DATABASE_URL=postgres://... npx tsx scripts/safety/hold.mts --referred report <id>
 *   DATABASE_URL=postgres://... npx tsx scripts/safety/hold.mts --referred review <id>
 *   DATABASE_URL=postgres://... npx tsx scripts/safety/hold.mts --preserve report|review|photo <id> [--days 365]
 *
 * A report and a safety flag are deleted at twelve months, and a held photo at
 * ninety days, unless one of these is on them. A referred photo is marked with
 * scripts/safety/quarantine.mts --referred, as before.
 *
 * NOTHING IS READ OR SHOWN HERE. It moves a date or writes down that a person
 * made a referral. The referral itself is theirs to make: nothing in this
 * repository contacts the police.
 *
 * DEV HELPER, like the rest of scripts/safety: it talks to a database over
 * DATABASE_URL, and against anything else an operator tunnels first.
 */
import { initDb } from '../../src/db.js';
import { markReferred, preserveSafetyRecord } from '../../src/safety/retention.js';
import { preserveQuarantineItem } from '../../src/safety/photoQuarantine.js';
import type { Config } from '../../src/config.js';

const argv = process.argv.slice(2);
const referredIdx = argv.indexOf('--referred');
const preserveIdx = argv.indexOf('--preserve');
const daysIdx = argv.indexOf('--days');
const days = daysIdx >= 0 ? Number(argv[daysIdx + 1]) : 365;
const at = referredIdx >= 0 ? referredIdx : preserveIdx;
const kind = String(argv[at + 1] ?? '');
const id = String(argv[at + 2] ?? '');

const usage = () => {
  console.error('Usage: npx tsx scripts/safety/hold.mts --referred report|review <id>');
  console.error('       npx tsx scripts/safety/hold.mts --preserve report|review|photo <id> [--days 365]');
  process.exit(2);
};

if (at < 0 || !id) usage();
if (referredIdx >= 0 && kind !== 'report' && kind !== 'review') usage();
if (preserveIdx >= 0 && !['report', 'review', 'photo'].includes(kind)) usage();
if (!Number.isFinite(days) || days <= 0) usage();
if (!process.env.DATABASE_URL) {
  console.error('Set DATABASE_URL to the database these records live in.');
  process.exit(2);
}

await initDb({ dbSecretArn: '' } as unknown as Config);

if (referredIdx >= 0) {
  const done = await markReferred(kind === 'report' ? 'reports' : 'safety_reviews', id);
  console.error(done ? `Marked referred: ${kind} ${id}. It is kept past its twelve months.` : `Nothing to mark for ${kind} ${id}.`);
  process.exit(done ? 0 : 1);
}

const until = new Date(Date.now() + days * 86_400_000);
const done =
  kind === 'photo'
    ? await preserveQuarantineItem(id, until)
    : await preserveSafetyRecord(kind === 'report' ? 'reports' : 'safety_reviews', id, until);
console.error(done ? `Held ${kind} ${id} until ${until.toISOString()}.` : `Nothing to hold for ${kind} ${id}.`);
process.exit(done ? 0 : 1);
