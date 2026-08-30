/**
 * Render every sample email (HTML part) to PNG for visual review:
 *   npx tsx scripts/render-email-screens.ts [outDir]
 * Writes <outDir>/<name>.html and <outDir>/<name>.png (default
 * e2e-screenshots/emails). Uses the repo's Playwright chromium.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { sampleSet } from './emailSamples.js';

async function main() {
  const outDir = process.argv[2] ?? join('e2e-screenshots', 'emails');
  mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 700, height: 900 } });
  for (const s of sampleSet()) {
    const htmlPath = join(outDir, `${s.name}.html`);
    writeFileSync(htmlPath, s.content.html);
    writeFileSync(join(outDir, `${s.name}.txt`), `Subject: ${s.content.subject}\n\n${s.content.text}`);
    await page.setContent(s.content.html, { waitUntil: 'networkidle' });
    await page.screenshot({ path: join(outDir, `${s.name}.png`), fullPage: true });
    console.log(`rendered ${s.name}`);
  }
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
