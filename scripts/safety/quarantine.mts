/**
 * Photos held rather than deleted, and what a person does about them
 * (src/safety/photoQuarantine.ts; migrations/038_photo_quarantine.sql;
 * docs/trust-and-safety.md, the "Sexual content" row).
 *
 *   DATABASE_URL=postgres://... npx tsx scripts/safety/quarantine.mts
 *   DATABASE_URL=postgres://... npx tsx scripts/safety/quarantine.mts --cleared <id>
 *   DATABASE_URL=postgres://... npx tsx scripts/safety/quarantine.mts --referred <id>
 *
 * WHY ANY OF THIS IS HELD. The photo check refuses anything sexual, and for
 * that family alone it does not delete: Rekognition says "Explicit", never "a
 * child", and under s 474.25 of the Criminal Code (Cth) a host that becomes
 * aware of child abuse material must refer it to the AFP. Deleting on sight
 * destroys what must be referred. So the bytes move to a quarantine prefix and
 * wait ninety days for a person.
 *
 * NO IMAGE IS SHOWN HERE, AND NONE IS FETCHED. This script prints ids, labels
 * and ages. It does not download, display, thumbnail or open an object, and
 * there is no code path in this repository that does. Looking at a held object
 * is a deliberate act outside this tool, and for the family this table holds,
 * looking at all may be the wrong thing to do rather than the careful one.
 *
 * DEV HELPER, like the rest of scripts/safety: it talks to a database over
 * DATABASE_URL, and against anything else an operator tunnels first.
 */
import { initDb } from '../../src/db.js';
import {
  clearQuarantineItem,
  listHeldQuarantine,
  referQuarantineItem,
} from '../../src/safety/photoQuarantine.js';
import type { Config } from '../../src/config.js';

const argv = process.argv.slice(2);
const clearedIdx = argv.indexOf('--cleared');
const referredIdx = argv.indexOf('--referred');

console.error('OpenSwitchboard photo quarantine');
console.error('--------------------------------');
console.error('Ids, labels and ages only. NO IMAGE IS DISPLAYED OR FETCHED BY THIS');
console.error('SCRIPT, and no path in this repository displays or fetches one. These are');
console.error('photos refused for sexual content and held rather than deleted, because');
console.error('what may have to be referred to police must still exist to be referred.');
console.error('');

if (!process.env.DATABASE_URL) {
  console.error('Set DATABASE_URL to the database these items live in.');
  process.exit(2);
}

await initDb({ dbSecretArn: '' } as unknown as Config);

if (clearedIdx >= 0 || referredIdx >= 0) {
  const cleared = clearedIdx >= 0;
  const flag = cleared ? '--cleared' : '--referred';
  const id = String(argv[(cleared ? clearedIdx : referredIdx) + 1] ?? '');
  if (!id) {
    console.error(`Usage: npx tsx scripts/safety/quarantine.mts ${flag} <quarantine-id>`);
    process.exit(2);
  }
  const done = cleared ? await clearQuarantineItem(id) : await referQuarantineItem(id);
  if (!done) {
    console.error(`Nothing held with id ${id}.`);
    process.exit(1);
  }
  if (cleared) {
    console.error(`Cleared: ${id}`);
    console.error('The object has been deleted. The row goes at its ninety days.');
  } else {
    console.error(`Marked referred: ${id}`);
    console.error('');
    console.error('THE REFERRAL IS YOURS TO MAKE. This software does not make it. Nothing here');
    console.error('contacts the AFP or the ACCCE; this only writes down that you did.');
    console.error('Make the referral (esafety.gov.au / accce.gov.au / the AFP), and DO NOT');
    console.error('DELETE THE OBJECT: it must still be there when it is asked for. A');
    console.error('referred item is never swept, at any age.');
  }
  process.exit(0);
}

const rows = await listHeldQuarantine();
if (!rows.length) {
  console.error('Nothing held.');
  process.exit(0);
}

const days = (d: Date) => Math.floor((Date.now() - new Date(d).getTime()) / 86_400_000);
const until = (d: Date) => Math.ceil((new Date(d).getTime() - Date.now()) / 86_400_000);
console.error(`${rows.length} held:`);
console.error('');
for (const r of rows) {
  console.error(`  ${r.id}`);
  // The one row in this list that is not a person's judgement call. It is
  // printed first and said plainly, because the next act is a referral rather
  // than a decision (docs/trust-and-safety.md, "A known-image match").
  if (r.hash_match) {
    console.error('    KNOWN IMAGE  matched a known abuse-image hash. REFER THIS. Sources: ' +
      ((r.hash_sources ?? []).join(', ') || '(none recorded)'));
  }
  console.error(`    labels       ${(r.labels ?? []).join(', ') || '(none recorded)'}`);
  console.error(`    introduction ${r.match_id ?? '(none)'}`);
  console.error(`    sender       ${r.sender_account ?? '(none)'}`);
  console.error(`    waiting      ${days(r.created_at)}d`);
  console.error(`    expiry       ${until(r.expires_at)}d away`);
  console.error('');
}
console.error('--cleared <id> deletes the object and marks it. --referred <id> marks it');
console.error('and keeps it forever. A held item past ninety days is never deleted by the');
console.error('sweep — it is logged as overdue until a person decides.');
process.exit(0);
