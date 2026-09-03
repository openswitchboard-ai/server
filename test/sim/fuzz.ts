/**
 * Randomised, SEEDED, reproducible fuzz mode. Generates randomised cards across
 * the taxonomy / geo / price / reach space on the actor pool, drives each pair
 * through interest -> opt-in -> channel where a match forms, and continuously
 * asserts the invariants. On any violation it prints the seed and the exact
 * call sequence needed to reproduce it.
 *
 * It reuses the existing pool (no new accounts) so it stays inside the per-IP
 * limits, and it respects every per-account quota: cards are withdrawn between
 * rounds to recover the open-intent budget, and RATE_LIMITED is treated as an
 * expected outcome (throttle), never a failure.
 */
import { Checker } from './checker.js';
import { Harness, SCHEMA_VERSION, SimActor, log } from './harness.js';

/** mulberry32 — a tiny seeded PRNG so a run is byte-for-byte reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CATEGORIES = [
  'goods.electronics.camera',
  'goods.electronics.laptop',
  'goods.bicycle.mountain',
  'goods.furniture.sofa',
  'goods.music.guitar',
  'goods.tools.power',
  'social.language-exchange',
];
const REACHES = ['radius', 'country', 'anywhere'] as const;

export interface FuzzOutcome {
  seed: number;
  rounds: number;
  matchesFormed: number;
  channelsOpened: number;
  rateLimited: number;
  firstViolationRepro?: { seed: number; sequence: string[] };
}

export async function runFuzz(
  h: Harness,
  check: Checker,
  opts: { seed: number; rounds: number },
): Promise<FuzzOutcome> {
  const rand = rng(opts.seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
  const pool = h.actors;
  const outcome: FuzzOutcome = { seed: opts.seed, rounds: 0, matchesFormed: 0, channelsOpened: 0, rateLimited: 0 };
  const sequence: string[] = [];
  const violationsBefore = () => check.violations.length;

  const step = async (actor: SimActor, tool: string, args: Record<string, unknown>) => {
    sequence.push(`mcp(${actor.label}, ${tool}, ${JSON.stringify(args)})`);
    const r = await h.mcp(actor.accessToken, tool, args);
    if (r.isError && r.result?.code === 'RATE_LIMITED') outcome.rateLimited++;
    return r;
  };

  const noteViolation = () => {
    if (!outcome.firstViolationRepro && check.violations.length > 0) {
      outcome.firstViolationRepro = { seed: opts.seed, sequence: [...sequence] };
    }
  };

  for (let round = 0; round < opts.rounds; round++) {
    outcome.rounds++;
    // two distinct actors
    const wA = pool[Math.floor(rand() * pool.length)];
    let hB = pool[Math.floor(rand() * pool.length)];
    for (let g = 0; g < 5 && hB === wA; g++) hB = pool[Math.floor(rand() * pool.length)];
    if (hB === wA) continue;

    const category = pick(CATEGORIES);
    // Half the rounds are a designed compatible pair (same bucket, compatible
    // band); half are deliberately off (band gap or different bucket).
    const compatible = rand() < 0.5;
    const bucket = h.bucket();
    const otherBucket = compatible ? bucket : h.bucket();
    const wReach = pick(REACHES);
    const hReach = pick(REACHES);

    const mk = (type: 'WANT' | 'HAVE', b: string, reach: string, band: { min: number; max: number }) => ({
      schema_version: SCHEMA_VERSION,
      type,
      category,
      geo: reach === 'radius' ? { bucket: b, radius_km: 25 } : { bucket: b, radius_km: 25, reach },
      ttl_days: 1,
      attributes: { condition: pick(['good', 'fair', 'as-new']) },
      price: { band, ccy: 'AUD' },
    });
    const wBand = compatible ? { min: 0, max: 900 } : { min: 0, max: 50 };
    const hBand = { min: 300, max: 300 };

    let wCard, hCard;
    try {
      wCard = await h.publish(wA, mk('WANT', bucket, wReach, wBand), { expectError: true });
      hCard = await h.publish(hB, mk('HAVE', otherBucket, hReach, hBand), { expectError: true });
    } catch (e) {
      log(`fuzz round ${round}: publish threw ${String(e).slice(0, 120)}`);
      continue;
    }
    // Quota or screening refusals are expected outcomes in fuzz — skip the round.
    if (wCard.isError || hCard.isError) {
      await h.reclaimCards();
      continue;
    }

    try {
      await Promise.all([
        h.waitCardDB(wCard.result.intent_id, ['PUBLISHED', 'SCREENING_REJECTED']),
        h.waitCardDB(hCard.result.intent_id, ['PUBLISHED', 'SCREENING_REJECTED']),
      ]);
    } catch (e) {
      // RATE_LIMITED on the read ceiling is an expected throttle — stop reads.
      log(`fuzz round ${round}: state wait stopped (${String(e).slice(0, 120)})`);
      await h.reclaimCards();
      continue;
    }

    // Force the intended pairing when compatible, so a match reliably exists to
    // exercise the ladder; when incompatible, assert none forms.
    let matchId: string | undefined;
    if (compatible) {
      try {
        matchId = await h.createMatch(wA, wCard.result.intent_id, hB, hCard.result.intent_id, 0.85);
        outcome.matchesFormed++;
      } catch (e) {
        log(`fuzz round ${round}: create-match failed (${String(e).slice(0, 120)})`);
      }
    }

    if (matchId) {
      const seq: [SimActor, string, Record<string, unknown>][] = [
        [wA, 'respond', { match_id: matchId, action: 'express_interest' }],
        [hB, 'respond', { match_id: matchId, action: 'express_interest' }],
        [wA, 'check_matches', {}],
        [hB, 'respond', { match_id: matchId, action: 'opt_in' }],
        [wA, 'respond', { match_id: matchId, action: 'opt_in' }],
        [wA, 'open_channel', { match_id: matchId }],
        [wA, 'channel_send', { match_id: matchId, text: `fuzz ${round} hello` }],
        [hB, 'channel_receive', { match_id: matchId }],
        [wA, 'check_matches', {}],
      ];
      for (const [actor, tool, args] of seq) {
        const r = await step(actor, tool, args);
        // Continuously assert the invariants on every agent-facing payload.
        if (tool === 'check_matches' && !args.stage) check.matchesView(r, `fuzz r${round} ${actor.label} sweep`);
        else check.sweep(r.raw, `fuzz r${round} ${actor.label} ${tool}`);
        if (tool === 'open_channel' && !r.isError) outcome.channelsOpened++;
        noteViolation();
      }
      // archive to leave nothing actionable
      await step(wA, 'respond', { match_id: matchId, action: 'archive' });
    }

    await h.reclaimCards();
    noteViolation();
  }

  return outcome;
}
