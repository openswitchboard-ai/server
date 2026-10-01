/**
 * The borderline judge, calibrated: `npm run calibrate-jev`.
 *
 * Runs the matcher's own decision over the labelled pairs: the rules tier
 * (matchTiers.tierFor, cosine from the embedding cache that
 * `npm run calibrate-tiers` fills), which pairs are put to Jev
 * (jevJudge.jevJudgesTier), Jev's own tier (jevJudge.jevTier) and the tier the
 * pair ends with after the near-miss floor (jevJudge.flooredTier). Prints the
 * three side by side.
 *
 * Labels are the four answers a pair can have: sure, possible, near-miss (close,
 * never an introduction) and nothing. Pairs labelled only sure/possible/nothing
 * are read as they are.
 *
 * Jev's answers are cached in .jev-cache.json (gitignored), keyed by the exact
 * state and questions sent, so a re-run calls Jev only for pairs it has not
 * seen in that exact form. Calls are made with the dev key (osb/dev/jev, read
 * from Secrets Manager and never printed), one attempt, the matcher's timeout.
 * Pass --no-call to use the cache only.
 *
 * Reads the same pairs file as run.mts (OSB_CALIBRATION_PAIRS, or
 * OSB_INTERNAL_DIR, or ../internal). Touches no database.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { projectionText } from '../../src/domain/matchRules.js';
import { tierFor, type Tier } from '../../src/domain/matchTiers.js';
import { JEV_JUDGE_TIMEOUT_MS, JEV_NEAR_MISS_SAME_KIND_MIN, flooredTier, jevJudgesTier, jevTier, noulsOf, type JevNouls } from '../../src/domain/jevJudge.js';
import { postToJev } from '../../src/shadow/jev.js';
import { jevPairQuestions, jevPairState } from '../../src/shadow/jevTrials.js';

type Label = Tier; // 'sure' | 'possible' | 'near-miss' | 'nothing'
const LABELS: Label[] = ['sure', 'possible', 'near-miss', 'nothing'];

const here = dirname(fileURLToPath(import.meta.url));
const pairsPath =
  process.env.OSB_CALIBRATION_PAIRS ??
  join(process.env.OSB_INTERNAL_DIR ?? join(here, '..', '..', '..', 'internal'), 'server', 'test', 'calibration', 'pairs.json');
if (!existsSync(pairsPath)) {
  console.error(`No calibration pairs at ${pairsPath}; see test/calibration/README.md. Skipping.`);
  process.exit(0);
}
const pairs: any[] = JSON.parse(readFileSync(pairsPath, 'utf8'));
const noCall = process.argv.includes('--no-call');

const modelId = process.env.BEDROCK_EMBED_MODEL_ID ?? 'amazon.titan-embed-text-v2:0';
const embedCache: Record<string, number[]> = JSON.parse(readFileSync(join(here, '.cache.json'), 'utf8'));
const vec = (t: string) => {
  const v = embedCache[createHash('sha256').update(`${modelId}\n${t}`).digest('hex')];
  if (!v) throw new Error('an embedding is missing: run `npm run calibrate-tiers` first');
  return v;
};
const cos = (a: number[], b: number[]) => {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return d / Math.sqrt(na * nb);
};
const geo = { bucket: 'r3dp', place: 'x', radius_km: 25, lat: -35.28, lon: 149.13, reach: 'radius', country: 'AU' } as any;

const questions = jevPairQuestions();
const jevCachePath = join(here, '.jev-cache.json');
const jevCache: Record<string, { nouls: JevNouls; latencyMs: number }> = existsSync(jevCachePath)
  ? JSON.parse(readFileSync(jevCachePath, 'utf8'))
  : {};
const keyOf = (state: unknown) => createHash('sha256').update(JSON.stringify({ state, questions })).digest('hex');

let apiKey: string | undefined;
async function key(): Promise<string> {
  if (apiKey) return apiKey;
  const sm = new SecretsManagerClient({ region: process.env.AWS_REGION ?? 'us-east-1' });
  const raw = (await sm.send(new GetSecretValueCommand({ SecretId: 'osb/dev/jev' }))).SecretString ?? '{}';
  apiKey = String(JSON.parse(raw).apiKey ?? '');
  if (!apiKey) throw new Error('osb/dev/jev has no apiKey');
  return apiKey;
}

interface Row {
  id: string;
  label: Label;
  rules: Tier;
  asked: boolean;
  jev?: Exclude<Tier, 'near-miss'>;
  before: Tier; // Jev's tier where it answered, else the rules'
  after: Tier; // the same with the near-miss floor
  nouls?: JevNouls;
  latencyMs?: number;
  fresh?: boolean;
  err?: string;
}

const rows: Row[] = [];
let calls = 0;
let next = 0;
async function worker() {
  while (next < pairs.length) {
    const p = pairs[next++];
    const rules = tierFor({
      semantic: cos(vec(projectionText(p.want)), vec(projectionText(p.have))),
      categoryA: p.want.category, categoryB: p.have.category, geoA: geo, geoB: geo,
      a: p.want, b: p.have, wantIs: 'a',
    });
    const row: Row = { id: p.id, label: p.label, rules: rules.tier, asked: false, before: rules.tier, after: rules.tier };
    if (jevJudgesTier(rules)) {
      row.asked = true;
      const state = jevPairState(p.want, p.have);
      const k = keyOf(state);
      let hit = jevCache[k];
      if (!hit && !noCall) {
        calls++;
        const r = await postToJev({ state, questions, apiKey: await key(), timeoutMs: JEV_JUDGE_TIMEOUT_MS, retry: false });
        if (r.ok) {
          const n = noulsOf(r.answers);
          if (n) { hit = { nouls: n, latencyMs: r.latencyMs }; jevCache[k] = hit; row.fresh = true; }
          else row.err = 'incomplete';
        } else row.err = r.reason;
      } else if (!hit) row.err = 'not-cached';
      if (hit) {
        row.nouls = hit.nouls;
        row.latencyMs = hit.latencyMs;
        row.jev = jevTier(hit.nouls, p.want, p.have);
        row.before = row.jev;
        row.after = flooredTier(row.jev, rules.tier, hit.nouls.same_kind);
      }
    }
    rows.push(row);
  }
}
await Promise.all([worker(), worker(), worker(), worker()]);
writeFileSync(jevCachePath, JSON.stringify(jevCache));
const order = new Map(pairs.map((p, i) => [p.id, i]));
rows.sort((a, b) => order.get(a.id)! - order.get(b.id)!);

// ---------------------------------------------------------------------------
const pad = (s: string | number, n: number) => String(s).padStart(n);
function confusion(title: string, k: 'rules' | 'before' | 'after', rs: Row[] = rows) {
  console.log(`\n${title}`);
  console.log('  truth \\ tier     SURE  POSSIBLE  NEAR-MISS  NOTHING    n');
  for (const l of LABELS) {
    const g = rs.filter((r) => r.label === l);
    if (!g.length) continue;
    const c = (t: Tier) => g.filter((r) => r[k] === t).length;
    console.log(`  ${l.toUpperCase().padEnd(14)} ${pad(c('sure'), 5)} ${pad(c('possible'), 9)} ${pad(c('near-miss'), 10)} ${pad(c('nothing'), 8)} ${pad(g.length, 4)}`);
  }
  const intro = (t: Tier) => t === 'sure' || t === 'possible';
  const exact = rs.filter((r) => r[k] === r.label).length;
  // Introductions: sure / possible / none (near-miss and nothing both introduce nobody).
  const three = (t: Tier) => (intro(t) ? t : 'none');
  const exact3 = rs.filter((r) => three(r[k]) === three(r.label)).length;
  const falseSure = rs.filter((r) => (r.label === 'nothing' || r.label === 'near-miss') && r[k] === 'sure').length;
  const falseIntro = rs.filter((r) => !intro(r.label) && intro(r[k])).length;
  const vanished = rs.filter((r) => r.label !== 'nothing' && r[k] === 'nothing').length;
  const nmOnNothing = rs.filter((r) => r.label === 'nothing' && r[k] === 'near-miss').length;
  console.log(
    `  exact (4 answers) ${exact}/${rs.length}   exact (sure/possible/no introduction) ${exact3}/${rs.length}   ` +
      `false SURE on a non-introduction: ${falseSure}   false introduction: ${falseIntro}   ` +
      `labelled near miss or better that ended NOTHING: ${vanished}   NOTHING pairs shown as a near miss: ${nmOnNothing}`,
  );
}

const asked = rows.filter((r) => r.asked);
const answered = asked.filter((r) => r.jev);
const lat = answered.map((r) => r.latencyMs!).sort((a, b) => a - b);
const q = (f: number) => lat[Math.min(lat.length - 1, Math.floor(lat.length * f))];
console.log(`# Borderline judge calibration: ${rows.length} pairs (${LABELS.map((l) => `${l} ${rows.filter((r) => r.label === l).length}`).join(', ')})`);
console.log(
  `Jev asked on ${asked.length}; answered ${answered.length} (${rows.filter((r) => r.fresh).length} fresh calls this run, ${calls} attempted; the rest from the cache); ` +
    `no answer ${asked.length - answered.length}${asked.length > answered.length ? ' (' + asked.filter((r) => !r.jev).map((r) => `${r.id}:${r.err}`).join(', ') + ')' : ''}`,
);
if (lat.length) console.log(`Jev latency ms (as recorded when answered): median ${q(0.5)}, p95 ${q(0.95)}, max ${lat[lat.length - 1]}`);
confusion('RULES ONLY', 'rules');
confusion('RULES + JEV, NO NEAR-MISS FLOOR', 'before');
confusion(`RULES + JEV, WITH THE NEAR-MISS FLOOR (same kind >= ${JEV_NEAR_MISS_SAME_KIND_MIN})`, 'after');
const newer = rows.filter((r) => /^m/.test(r.id));
if (newer.length) {
  confusion('m01-m20 (lend, borrow, hire, give away, swap; goods against services): RULES ONLY', 'rules', newer);
  confusion('m01-m20: RULES + JEV, BEFORE THE FLOOR', 'before', newer);
  confusion('m01-m20: RULES + JEV, WITH THE FLOOR', 'after', newer);
}
console.log('\n## Pairs the floor changed');
for (const r of rows.filter((r) => r.before !== r.after)) {
  const p = pairs[order.get(r.id)!];
  console.log(`  ${r.id} truth ${r.label}: rules ${r.rules}, jev ${r.jev} (same_kind ${r.nouls!.same_kind.toFixed(2)}, compatible ${r.nouls!.compatible.toFixed(2)}) -> ${r.after}   "${p.want.kind}" vs "${p.have.kind}"`);
}
console.log('\n## Every pair where the final answer differs from the label');
for (const r of rows.filter((r) => r.after !== r.label)) {
  const p = pairs[order.get(r.id)!];
  console.log(`  ${r.id} ${r.label.toUpperCase()} -> ${r.after.toUpperCase()} (rules ${r.rules}${r.nouls ? `; jev ${r.jev}, same_kind ${r.nouls.same_kind.toFixed(2)} compatible ${r.nouls.compatible.toFixed(2)}` : r.asked ? `; jev ${r.err}` : '; not asked'})   "${p.want.kind}" vs "${p.have.kind}"`);
}
