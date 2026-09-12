/**
 * Render every category phrase into the three sentences a person actually
 * meets, as one static page to read and correct:
 *   npx tsx scripts/render-category-phrases.ts [outFile]
 * Writes docs/category-phrases.html by default. No JavaScript on the page and
 * no styling that assumes a light screen, so it reads the same either way.
 *
 * The phrases themselves live in the schema repo's data/taxonomy.v2.json. To
 * change one, change it there and run this again.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadTaxonomy } from '@openswitchboard/schema';
import {
  categoryLeafLabel,
  categoryPhrase,
  categoryPhraseIsCountable,
  categoryPhraseWithArticle,
} from '../src/domain/matchRules.js';
import { aboutThing, offerAmountInWords } from '../src/email/templates.js';

const FIGURE = offerAmountInWords(420, 'AUD');

const esc = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function main(): void {
  const taxonomy = loadTaxonomy() as unknown as {
    nodes: Record<
      string,
      { label: string; phrase?: string; countable?: boolean; article?: string; status?: string }
    >;
  };
  const paths = Object.keys(taxonomy.nodes);
  const leaves = paths.filter(
    (p) =>
      taxonomy.nodes[p].status !== 'reserved' && !paths.some((o) => o !== p && o.startsWith(`${p}.`)),
  );

  const rows = leaves
    .map((path) => {
      const thing = categoryPhrase(path);
      const said = categoryPhraseWithArticle(path);
      const kind = categoryPhraseIsCountable(path) ? '' : ' <span class="tag">no article</span>';
      return `<tr>
<td class="id">${esc(path)}${kind}</td>
<td class="label">${esc(categoryLeafLabel(path))}</td>
<td class="said">
<div>Someone has come forward about your <b>${esc(thing)}</b>.</div>
<div>Someone has come back with ${esc(FIGURE)}${esc(aboutThing(thing, 'want'))}.</div>
<div>Someone nearby is keen on <b>${esc(said)}</b>.</div>
</td>
</tr>`;
    })
    .join('\n');

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Category phrases</title>
<style>
  :root { color-scheme: light dark; --ink: #17181a; --dim: #6b6f76; --rule: #d8dade; --ground: #ffffff; --band: #f5f6f8; }
  @media (prefers-color-scheme: dark) {
    :root { --ink: #e9eaec; --dim: #9aa0a8; --rule: #34373c; --ground: #17181a; --band: #1e2024; }
  }
  html { background: var(--ground); }
  body { margin: 0; padding: 32px 20px 64px; background: var(--ground); color: var(--ink);
         font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; }
  .wrap { max-width: 1080px; margin: 0 auto; }
  h1 { font-size: 26px; font-weight: 600; margin: 0 0 8px; }
  p.lead { color: var(--dim); margin: 0 0 6px; max-width: 62ch; }
  .count { color: var(--dim); font-size: 13px; margin: 18px 0 10px; }
  .scroll { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; vertical-align: top; padding: 10px 12px; border-bottom: 1px solid var(--rule); }
  th { font-size: 12px; letter-spacing: 1px; text-transform: uppercase; color: var(--dim); font-weight: 600; }
  tr:nth-child(even) td { background: var(--band); }
  td.id { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: var(--dim); white-space: nowrap; }
  td.label { white-space: nowrap; color: var(--dim); }
  td.said div { margin: 0 0 3px; }
  td.said div:last-child { margin-bottom: 0; }
  b { font-weight: 600; }
  .tag { display: inline-block; margin-left: 6px; font-family: inherit; font-size: 10px;
         letter-spacing: .5px; text-transform: uppercase; color: var(--dim); border: 1px solid var(--rule);
         border-radius: 3px; padding: 0 4px; }
</style>
</head>
<body>
<div class="wrap">
<h1>Category phrases</h1>
<p class="lead">A label is a heading. A phrase is what a person says in the middle of a sentence. Every open leaf in the taxonomy carries one, and these are the three sentences it lands in.</p>
<p class="lead">If a line reads wrong when you say it out loud, the phrase is what to change: it lives on the leaf in <code>data/taxonomy.v2.json</code> in the schema repo.</p>
<p class="count">${leaves.length} categories.</p>
<div class="scroll">
<table>
<thead><tr><th>Category</th><th>Heading</th><th>How it reads</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
</div>
</div>
</body>
</html>
`;

  const out = process.argv[2] ?? join('docs', 'category-phrases.html');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, html);
  console.log(`wrote ${out} (${leaves.length} categories)`);
}

main();
