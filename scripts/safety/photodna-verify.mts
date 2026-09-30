/**
 * Build-time check of the PhotoDNA SDK directory (src/safety/photodna.ts).
 * OpenSwitchboard uses PhotoDNA technology licensed by Microsoft at no cost.
 *
 *   node dist/scripts/safety/photodna-verify.mjs [dir]      (in the image)
 *   npx tsx scripts/safety/photodna-verify.mts [dir]        (from a checkout)
 *
 * NOTHING THERE: exits 0 and says the check will be off. That is a build
 * without a licence, such as a fork's, and it is allowed.
 *
 * ANYTHING THERE: the manifest must match its pinned SHA-256 (or
 * PHOTODNA_MANIFEST_SHA256 where a fork sets its own) and each file must match
 * the manifest, or it exits 1. A deployment that carries the SDK and cannot
 * load it would hold every photo, so that has to stop the build instead.
 *
 * It prints the SDK version and nothing else about the files.
 */
import { readdir } from 'node:fs/promises';
import {
  PHOTODNA_MANIFEST_SHA256,
  verifyPhotoDnaSdk,
} from '../../src/safety/photodna.js';

const dir = process.argv[2] ?? process.env.PHOTODNA_SDK_DIR ?? 'vendor/photodna';
const present = (await readdir(dir).catch(() => [] as string[])).filter(
  (n) => n.toLowerCase() !== 'readme.md',
);

if (!present.length) {
  console.log(`photodna-verify: no SDK in ${dir}; the known-image check will be off`);
  process.exit(0);
}

try {
  const m = await verifyPhotoDnaSdk(dir, process.env.PHOTODNA_MANIFEST_SHA256 || PHOTODNA_MANIFEST_SHA256);
  console.log(`photodna-verify: SDK ${m.version} in ${dir} matches its pinned manifest`);
} catch (e: any) {
  console.error(
    `photodna-verify: ${dir} has SDK files but they do not verify (${e?.code ?? e?.name ?? 'Error'}). ` +
      'A missing manifest.json, a manifest that is not the pinned one, or a file that is not the one the manifest names. Refusing to build.',
  );
  process.exit(1);
}
