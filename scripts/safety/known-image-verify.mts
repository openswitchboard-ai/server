/**
 * Build-time check of the known-image module directory
 * (src/safety/knownImageCheck.ts).
 *
 *   node dist/scripts/safety/known-image-verify.mjs [dir]      (in the image)
 *   npx tsx scripts/safety/known-image-verify.mts [dir]        (from a checkout)
 *
 * NOTHING THERE but the README: exits 0 and says the check will be off. That
 * is a build without a module, such as a fork's, and it is allowed.
 *
 * ANYTHING THERE: the module must load, say the contract and pass its own
 * self-check, or it exits 1. A deployment that carries a module that cannot
 * work would hold every photo, so that has to stop the build instead.
 */
import { verifyKnownImageModule } from '../../src/safety/knownImageCheck.js';

const dir = process.argv[2] ?? process.env.KNOWN_IMAGE_MODULE_DIR ?? 'vendor/known-image';

try {
  const r = await verifyKnownImageModule(dir);
  if (!r.present) {
    console.log(`known-image-verify: no module in ${dir}; the known-image check will be off`);
  } else {
    console.log(`known-image-verify: the module in ${dir} verifies${r.label ? ` (${r.label})` : ''}`);
  }
} catch (e: any) {
  console.error(
    `known-image-verify: ${dir} has files in it but no module that verifies (${e?.code ?? e?.name ?? 'Error'}). Refusing to build.`,
  );
  process.exit(1);
}
