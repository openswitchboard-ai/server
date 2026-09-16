/**
 * The safety key ceremony, first half: make the key, split it, walk away.
 *
 *   npx tsx scripts/safety/generate.mts share-a.txt share-b.txt share-c.txt
 *
 * Run this ONCE per environment, on a machine that is not a server, with the
 * three people who will hold the shares in the room. It prints the public half
 * for whoever wires the parameter store, and writes three share files at the
 * paths you name. The private key is never written whole and never printed: it
 * exists for the few milliseconds between being made and being split.
 *
 * Any two of the three shares open the ledger. One opens nothing.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { generateSafetyKeypair, zeroize } from '../../src/safety/keys.js';
import { SHARES, THRESHOLD, shareFile, splitPrivateKey } from '../../src/safety/ceremony.js';

const paths = process.argv.slice(2);

console.error('OpenSwitchboard safety key ceremony');
console.error('-----------------------------------');
console.error('About to:');
console.error('  1. make a fresh X25519 safety keypair in memory;');
console.error('  2. print the PUBLIC half to stdout, for SAFETY_PUBLIC_KEY;');
console.error(`  3. split the private half ${THRESHOLD}-of-${SHARES} and write one share to each`);
console.error('     of the files you named;');
console.error('  4. overwrite the private key in memory and exit.');
console.error('The private half is never written whole and never printed.');
console.error('');

if (paths.length !== SHARES) {
  console.error(`Name ${SHARES} files to write the shares to, for example:`);
  console.error('  npx tsx scripts/safety/generate.mts share-a.txt share-b.txt share-c.txt');
  process.exit(2);
}
for (const p of paths) {
  if (existsSync(p)) {
    console.error(`${p} already exists. Refusing to overwrite a share file.`);
    process.exit(2);
  }
}

const key = generateSafetyKeypair();
console.error(`Fingerprint: ${key.fingerprint}`);
console.error('');

const shares = splitPrivateKey(key.privateRaw);
zeroize(key.privateRaw);
shares.forEach((share, i) => {
  writeFileSync(paths[i]!, shareFile(share, key.fingerprint), { mode: 0o600 });
  console.error(`Share ${share.index} written to ${paths[i]}`);
  zeroize(share.y);
});

console.error('');
console.error('The public half follows on stdout. Put it in SAFETY_PUBLIC_KEY.');
console.error('Hand each share file to a different keyholder, then delete it from here.');
console.error('');
process.stdout.write(key.publicPem);
