/**
 * Tier-line calibration: `npm run calibrate-tiers`.
 *
 * Embeds every posting in pairs.json once with the production embedding call
 * (embeddings.embedText: Titan v2, 1024 dims, normalised) over the production
 * projection (matchRules.projectionText), caching vectors in .cache.json keyed
 * by model id + projection text. Then, per pair, computes cosine, category
 * closeness and word agreement, searches simple threshold rules for the three
 * tiers, and prints the chosen lines, confusion tables, misses, a sensitivity
 * sweep and a held-out check. See README.md.
 *
 * Read-only against Bedrock. Touches no database.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { embedText } from '../../src/domain/embeddings.js';
import { categoryCloseness, projectionText } from '../../src/domain/matchRules.js';
import { wordAgreementDetail, type Posting } from './signals.js';

type Label = 'sure' | 'possible' | 'nothing';
const LABELS: Label[] = ['sure', 'possible', 'nothing'];

interface Pair {
  id: string;
  label: Label;
  obscure?: boolean;
  why: string;
  want: Posting;
  have: Posting;
}

interface Row {
  pair: Pair;
  cos: number;
  cat: number | null;
  wa: number;
  shared: string[];
  /** Variant only: a head-noun or brand conflict forbids SURE. */
  veto?: boolean;
}

const here = dirname(fileURLToPath(import.meta.url));
const pairs: Pair[] = JSON.parse(readFileSync(join(here, 'pairs.json'), 'utf8'));
const cachePath = join(here, '.cache.json');
const modelId = process.env.BEDROCK_EMBED_MODEL_ID ?? 'amazon.titan-embed-text-v2:0';
const cfg = { bedrockEmbedModelId: modelId } as Parameters<typeof embedText>[0];

// ---------------------------------------------------------------------------
// Embeddings (cached)
// ---------------------------------------------------------------------------
const cache: Record<string, number[]> = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, 'utf8')) : {};
const keyOf = (text: string) => createHash('sha256').update(`${modelId}\n${text}`).digest('hex');

async function embedAll(texts: string[]): Promise<void> {
  const todo = [...new Set(texts)].filter((t) => !cache[keyOf(t)]);
  if (todo.length) console.error(`embedding ${todo.length} new projection texts with ${modelId}...`);
  let i = 0;
  const worker = async () => {
    while (i < todo.length) {
      const t = todo[i++];
      cache[keyOf(t)] = await embedText(cfg, t);
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  if (todo.length) writeFileSync(cachePath, JSON.stringify(cache));
}

function cosine(a: number[], b: number[]): number {
  let d = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    d += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return d / Math.sqrt(na * nb);
}

function safeCloseness(a: string, b: string): number | null {
  try {
    return categoryCloseness(a, b);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------
/** Two-signal rule. SURE = cos >= sureCos AND wa >= sureWord.
 *  POSSIBLE = cos >= possCos OR (wa >= possWord AND cos >= possWordCos). */
interface Lines {
  sureCos: number;
  sureWord: number;
  possCos: number;
  possWord: number;
  possWordCos: number;
}

function tierOf(r: { cos: number; wa: number; veto?: boolean }, L: Lines): Label {
  if (!r.veto && r.cos >= L.sureCos && r.wa >= L.sureWord) return 'sure';
  if (r.cos >= L.possCos || (r.wa >= L.possWord && r.cos >= L.possWordCos)) return 'possible';
  return 'nothing';
}

/** Error costs (rows = truth, cols = predicted). NOTHING->SURE is a hard
 *  constraint (never allowed) rather than a cost. */
const COST: Record<Label, Record<Label, number>> = {
  sure: { sure: 0, possible: 1, nothing: 3 },
  possible: { sure: 3, possible: 0, nothing: 1.5 },
  nothing: { sure: Infinity, possible: 1, nothing: 0 },
};

type Table = Record<Label, Record<Label, number>>;
function confusion(rows: Row[], L: Lines, tier: (r: Row, L: Lines) => Label = tierOf): Table {
  const t = {} as Table;
  for (const a of LABELS) t[a] = { sure: 0, possible: 0, nothing: 0 };
  for (const r of rows) t[r.pair.label][tier(r, L)]++;
  return t;
}
function costOf(t: Table): number {
  let c = 0;
  for (const a of LABELS) for (const b of LABELS) if (t[a][b]) c += t[a][b] * COST[a][b];
  return c;
}

const grid = (lo: number, hi: number, step: number) => {
  const out: number[] = [];
  for (let v = lo; v <= hi + 1e-9; v += step) out.push(Math.round(v * 100) / 100);
  return out;
};
const COS_GRID = grid(0.3, 0.98, 0.01);
const WORD_GRID = grid(0, 1, 0.02);

/**
 * Two stages, because the SURE line only moves pairs between SURE and the
 * rest: (1) choose sureCos/sureWord on SURE-related cost with NOTHING->SURE
 * forbidden; (2) with those fixed, choose the POSSIBLE lines on full cost.
 * Ties are broken by the mean cost of the ±0.02 neighbourhood (prefer a flat
 * plateau over a knife edge), then by the fewest false POSSIBLE.
 */
function fit(rows: Row[], useWords: boolean): Lines {
  const robust = (L: Lines, keys: (keyof Lines)[]) => {
    let s = 0;
    let n = 0;
    for (const k of keys)
      for (const d of [-0.02, 0.02]) {
        const c = costOf(confusion(rows, { ...L, [k]: L[k] + d }));
        s += Number.isFinite(c) ? c : 1000;
        n++;
      }
    return n ? s / n : 0;
  };
  // Stage 1
  let best: { L: Lines; c: number; r: number } | undefined;
  for (const a of COS_GRID)
    for (const b of useWords ? WORD_GRID : [0]) {
      const L: Lines = { sureCos: a, sureWord: b, possCos: 2, possWord: 2, possWordCos: 2 };
      // stage-1 cost: everything not SURE is predicted NOTHING here, so only
      // count what the sure line decides: false sure, and sure-vs-not-sure.
      const t = confusion(rows, L);
      if (t.nothing.sure > 0) continue;
      const c = t.possible.sure * COST.possible.sure + (t.sure.nothing + t.sure.possible) * COST.sure.possible;
      const r = robust(L, useWords ? ['sureCos', 'sureWord'] : ['sureCos']);
      if (!best || c < best.c || (c === best.c && r < best.r)) best = { L, c, r };
    }
  if (!best) throw new Error('no SURE line avoids a false SURE');
  const { sureCos, sureWord } = best.L;
  // Stage 2
  let best2: { L: Lines; c: number; r: number; fp: number } | undefined;
  const possWords = useWords ? WORD_GRID : [2];
  for (const c of COS_GRID)
    for (const d of possWords)
      for (const e of useWords ? COS_GRID.filter((x) => x <= c) : [2]) {
        const L: Lines = { sureCos, sureWord, possCos: c, possWord: d, possWordCos: e };
        const t = confusion(rows, L);
        const cost = costOf(t);
        if (!Number.isFinite(cost)) continue;
        if (best2 && cost > best2.c) continue;
        const r = robust(L, useWords ? ['possCos', 'possWord', 'possWordCos'] : ['possCos']);
        const fp = t.nothing.possible;
        if (!best2 || cost < best2.c || (cost === best2.c && (r < best2.r || (r === best2.r && fp < best2.fp))))
          best2 = { L, c: cost, r, fp };
      }
  if (!best2) throw new Error('no POSSIBLE line found');
  // When the words clause never fires, say so plainly rather than printing
  // a meaningless pair of numbers.
  return best2.L;
}

// ---------------------------------------------------------------------------
// Reporting helpers
// ---------------------------------------------------------------------------
const f2 = (x: number | null) => (x === null ? ' n/a' : x.toFixed(2));
function printTable(title: string, t: Table) {
  console.log(`\n${title}`);
  console.log('  truth \\ tier   SURE  POSSIBLE  NOTHING   n');
  for (const a of LABELS) {
    const n = t[a].sure + t[a].possible + t[a].nothing;
    console.log(
      `  ${a.toUpperCase().padEnd(13)} ${String(t[a].sure).padStart(5)} ${String(t[a].possible).padStart(9)} ${String(t[a].nothing).padStart(8)} ${String(n).padStart(4)}`,
    );
  }
  const sureN = t.sure.sure + t.sure.possible + t.sure.nothing;
  const anyN = sureN + t.possible.sure + t.possible.possible + t.possible.nothing;
  const nothingN = t.nothing.sure + t.nothing.possible + t.nothing.nothing;
  console.log(
    `  false SURE on NOTHING: ${t.nothing.sure}   false POSSIBLE on NOTHING: ${t.nothing.possible}/${nothingN}` +
      `   SURE caught as SURE: ${t.sure.sure}/${sureN}` +
      `   SURE+POSSIBLE at least POSSIBLE: ${t.sure.sure + t.sure.possible + t.possible.sure + t.possible.possible}/${anyN}` +
      `   POSSIBLE shown as SURE: ${t.possible.sure}   cost ${costOf(t)}`,
  );
}
function linesText(L: Lines): string {
  const words = L.possWord > 1 ? '(words clause off)' : `OR (word >= ${L.possWord.toFixed(2)} AND cos >= ${L.possWordCos.toFixed(2)})`;
  const sw = L.sureWord > 0 ? ` AND word >= ${L.sureWord.toFixed(2)}` : '';
  return `SURE: cos >= ${L.sureCos.toFixed(2)}${sw}\n  POSSIBLE: cos >= ${L.possCos.toFixed(2)} ${words}`;
}

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function split(rows: Row[], seed: number): [Row[], Row[]] {
  const rnd = mulberry32(seed);
  const fitRows: Row[] = [];
  const testRows: Row[] = [];
  for (const lab of LABELS) {
    const g = rows.filter((r) => r.pair.label === lab);
    for (let i = g.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [g[i], g[j]] = [g[j], g[i]];
    }
    const cut = Math.round(g.length * 0.7);
    fitRows.push(...g.slice(0, cut));
    testRows.push(...g.slice(cut));
  }
  return [fitRows, testRows];
}

/** Refit on 70% and score the other 30%, for seeds 1..20; print the totals. */
function seedSummary(name: string, rows: Row[], useWords: boolean): void {
  let fs = 0;
  let fp = 0;
  let ss = 0;
  let sN = 0;
  let ps = 0;
  let anyHit = 0;
  let anyN = 0;
  let nN = 0;
  for (let s = 1; s <= 20; s++) {
    const [fr, tr] = split(rows, s);
    const t = confusion(tr, fit(fr, useWords));
    fs += t.nothing.sure;
    fp += t.nothing.possible;
    nN += t.nothing.sure + t.nothing.possible + t.nothing.nothing;
    ss += t.sure.sure;
    sN += t.sure.sure + t.sure.possible + t.sure.nothing;
    ps += t.possible.sure;
    anyHit += t.sure.sure + t.sure.possible + t.possible.sure + t.possible.possible;
    anyN += t.sure.sure + t.sure.possible + t.sure.nothing + t.possible.sure + t.possible.possible + t.possible.nothing;
  }
  console.log(
    `  ${name.padEnd(34)} false SURE ${fs}/${nN}  false POSSIBLE ${fp}/${nN}  SURE-as-SURE ${ss}/${sN}  POSSIBLE-as-SURE ${ps}  S+P at least POSSIBLE ${anyHit}/${anyN}`,
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const texts = pairs.flatMap((p) => [projectionText(p.want), projectionText(p.have)]);
  await embedAll(texts);

  const rows: Row[] = pairs.map((p) => {
    const d = wordAgreementDetail(p.want, p.have);
    return {
      pair: p,
      cos: cosine(cache[keyOf(projectionText(p.want))], cache[keyOf(projectionText(p.have))]),
      cat: safeCloseness(p.want.category, p.have.category),
      wa: d.score,
      shared: d.shared,
    };
  });

  const counts = LABELS.map((l) => `${l} ${rows.filter((r) => r.pair.label === l).length}`).join(', ');
  console.log(`# Tier calibration: ${rows.length} pairs (${counts}; obscure ${rows.filter((r) => r.pair.obscure).length})`);
  console.log(`model ${modelId}; cost weights: NOTHING->SURE forbidden; POSSIBLE->SURE 3; SURE->NOTHING 3; POSSIBLE->NOTHING 1.5; NOTHING->POSSIBLE 1; SURE->POSSIBLE 1`);

  // Signal distributions
  console.log('\n## Signal ranges by label (min / median / max)');
  const q = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    return `${f2(s[0])} / ${f2(s[Math.floor(s.length / 2)])} / ${f2(s[s.length - 1])}`;
  };
  for (const l of LABELS) {
    const g = rows.filter((r) => r.pair.label === l);
    const cats = g.map((r) => r.cat).filter((x): x is number => x !== null);
    console.log(`  ${l.padEnd(9)} cos ${q(g.map((r) => r.cos))}   word ${q(g.map((r) => r.wa))}   category ${q(cats)}`);
  }
  // Separability: how well each signal alone ranks SURE above NOTHING (AUC).
  const auc = (pos: number[], neg: number[]) => {
    let s = 0;
    for (const p of pos) for (const n of neg) s += p > n ? 1 : p === n ? 0.5 : 0;
    return s / (pos.length * neg.length);
  };
  const by = (l: Label, k: 'cos' | 'wa') => rows.filter((r) => r.pair.label === l).map((r) => r[k]);
  const catBy = (l: Label) => rows.filter((r) => r.pair.label === l).map((r) => r.cat ?? 0);
  console.log('\n## AUC (probability a random first-label pair outscores a random second-label pair)');
  for (const [a, b] of [['sure', 'nothing'], ['sure', 'possible'], ['possible', 'nothing']] as [Label, Label][]) {
    console.log(
      `  ${a} vs ${b}: cos ${auc(by(a, 'cos'), by(b, 'cos')).toFixed(3)}   word ${auc(by(a, 'wa'), by(b, 'wa')).toFixed(3)}   category ${auc(catBy(a), catBy(b)).toFixed(3)}`,
    );
  }

  // Fit both families on all pairs
  const cosOnly = fit(rows, false);
  const both = fit(rows, true);
  console.log('\n## Cosine alone, fitted on all pairs');
  console.log(`  ${linesText(cosOnly)}`);
  printTable('Confusion (cosine alone, all pairs)', confusion(rows, cosOnly));
  console.log('\n## Cosine + word agreement, fitted on all pairs (CHOSEN)');
  console.log(`  ${linesText(both)}`);
  const tAll = confusion(rows, both);
  printTable('Confusion (cosine + words, all pairs)', tAll);

  console.log('\n## Every misclassified pair under the chosen lines');
  const miss = rows.filter((r) => tierOf(r, both) !== r.pair.label);
  const sev = (r: Row) => COST[r.pair.label][tierOf(r, both)];
  miss.sort((a, b) => sev(b) - sev(a) || a.pair.id.localeCompare(b.pair.id));
  for (const r of miss) {
    const got = tierOf(r, both);
    console.log(
      `  ${r.pair.id} ${r.pair.label.toUpperCase()} -> ${got.toUpperCase()} (cost ${sev(r)})  cos ${f2(r.cos)}  word ${f2(r.wa)}  cat ${f2(r.cat)}${r.pair.obscure ? '  [obscure]' : ''}`,
    );
    console.log(`      "${r.pair.want.kind}" [${r.pair.want.category}]  vs  "${r.pair.have.kind}" [${r.pair.have.category}]`);
    console.log(`      label why: ${r.pair.why}.  shared words: ${r.shared.join(', ') || '(none)'}`);
  }

  console.log('\n## Sensitivity: each line moved on its own (all pairs)');
  console.log('  line          shift   falseSURE  falsePOSS  SURE-as-SURE  S+P>=POSS  POSS-as-SURE  cost');
  const keys: (keyof Lines)[] = ['sureCos', 'sureWord', 'possCos', 'possWord', 'possWordCos'];
  for (const k of keys) {
    if (k.startsWith('possWord') && both.possWord > 1) continue;
    for (const d of [-0.05, -0.02, 0, 0.02, 0.05]) {
      const t = confusion(rows, { ...both, [k]: both[k] + d });
      const line = `  ${k.padEnd(12)} ${(d >= 0 ? '+' : '') + d.toFixed(2)}  ${String(t.nothing.sure).padStart(9)} ${String(t.nothing.possible).padStart(10)} ${String(t.sure.sure).padStart(13)} ${String(t.sure.sure + t.sure.possible + t.possible.sure + t.possible.possible).padStart(10)} ${String(t.possible.sure).padStart(13)} ${String(costOf(t)).padStart(6)}`;
      console.log(line);
    }
  }

  console.log('\n## POSSIBLE line trade-off (SURE line as chosen, words clause off, possCos swept)');
  console.log('  possCos  falsePOSS/NOTHING  SURE+POSS missed  POSS->NOTHING');
  for (let c = 0.4; c <= 0.7001; c += 0.05) {
    const t = confusion(rows, { ...both, possCos: c, possWord: 2, possWordCos: 2 });
    console.log(`  ${c.toFixed(2)}     ${String(t.nothing.possible).padStart(3)}/${t.nothing.sure + t.nothing.possible + t.nothing.nothing}              ${String(t.sure.nothing + t.possible.nothing).padStart(3)}              ${String(t.possible.nothing).padStart(3)}`);
  }

  console.log('\n## Held-out check: fit on 70%, report on 30% (stratified, seed 20260920)');
  const [fitRows, testRows] = split(rows, 20260920);
  for (const [name, useWords] of [['cosine alone', false], ['cosine + words', true]] as [string, boolean][]) {
    const L = fit(fitRows, useWords);
    console.log(`\n  ${name}, fitted on ${fitRows.length}:\n  ${linesText(L)}`);
    printTable(`  fit set (${fitRows.length})`, confusion(fitRows, L));
    printTable(`  HELD-OUT set (${testRows.length})`, confusion(testRows, L));
  }

  console.log('\n## Held-out over 20 seeds (totals across the 20 held-out sets)');
  seedSummary('cosine alone', rows, false);
  seedSummary('cosine + words', rows, true);

  // The concurrent production module, if it has landed.
  const tiersPath = join(here, '../../src/domain/matchTiers.ts');
  if (existsSync(tiersPath)) {
    console.log('\n## src/domain/matchTiers.ts over the same pairs');
    try {
      const mod: any = await import('../../src/domain/matchTiers.js');
      const consts = Object.entries(mod)
        .filter(([, v]) => typeof v === 'number')
        .map(([k, v]) => `${k}=${v}`);
      console.log(`  its constants: ${consts.join(', ')}`);
      console.log('  Run with both postings in one place (same Canberra centre, radius 25 km) and no price, so');
      console.log('  only meaning, shelf and words decide. Its near-miss tier is counted as NOTHING (no introduction).');
      const geo = { bucket: 'r3dp', place: 'Canberra', radius_km: 25, lat: -35.28, lon: 149.13, reach: 'radius', country: 'AU' };
      const prodTier = (r: Row): Label => {
        const res = mod.tierFor({
          semantic: r.cos,
          categoryA: r.pair.want.category,
          categoryB: r.pair.have.category,
          geoA: geo,
          geoB: geo,
          a: r.pair.want,
          b: r.pair.have,
        });
        return res.tier === 'sure' ? 'sure' : res.tier === 'possible' ? 'possible' : 'nothing';
      };
      const whyOf = (r: Row) =>
        mod.tierFor({ semantic: r.cos, categoryA: r.pair.want.category, categoryB: r.pair.have.category, geoA: geo, geoB: geo, a: r.pair.want, b: r.pair.have });
      printTable('Confusion (src/domain/matchTiers.ts tierFor, all pairs)', confusion(rows, both, (r) => prodTier(r)));
      const [, testRows2] = split(rows, 20260920);
      printTable('Confusion (matchTiers.ts tierFor, the same 30% held-out set)', confusion(testRows2, both, (r) => prodTier(r)));
      console.log('\n  matchTiers.ts misclassifications (truth -> tier, blend, its wordAgreement score/coverage/brand/model/head, its reason):');
      const pm = rows.filter((r) => prodTier(r) !== r.pair.label);
      pm.sort((a, b) => COST[b.pair.label][prodTier(b)] - COST[a.pair.label][prodTier(a)] || a.pair.id.localeCompare(b.pair.id));
      for (const r of pm) {
        const res = whyOf(r);
        const w = res.parts.words;
        console.log(
          `  ${r.pair.id} ${r.pair.label.toUpperCase()} -> ${res.tier.toUpperCase()}  cos ${f2(r.cos)} blend ${f2(res.score)}  words ${f2(w.score)}/${f2(w.coverage)} brand ${w.brand} model ${w.model} head ${w.head}  "${res.parts.why}"`,
        );
        console.log(`      "${r.pair.want.kind}" vs "${r.pair.have.kind}"`);
      }
      // Its word score as a drop-in for ours, under the same rule search.
      const theirRows: Row[] = rows.map((r) => ({ ...r, wa: mod.wordAgreement(r.pair.want, r.pair.have).score }));
      const theirLines = fit(theirRows, true);
      console.log(`\n  Rule search re-run with matchTiers.wordAgreement().score in place of signals.ts:\n  ${linesText(theirLines)}`);
      printTable('  Confusion (cos + matchTiers word score, all pairs)', confusion(theirRows, theirLines));
      const theirCov: Row[] = rows.map((r) => ({ ...r, wa: mod.wordAgreement(r.pair.want, r.pair.have).coverage }));
      const covLines = fit(theirCov, true);
      const vetoRows: Row[] = rows.map((r) => {
        const w = mod.wordAgreement(r.pair.want, r.pair.have);
        return { ...r, veto: w.head === 'conflict' || w.brand === 'conflict' };
      });
      const vetoLines = fit(vetoRows, true);
      console.log(`\n  VARIANT: signals.ts words + matchTiers head/brand conflict as a veto on SURE only:\n  ${linesText(vetoLines)}`);
      printTable('  Confusion (cos + words, head/brand veto on SURE, all pairs)', confusion(vetoRows, vetoLines));
      const [vf, vt] = split(vetoRows, 20260920);
      const vL = fit(vf, true);
      console.log(`  held-out fit: ${linesText(vL)}`);
      printTable('  HELD-OUT (30%) for the veto variant', confusion(vt, vL));
      console.log('\n  Held-out over 20 seeds for these variants:');
      seedSummary('cos + matchTiers word score', theirRows, true);
      seedSummary('cos + signals.ts words + veto', vetoRows, true);
      const theirVeto: Row[] = theirRows.map((r, i) => ({ ...r, veto: vetoRows[i].veto }));
      const tvL = fit(theirVeto, true);
      console.log(`\n  VARIANT: matchTiers word score + its head/brand veto on SURE:\n  ${linesText(tvL)}`);
      printTable('  Confusion (cos + matchTiers score + veto, all pairs)', confusion(theirVeto, tvL));
      seedSummary('cos + matchTiers score + veto', theirVeto, true);
      console.log(`\n  ...and with its coverage in place of the score:\n  ${linesText(covLines)}`);
      printTable('  Confusion (cos + matchTiers coverage, all pairs)', confusion(theirCov, covLines));
    } catch (e) {
      console.log(`  could not run it: ${(e as Error).message}`);
    }
  } else {
    console.log('\n## src/domain/matchTiers.ts not present; production tiers not run.');
  }

  // Per-pair dump for anyone who wants to look.
  console.log('\n## All pairs (id label -> chosen tier | cos word cat)');
  for (const r of rows) {
    console.log(`  ${r.pair.id.padEnd(4)} ${r.pair.label.padEnd(8)} -> ${tierOf(r, both).padEnd(8)} | ${f2(r.cos)} ${f2(r.wa)} ${f2(r.cat)}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
