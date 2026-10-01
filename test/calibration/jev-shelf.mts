/**
 * Jev's shelf choice at the door, calibrated: `npm run calibrate-shelf`.
 *
 * Runs the publish door's own decision (categoryBackfill.snapCategory with
 * askWhenUnsure) over a labelled set of postings twice: the rules alone, and
 * with Jev's shelf choice (jevShelf.chooseShelfWithJev) exactly as the door
 * wires it. Embeds with the production model, so it needs AWS; Jev's answers
 * are cached in .jev-shelf-cache.json (gitignored), keyed by the exact state
 * and question sent, and called with the dev key (osb/dev/jev, never printed)
 * only for questions not in the cache. --no-call uses the cache only.
 *
 * The set is evaluation data and not in this repository: OSB_SHELF_SET, or
 * server/test/calibration/shelf-set.json under OSB_INTERNAL_DIR or ../internal.
 * Each entry: {id, as_posted, kind, attributes, right: [nodes] | "none_of_these"}.
 * A filing is RIGHT where the matcher would let it meet the labelled node
 * (matchRules.categoryCompatible: the same node, its ancestor line, or a
 * sibling), and never where it is a bare top level, which is reported apart.
 *
 * Bars (founder, 1 October 2026): decided answers on the right shelf >= 95%;
 * wrong top-level crossings 0; closed shelves picked 0; "none of these"
 * precision >= 90%; SHELF_UNCLEAR down >= 40%; Jev p95 latency < 600 ms.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { snapCategory, type SnapDecision } from '../../src/domain/categoryBackfill.js';
import { warmCategoryCorpus } from '../../src/domain/categorySuggest.js';
import { JEV_SHELF_TIMEOUT_MS, chooseShelfWithJev, type JevShelfRequest } from '../../src/domain/jevShelf.js';
import { categoryCompatible } from '../../src/domain/matchRules.js';
import { categoryDenied, categoryStatus } from '../../src/denylist.js';
import { postToJev, type JevResult } from '../../src/shadow/jev.js';

const here = dirname(fileURLToPath(import.meta.url));
const setPath =
  process.env.OSB_SHELF_SET ??
  join(process.env.OSB_INTERNAL_DIR ?? join(here, '..', '..', '..', 'internal'), 'server', 'test', 'calibration', 'shelf-set.json');
if (!existsSync(setPath)) {
  console.error(`No labelled shelf set at ${setPath}; see the header of this file. Skipping.`);
  process.exit(0);
}
const set: any[] = JSON.parse(readFileSync(setPath, 'utf8'));
const noCall = process.argv.includes('--no-call');
const cfg: any = { bedrockEmbedModelId: process.env.BEDROCK_EMBED_MODEL_ID ?? 'amazon.titan-embed-text-v2:0', region: process.env.AWS_REGION ?? 'us-east-1' };

const cachePath = join(here, '.jev-shelf-cache.json');
const cache: Record<string, JevResult> = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, 'utf8')) : {};
let apiKey: string | undefined;
async function key(): Promise<string> {
  if (apiKey) return apiKey;
  const sm = new SecretsManagerClient({ region: cfg.region });
  const raw = (await sm.send(new GetSecretValueCommand({ SecretId: 'osb/dev/jev' }))).SecretString ?? '{}';
  apiKey = String(JSON.parse(raw).apiKey ?? '');
  if (!apiKey) throw new Error('osb/dev/jev has no apiKey');
  return apiKey;
}
let fresh = 0;
const ask = async (state: unknown, questions: any): Promise<JevResult> => {
  const k = createHash('sha256').update(JSON.stringify({ state, questions })).digest('hex');
  if (cache[k]) return cache[k];
  if (noCall) return { ok: false, reason: 'not-cached' };
  fresh++;
  const r = await postToJev({ state, questions, apiKey: await key(), timeoutMs: JEV_SHELF_TIMEOUT_MS, retry: false });
  if (r.ok) cache[k] = r;
  return r;
};

const open = (c: string) => categoryStatus(c).status === 'open' && !categoryDenied(c);
const topOf = (c: string) => c.split('.')[0];

type Final = { kind: 'filed'; category: string; how: string } | { kind: 'unclear' } | { kind: 'shelf-page' };
const finalOf = (d: SnapDecision): Final =>
  d.how === 'unclear'
    ? d.jev?.verdict.decision === 'none'
      ? { kind: 'shelf-page' }
      : { kind: 'unclear' }
    : { kind: 'filed', category: d.category, how: d.how };

await warmCategoryCorpus(cfg);
interface Row {
  e: any;
  rules: Final;
  jev: Final;
  asked: boolean;
  options?: string[];
  verdict?: any;
  reasons?: string[];
}
const rows: Row[] = [];
for (const e of set) {
  const posting = { kind: e.kind, attributes: e.attributes };
  const base = { fallbackToAncestor: true, askWhenUnsure: true, posting };
  const r = await snapCategory(cfg, e.as_posted, () => {}, base);
  let options: string[] | undefined;
  const j = await snapCategory(cfg, e.as_posted, () => {}, {
    ...base,
    chooseShelf: (req: JevShelfRequest) => {
      options = req.options;
      return chooseShelfWithJev(req, () => {}, { ask, enabled: true });
    },
  });
  rows.push({ e, rules: finalOf(r), jev: finalOf(j), asked: !!j.jev, options, verdict: j.jev?.verdict, reasons: j.jev?.reasons });
}
writeFileSync(cachePath, JSON.stringify(cache));

// ---------------------------------------------------------------------------
const isNone = (e: any) => e.right === 'none_of_these';
const rightFiling = (e: any, c: string) => !isNone(e) && c.includes('.') && (e.right as string[]).some((r) => categoryCompatible(c, r));
const strictFit = (e: any, o: string) => !isNone(e) && (e.right as string[]).some((r) => o === r || o.startsWith(`${r}.`));
const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : 'n/a');
function report(name: string, k: 'rules' | 'jev') {
  const filed = rows.filter((r) => r[k].kind === 'filed') as (Row & { [x: string]: any })[];
  const shelfFiled = filed.filter((r) => (r[k] as any).category.includes('.'));
  const topLevel = filed.length - shelfFiled.length;
  const right = shelfFiled.filter((r) => rightFiling(r.e, (r[k] as any).category)).length;
  const crossings = shelfFiled.filter((r) => !isNone(r.e) && topOf((r[k] as any).category) !== topOf(r.e.right[0])).length;
  const closed = filed.filter((r) => !open((r[k] as any).category)).length;
  const unclear = rows.filter((r) => r[k].kind === 'unclear').length;
  const page = rows.filter((r) => r[k].kind === 'shelf-page').length;
  console.log(`\n${name}`);
  const strict = shelfFiled.filter((r) => strictFit(r.e, (r[k] as any).category)).length;
  console.log(`  filed on a shelf without asking: ${shelfFiled.length}; right ${right} (${pct(right, shelfFiled.length)})   bar >= 95%   [strictly the labelled node or below: ${strict} (${pct(strict, shelfFiled.length)})]`);
  console.log(`  filed under a bare top level: ${topLevel}`);
  console.log(`  wrong top-level crossings: ${crossings}   bar 0`);
  console.log(`  closed shelves filed on: ${closed}   bar 0`);
  console.log(`  SHELF_UNCLEAR (human asked from the list): ${unclear}; shelf page (SHELF_PICK) straight away: ${page}`);
  return { unclear, page, shelfFiled: shelfFiled.length, right };
}
const n = rows.length;
console.log(`# Shelf choice calibration: ${n} labelled postings (${set.filter(isNone).length} labelled none of these)`);
const asked = rows.filter((r) => r.asked);
console.log(`Jev asked on ${asked.length} (${fresh} fresh calls this run, the rest cached); reasons: ` +
  ['unclear', 'crosses-top', 'close-branches'].map((x) => `${x} ${asked.filter((r) => r.reasons?.includes(x)).length}`).join(', '));
const R = report('RULES ONLY (the door today)', 'rules');
const J = report('RULES + JEV SHELF CHOICE', 'jev');

const picks = asked.filter((r) => r.verdict?.decision === 'pick');
const pickRight = picks.filter((r) => rightFiling(r.e, r.verdict.category)).length;
console.log(`\nJev decided a shelf on ${picks.length}; right ${pickRight} (${pct(pickRight, picks.length)})`);
const nones = asked.filter((r) => r.verdict?.decision === 'none');
const noneRight = nones.filter((r) => isNone(r.e) || !(r.options ?? []).some((o) => rightFiling(r.e, o))).length;
console.log(`Jev said none of these (p >= 0.70) on ${nones.length}; correct (no offered shelf was right) ${noneRight} (${pct(noneRight, nones.length)})   bar >= 90%`);
// The same, strictly: an offered shelf counts as a fit only where it is a
// labelled node or below one. The matcher's sibling rule (sheet music beside a
// synthesiser, road bikes beside bike parts) says two postings may meet, not
// that a person would call the sibling the right shelf.
const noneRight2 = nones.filter((r) => !(r.options ?? []).some((o) => strictFit(r.e, o))).length;
console.log(`  ... strictly (only a labelled node or below it counts as a fit): ${noneRight2}/${nones.length} (${pct(noneRight2, nones.length)})`);
for (const r of nones) {
  const fits = (r.options ?? []).filter((o) => rightFiling(r.e, o));
  console.log(`    none on ${r.e.id}: ${fits.length ? `WRONG, offered and right: ${fits.join(', ')}` : 'correct'}`);
}
const fellBack = asked.filter((r) => r.verdict?.decision === 'rules');
const why: Record<string, number> = {};
for (const r of fellBack) why[r.verdict.reason] = (why[r.verdict.reason] ?? 0) + 1;
console.log(`Jev left it to the rules on ${fellBack.length}: ${Object.entries(why).map(([k, v]) => `${k} ${v}`).join(', ')}`);
console.log(`SHELF_UNCLEAR: ${R.unclear} -> ${J.unclear} (${R.unclear ? (((R.unclear - J.unclear) / R.unclear) * 100).toFixed(1) : 'n/a'}% fewer)   bar >= 40%`);
console.log(`Any human question (list or page): ${R.unclear + R.page} -> ${J.unclear + J.page}`);
const lat = asked.map((r) => r.verdict?.latencyMs).filter((x): x is number => typeof x === 'number').sort((a, b) => a - b);
if (lat.length) console.log(`Jev latency ms (as recorded when answered): median ${lat[Math.floor(lat.length / 2)]}, p95 ${lat[Math.min(lat.length - 1, Math.floor(lat.length * 0.95))]}, max ${lat[lat.length - 1]}   bar p95 < 600`);

console.log('\n## Every posting where the two differ, or where the Jev answer is wrong');
const show = (f: Final) => (f.kind === 'filed' ? `${f.category} (${f.how})` : f.kind);
for (const r of rows) {
  const jevWrong = r.jev.kind === 'filed' ? !rightFiling(r.e, r.jev.category) : false;
  if (JSON.stringify(r.rules) === JSON.stringify(r.jev) && !jevWrong) continue;
  console.log(`  ${r.e.id} "${r.e.kind}" [${r.e.as_posted}] label ${isNone(r.e) ? 'none' : r.e.right.join('|')}: rules ${show(r.rules)} -> jev ${show(r.jev)}` +
    (r.verdict ? `  [${r.verdict.decision}${r.verdict.p != null ? ` p ${r.verdict.p.toFixed(2)}` : ''}${r.verdict.reason ? ` ${r.verdict.reason}` : ''}; ${r.reasons?.join(',')}]` : '') +
    (jevWrong ? '  WRONG' : ''));
}
