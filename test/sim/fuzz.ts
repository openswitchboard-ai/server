/**
 * Randomised, SEEDED, reproducible fuzz mode that stress-tests the LIVE matcher.
 *
 * Each round builds a WANT + HAVE pair and lets the REAL matching engine decide.
 * It never inserts a match itself:
 *
 *   - a COMPATIBLE round publishes a pair inside the match-preserving envelope
 *     (same opaque island bucket, compatible category, WANT ceiling >= HAVE
 *     floor, a reach combo that still covers both sides) and POLLS the DB for
 *     the matcher to pair them. A pair that never matches is a FINDING.
 *   - an INCOMPATIBLE round deliberately breaks exactly one hard rule (band gap,
 *     category mismatch, or geo out of range) and asserts NO match appears. A
 *     pair that matches anyway is a FINDING (a false match — serious).
 *
 * The envelope is randomised within what genuinely still matches (attributes,
 * price-band width, radius, reach combo, taxonomy leaf), so the matcher sees
 * real variety rather than one template. Match observation is DB-based, off the
 * per-account 60/h MCP read ceiling, so a throttled read pool never poisons the
 * classification; RATE_LIMITED on the agent-facing ladder walk is an expected
 * throttle, never a fuzz failure. Every agent-facing payload is still swept for
 * the universal invariants.
 *
 * It reuses the existing pool (no new accounts) so it stays inside the per-IP
 * limits, respects every per-account quota (cards are reclaimed between rounds),
 * and — because it observes the matcher through the DB — is isolated from the
 * red-team's read-ceiling hammer. The runner also schedules fuzz BEFORE the
 * red-team for that reason.
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

/** Taxonomy leaves with realistic, screening-safe attribute templates. Both
 *  cards in a pair share the category and core attributes, so their canonical
 *  projections embed close together (a WANT and a HAVE for the same thing must
 *  land near each other) and the semantic component clears the match threshold.
 *  Only `priced` categories carry a price band; `social.*` has none. */
interface Cat {
  category: string;
  priced: boolean;
  attrs: (pick: <T>(xs: readonly T[]) => T) => Record<string, unknown>;
}
const CATS: Cat[] = [
  { category: 'goods.electronics.camera', priced: true, attrs: (p) => ({ condition: p(['good', 'fair', 'as-new']), brand: 'canon', model: 'eos r10' }) },
  { category: 'goods.electronics.laptop', priced: true, attrs: (p) => ({ condition: p(['good', 'fair', 'as-new']), brand: 'apple', model: 'macbook air' }) },
  { category: 'goods.bicycle.mountain', priced: true, attrs: (p) => ({ condition: p(['good', 'fair']), frame_size: p(['s', 'm', 'l']) }) },
  { category: 'goods.furniture.sofa', priced: true, attrs: (p) => ({ condition: p(['good', 'fair']), seats: p([2, 3, 4]) }) },
  { category: 'goods.music.guitar', priced: true, attrs: (p) => ({ condition: p(['good', 'as-new']), brand: 'yamaha', body: p(['acoustic', 'classical']) }) },
  { category: 'goods.tools.power', priced: true, attrs: (p) => ({ condition: p(['good', 'fair']), power: p(['corded', 'cordless']) }) },
  { category: 'social.language-exchange', priced: false, attrs: (p) => ({ language: p(['italian', 'french', 'japanese']), level: p(['beginner', 'intermediate']) }) },
];
const REACHES = ['radius', 'country', 'anywhere'] as const;

/** A compatible pair that the matcher failed to pair, or an incompatible pair
 *  the matcher paired anyway — both are real matcher bugs, surfaced with a full
 *  repro. */
export interface FuzzFinding {
  kind: 'compatible-no-match' | 'incompatible-match';
  seed: number;
  round: number;
  reason?: 'band-gap' | 'category' | 'geo'; // why the incompatible round should not match
  wantId: string;
  haveId: string;
  category: string;
  want: { bucket: string; band: string; reach: string; radius_km: number };
  have: { category: string; bucket: string; band: string; reach: string; radius_km: number };
  matchId?: string; // set for a false match
}

export interface FuzzOutcome {
  seed: number;
  rounds: number;
  compatibleMatched: number;
  compatibleNoMatch: number;
  incompatibleUnmatched: number;
  incompatibleMatched: number;
  channelsOpened: number;
  rateLimited: number;
  skipped: number;
  findings: FuzzFinding[];
  firstViolationRepro?: { seed: number; sequence: string[] };
}

const bandStr = (b?: { min?: number; max?: number }): string => (b ? `${b.min ?? '-'}..${b.max ?? '-'}` : 'none');

export async function runFuzz(
  h: Harness,
  check: Checker,
  opts: { seed: number; rounds: number },
): Promise<FuzzOutcome> {
  const rand = rng(opts.seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
  const pool = h.actors;
  const matchTimeoutMs = Number(process.env.SIM_FUZZ_MATCH_TIMEOUT_MS ?? 90_000);
  const noMatchSettleMs = Number(process.env.SIM_FUZZ_NOMATCH_SETTLE_MS ?? 30_000);

  const outcome: FuzzOutcome = {
    seed: opts.seed,
    rounds: 0,
    compatibleMatched: 0,
    compatibleNoMatch: 0,
    incompatibleUnmatched: 0,
    incompatibleMatched: 0,
    channelsOpened: 0,
    rateLimited: 0,
    skipped: 0,
    findings: [],
  };
  const sequence: string[] = [];

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

  /** A card in the opaque geo bucket `b`, with the chosen reach + radius. */
  const geoOf = (b: string, reach: string, radius: number) =>
    reach === 'radius' ? { bucket: b, radius_km: radius } : { bucket: b, radius_km: radius, reach };
  const mk = (
    type: 'WANT' | 'HAVE',
    category: string,
    geo: Record<string, unknown>,
    attributes: Record<string, unknown>,
    band?: { min?: number; max?: number },
  ) => ({
    schema_version: SCHEMA_VERSION,
    type,
    category,
    geo,
    ttl_days: 1,
    attributes,
    ...(band ? { price: { band, ccy: 'AUD' } } : {}),
  });

  for (let round = 0; round < opts.rounds; round++) {
    outcome.rounds++;
    // two distinct actors
    const wA = pool[Math.floor(rand() * pool.length)];
    let hB = pool[Math.floor(rand() * pool.length)];
    for (let g = 0; g < 5 && hB === wA; g++) hB = pool[Math.floor(rand() * pool.length)];
    if (hB === wA) {
      outcome.skipped++;
      continue;
    }

    // Alternate deterministically so both classes are always exercised even at
    // a small round count; the seed drives all the envelope variety within.
    const compatible = round % 2 === 0;
    const cat = pick(CATS);
    const wReach = pick(REACHES);
    const hReach = pick(REACHES);
    const radiusW = pick([10, 25, 50]);
    const radiusH = pick([10, 25, 50]);

    // Shared, screening-safe attributes so the WANT and HAVE embed close.
    const baseAttrs = cat.attrs(pick);
    const wantAttrs = { ...baseAttrs };
    const haveAttrs = rand() < 0.5 ? { ...baseAttrs, year: 2020 + Math.floor(rand() * 5) } : { ...baseAttrs };

    let reason: FuzzFinding['reason'] | undefined;
    let wCard, hCard;
    let haveCategory = cat.category;
    let wBucket = h.bucket();
    let hBucket = wBucket; // same island by default (compatible / band-gap / category)
    // The bands we actually SEND, kept for the finding repro (a publish result
    // never echoes a band back — bands never leave the engine).
    let wBand: { min?: number; max?: number } | undefined;
    let hBand: { min?: number; max?: number } | undefined;

    try {
      if (compatible) {
        // WANT ceiling comfortably clears HAVE floor (or WANT declares no band).
        if (cat.priced) {
          const floor = pick([100, 200, 300, 400]);
          const ceil = floor + pick([100, 300, 600, 900]); // ceiling >= floor, overlapping
          wBand = rand() < 0.2 ? undefined : { min: 0, max: ceil };
          hBand = { min: floor, max: floor + pick([0, 50, 150]) };
        }
        wCard = await h.publish(wA, mk('WANT', cat.category, geoOf(wBucket, wReach, radiusW), wantAttrs, wBand), { expectError: true });
        hCard = await h.publish(hB, mk('HAVE', cat.category, geoOf(hBucket, hReach, radiusH), haveAttrs, hBand), { expectError: true });
      } else {
        reason = pick(cat.priced ? (['band-gap', 'category', 'geo'] as const) : (['category', 'geo'] as const));
        if (reason === 'band-gap') {
          // WANT ceiling sits BELOW HAVE floor.
          wBand = { min: 0, max: pick([30, 50, 80]) };
          hBand = { min: pick([300, 400, 600]), max: pick([300, 400, 600]) };
        } else if (reason === 'category') {
          // HAVE is a taxonomy leaf that is neither the WANT's category nor an
          // ancestor/descendant of it.
          let other = pick(CATS);
          for (let g = 0; g < 6 && other.category === cat.category; g++) other = pick(CATS);
          haveCategory = other.category;
          if (cat.priced) wBand = { min: 0, max: 900 };
          if (other.priced) hBand = { min: 100, max: 100 };
        } else {
          // geo: two DISTINCT islands (radius reach on both), guaranteed no
          // prefix overlap. Everything else stays compatible so ONLY geo fails.
          for (let g = 0; g < 8 && (hBucket === wBucket || hBucket.startsWith(wBucket) || wBucket.startsWith(hBucket)); g++) {
            hBucket = h.bucket();
          }
          if (cat.priced) {
            wBand = { min: 0, max: 900 };
            hBand = { min: 200, max: 200 };
          }
        }
        const wr = reason === 'geo' ? 'radius' : wReach;
        const hr = reason === 'geo' ? 'radius' : hReach;
        wCard = await h.publish(wA, mk('WANT', cat.category, geoOf(wBucket, wr, radiusW), wantAttrs, wBand), { expectError: true });
        hCard = await h.publish(hB, mk('HAVE', haveCategory, geoOf(hBucket, hr, radiusH), haveAttrs, hBand), { expectError: true });
      }
    } catch (e) {
      log(`fuzz round ${round}: publish threw ${String(e).slice(0, 120)}`);
      outcome.skipped++;
      await h.reclaimCards();
      continue;
    }

    // Quota / screening / rate-limit refusals at publish are expected outcomes
    // in fuzz — not a matcher finding. Skip the round.
    if (wCard.isError || hCard.isError) {
      if (wCard.result?.code === 'RATE_LIMITED' || hCard.result?.code === 'RATE_LIMITED') outcome.rateLimited++;
      outcome.skipped++;
      await h.reclaimCards();
      continue;
    }

    // Both must reach PUBLISHED for the matcher to see them. A SCREENING_REJECTED
    // (or a stalled read) is a skip, never a matcher finding.
    let wState: string | undefined, hState: string | undefined;
    try {
      [wState, hState] = await Promise.all([
        h.waitCardDB(wCard.result.intent_id, ['PUBLISHED', 'SCREENING_REJECTED']),
        h.waitCardDB(hCard.result.intent_id, ['PUBLISHED', 'SCREENING_REJECTED']),
      ]);
    } catch (e) {
      log(`fuzz round ${round}: state wait stopped (${String(e).slice(0, 120)})`);
      outcome.skipped++;
      await h.reclaimCards();
      continue;
    }
    if (wState !== 'PUBLISHED' || hState !== 'PUBLISHED') {
      outcome.skipped++;
      await h.reclaimCards();
      continue;
    }

    const wId = wCard.result.intent_id;
    const hId = hCard.result.intent_id;
    const finding = (kind: FuzzFinding['kind'], matchId?: string): FuzzFinding => ({
      kind,
      seed: opts.seed,
      round,
      reason,
      wantId: wId,
      haveId: hId,
      category: cat.category,
      want: { bucket: wBucket, band: bandStr(wBand), reach: wReach, radius_km: radiusW },
      have: { category: haveCategory, bucket: hBucket, band: bandStr(hBand), reach: hReach, radius_km: radiusH },
      matchId,
    });

    if (compatible) {
      const matchId = await h.waitMatchDB(wId, hId, matchTimeoutMs);
      if (!matchId) {
        // The matcher never fired for a pair that should match — a finding, and
        // distinct from a rate-limit skip (reads here are DB-based).
        outcome.compatibleNoMatch++;
        const f = finding('compatible-no-match');
        outcome.findings.push(f);
        log(`fuzz round ${round}: FINDING compatible-but-NO-match — ${cat.category} bucket=${wBucket} wReach=${wReach} hReach=${hReach} want=${wId.slice(0, 8)} have=${hId.slice(0, 8)}`);
        await h.reclaimCards();
        continue;
      }
      outcome.compatibleMatched++;
      h.registerMatch(wA.accessToken, matchId);
      log(`fuzz round ${round}: live matcher paired ${cat.category} (${matchId.slice(0, 8)})`);

      // Walk the ladder on the real match, sweeping every agent-facing payload
      // for the universal invariants. RATE_LIMITED here is an expected throttle:
      // stop the walk for this round, keep the classification.
      const seq: [SimActor, string, Record<string, unknown>][] = [
        [wA, 'respond', { match_id: matchId, action: 'express_interest' }],
        [hB, 'respond', { match_id: matchId, action: 'express_interest' }],
        [wA, 'check_matches', {}],
        [wA, 'open_conversation', { match_id: matchId }],
        [wA, 'send_message', { match_id: matchId, text: `fuzz ${round} hello` }],
        [hB, 'collect_messages', { match_id: matchId }],
        [wA, 'check_matches', {}],
      ];
      for (const [actor, tool, args] of seq) {
        const r = await step(actor, tool, args);
        if (r.isError && r.result?.code === 'RATE_LIMITED') break; // expected throttle
        if (tool === 'check_matches' && !args.stage) check.matchesView(r, `fuzz r${round} ${actor.label} sweep`);
        else check.sweep(r.raw, `fuzz r${round} ${actor.label} ${tool}`);
        if (tool === 'open_conversation' && !r.isError) outcome.channelsOpened++;
        noteViolation();
      }
      await step(wA, 'respond', { match_id: matchId, action: 'archive' });
    } else {
      // Give the matcher time to have run over both cards, then check: any match
      // between them is a FALSE match (serious).
      await new Promise((r) => setTimeout(r, noMatchSettleMs));
      const matchId = await h.matchBetween(wId, hId);
      if (matchId) {
        outcome.incompatibleMatched++;
        h.registerMatch(wA.accessToken, matchId); // clean it up on teardown
        const f = finding('incompatible-match', matchId);
        outcome.findings.push(f);
        log(`fuzz round ${round}: FINDING incompatible-but-MATCHED (${reason}) — a FALSE match ${matchId.slice(0, 8)}: want ${cat.category} ${wId.slice(0, 8)} × have ${haveCategory} ${hId.slice(0, 8)}`);
      } else {
        outcome.incompatibleUnmatched++;
        log(`fuzz round ${round}: incompatible (${reason}) correctly produced no match`);
      }
    }

    await h.reclaimCards();
    noteViolation();
  }

  return outcome;
}
