/**
 * The two-keyholder ceremony: the only way anything in the ledger becomes
 * words again.
 *
 *   DATABASE_URL=postgres://... npx tsx scripts/safety/export.mts \
 *     --share share-a.txt --share share-b.txt \
 *     --out ./bundle-2026-09-17 \
 *     [--id <entry-id> ...] [--introduction <id>] [--from 2026-09-01] [--to 2026-09-17]
 *
 * Two keyholders, two share files, one room. The private key is put back in
 * memory, used, and overwritten; it is never written to disk and never leaves
 * this process. What comes out is a directory with one JSON file per entry, a
 * manifest, and SHA256SUMS over the lot, so that what was handed over can be
 * shown later to be exactly what was handed over.
 *
 * `--introduction` takes the id of one introduction. It is the ordinary case:
 * a report names an introduction, not a list of entries.
 */
import { existsSync, readFileSync } from 'node:fs';
import { initDb, getPool } from '../../src/db.js';
import {
  exportBundle,
  parseShareFile,
  privateKeyFromShares,
  rowQuery,
  THRESHOLD,
  type ExportQuery,
  type LedgerRow,
} from '../../src/safety/ceremony.js';
import type { Config } from '../../src/config.js';

const argv = process.argv.slice(2);
const many = (name: string): string[] =>
  argv.flatMap((a, i) => (a === `--${name}` && argv[i + 1] ? [argv[i + 1]!] : []));
const one = (name: string): string | undefined => many(name)[0];

const shareFiles = many('share');
const out = one('out');
const query: ExportQuery = {
  ...(many('id').length ? { ids: many('id') } : {}),
  ...(one('introduction') ? { match_id: one('introduction')! } : {}),
  ...(one('from') ? { from: new Date(one('from')!) } : {}),
  ...(one('to') ? { to: new Date(one('to')!) } : {}),
};

console.error('OpenSwitchboard ledger export — two-keyholder ceremony');
console.error('------------------------------------------------------');
console.error('About to:');
console.error(`  1. read ${shareFiles.length} share file(s) and check they name the same key;`);
console.error('  2. put the safety private key back together IN MEMORY ONLY;');
console.error('  3. read the entries asked for out of the ledger;');
console.error('  4. decrypt them and write a bundle, with a manifest and SHA256SUMS;');
console.error('  5. overwrite the key material and exit.');
console.error('Nothing is written to disk but the bundle.');
console.error('');

if (shareFiles.length < THRESHOLD || !out) {
  console.error(`Give ${THRESHOLD} --share files and an --out directory.`);
  process.exit(2);
}
if (!query.ids && !query.match_id && !query.from && !query.to) {
  console.error('Name what to export: --id, --introduction, or --from/--to.');
  process.exit(2);
}
if (existsSync(out)) {
  console.error(`${out} already exists. Name a directory that does not, so a bundle is never`);
  console.error('quietly mixed with another one.');
  process.exit(2);
}
if (!process.env.DATABASE_URL) {
  console.error('Set DATABASE_URL to the database this ledger lives in.');
  process.exit(2);
}

const shares = shareFiles.map((p) => parseShareFile(readFileSync(p, 'utf8')));
const privateKey = privateKeyFromShares(shares);
for (const s of shares) s.y.fill(0);
console.error(`Key rebuilt from shares ${shares.map((s) => s.index).join(' and ')}.`);

// initDb takes DATABASE_URL straight when it is set; nothing else on the
// config is read on that path.
await initDb({ dbSecretArn: '' } as unknown as Config);
const { sql, params } = rowQuery(query);
const rows = (await getPool().query(sql, params)).rows as LedgerRow[];
console.error(`${rows.length} entr${rows.length === 1 ? 'y' : 'ies'} to decrypt.`);

const bundle = await exportBundle({
  rows,
  privateKey,
  outDir: out,
  query,
  shareIndices: shares.map((s) => s.index),
});

console.error('');
console.error(`Bundle: ${bundle.dir}`);
console.error(`Entries: ${bundle.entries}`);
console.error(`Bundle hash (SHA-256 of SHA256SUMS): ${bundle.hash}`);
console.error('');
console.error('Both keyholders should sign this hash. Put the shares back where they live.');
process.exit(0);
