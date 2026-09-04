/**
 * OpenSwitchboard simulation + invariant-checking harness — entrypoint.
 *
 *   RUN_SIM=1 AWS_PROFILE=openswitchboard OSB_RATELIMIT_BYPASS=<token> \
 *     npx tsx test/sim/run.ts
 *
 * Flags / env:
 *   --clean              tear down leftover sim cards from prior runs and exit
 *   SIM_ACTORS=<n>       pool size (default 4; needs the bypass token to exceed
 *                        ~5, or the per-IP DCR/email limiter refuses the rest)
 *   SIM_FUZZ_ROUNDS=<n>  fuzz rounds (default 4; 0 to skip)
 *   SIM_SEED=<n>         fuzz seed (default from the clock; printed for repro)
 *   SIM_GEO_REACH=0      skip the (slow, real-place) reach-combo geo sub-case
 *   SIM_REDTEAM_RATE=0   skip the read-ceiling hammer (spends a whole actor-hour)
 *
 * Gated OFF by default: refuses to start unless RUN_SIM=1, so `npm test` (which
 * only runs test/unit + conformance) never touches it.
 */
import { mcpRpc } from '../integration/helpers.js';
import { runFuzz } from './fuzz.js';
import { Checker } from './checker.js';
import {
  Harness,
  SCHEMA_VERSION,
  actorIdentityStrings,
  dbExec,
  group,
  groupEnd,
  log,
} from './harness.js';
import { RedTeamResult, runRedTeam } from './redteam.js';
import { SCENARIOS, ScenarioCtx } from './scenarios.js';

interface ScenarioReport {
  name: string;
  status: 'pass' | 'fail' | 'skip';
  detail?: string;
}

async function cleanLeftovers(): Promise<void> {
  // Withdraw PUBLISHED sim cards from prior runs, by the opaque fixture-bucket
  // shape the harness uses ('sm_ab12'). Older-than guard keeps a live run's own
  // cards safe. Mirrors scripts/withdraw-fixture-cards.ts but scoped to sim.
  const olderThan = process.env.SIM_CLEAN_OLDER_THAN ?? '10 minutes';
  if (!/^\d+ (minute|hour|day)s?$/.test(olderThan)) {
    throw new Error(`SIM_CLEAN_OLDER_THAN must look like "10 minutes", got ${olderThan}`);
  }
  const where = `lifecycle_state = 'PUBLISHED'
     AND geo->>'bucket' ~ '^(sm|sim)_[0-9a-f]{2,10}$'
     AND created_at < now() - interval '${olderThan}'`;
  const before = await dbExec(
    `SELECT split_part(geo->>'bucket','_',1) || '_' AS p, count(*)::text FROM cards WHERE ${where} GROUP BY 1`,
  );
  const total = before.reduce((n, [, c]) => n + Number(c), 0);
  log(`--clean: ${total} leftover sim cards older than ${olderThan}`);
  for (const [p, c] of before) log(`  ${p} ${c}`);
  if (total === 0) return;
  const done = await dbExec(
    `UPDATE cards SET lifecycle_state = 'WITHDRAWN', updated_at = now() WHERE ${where} RETURNING id::text`,
  );
  log(`--clean: withdrew ${done.length} cards`);
}

async function main(): Promise<number> {
  if (process.env.RUN_SIM !== '1') {
    log('refusing to run: set RUN_SIM=1 to run the simulation harness against a live deployment.');
    return 2;
  }
  if (process.argv.includes('--clean')) {
    await cleanLeftovers();
    return 0;
  }

  const hasBypass = !!process.env.OSB_RATELIMIT_BYPASS;
  const requestedActors = Number(process.env.SIM_ACTORS ?? 4);
  const nActors = hasBypass ? requestedActors : Math.min(requestedActors, 4);
  const fuzzRounds = Number(process.env.SIM_FUZZ_ROUNDS ?? 4);
  const seed = Number(process.env.SIM_SEED ?? (Date.now() & 0xffffffff));

  const h = new Harness();
  log('='.repeat(72));
  log(`OpenSwitchboard simulation harness — run ${h.runId}`);
  log(`target ${process.env.OSB_BASE_URL ?? 'https://mcp-dev.openswitchboard.ai'}`);
  log(`rate-limit bypass: ${hasBypass ? 'ON (per-IP limiters skipped; per-account quotas still enforced)' : 'OFF (per-IP limited — pool capped at 4)'}`);
  log(`actors=${nActors}  fuzz_rounds=${fuzzRounds}  seed=${seed}`);
  log('='.repeat(72));

  // Schema version dev is on — read from the live server once the pool is up.
  let serverSchema = SCHEMA_VERSION;

  const scenarioReports: ScenarioReport[] = [];
  let redTeam: RedTeamResult[] = [];
  let fuzzOutcome: Awaited<ReturnType<typeof runFuzz>> | undefined;
  let residueBefore = -1;
  let residueAfter = -1;
  let check: Checker | undefined;

  try {
    group('creating actor pool');
    await h.createPool(nActors, 'bootstrap');
    log(`pool up: ${h.actors.map((a) => a.label).join(', ')}`);
    groupEnd();

    check = new Checker(actorIdentityStrings(h.actors));

    // Schema version the live server reports.
    try {
      const init = await mcpRpc(h.actors[0].accessToken, 'initialize', {
        protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'osb-sim', version: '0.0.1' },
      });
      serverSchema = init.result?.serverInfo?.version ?? serverSchema;
      // Assert the live tool surface has no accept path (I3).
      const tools = await mcpRpc(h.actors[0].accessToken, 'tools/list', {});
      check.tools(tools.result.tools.map((t: any) => t.name), 'live tools/list');
    } catch (e) {
      log(`schema/tool probe failed: ${String(e).slice(0, 160)}`);
    }

    residueBefore = await h.boardResidue();
    log(`board residue in this run's buckets before scenarios: ${residueBefore}`);

    // ---- scenarios ------------------------------------------------------
    // Rotate which actors each scenario leads with, so no single account's
    // shared 60/h read ceiling is exhausted before the run finishes.
    // SIM_SKIP_SCENARIOS=1 leaves each account's whole 10/day publish budget to
    // fuzz — useful for a fuzz-focused pass on a small (per-IP-capped) pool,
    // where the scenarios would otherwise spend most of the publish quota first.
    const skipScenarios = process.env.SIM_SKIP_SCENARIOS === '1';
    for (const [i, s] of (skipScenarios ? [] : SCENARIOS).entries()) {
      group(`scenario: ${s.name}`);
      if (h.actors.length < s.minActors) {
        log(`skipped — needs ${s.minActors} actors, pool has ${h.actors.length}`);
        scenarioReports.push({ name: s.name, status: 'skip', detail: `needs ${s.minActors} actors` });
        groupEnd();
        continue;
      }
      const off = i % h.actors.length;
      const rotated = [...h.actors.slice(off), ...h.actors.slice(0, off)];
      const ctx: ScenarioCtx = { h, check, actors: rotated };
      try {
        await s.run(ctx);
        scenarioReports.push({ name: s.name, status: 'pass' });
        log('PASS');
      } catch (e) {
        scenarioReports.push({ name: s.name, status: 'fail', detail: String(e) });
        log(`FAIL — ${String(e)}`);
      } finally {
        await h.reclaimCards(); // free open-intent quota for the next scenario
      }
      groupEnd();
    }

    // ---- fuzz -----------------------------------------------------------
    // Runs BEFORE the red-team: the red-team's R4 exhausts an actor's 60/h read
    // ceiling, and although fuzz observes the matcher through the DB (off that
    // ceiling), its ladder walk is agent-facing — keeping fuzz first means a
    // clean pool for it, so a compatible-but-no-match is never confused with a
    // rate-limited read.
    if (fuzzRounds > 0) {
      group(`fuzz mode (seed ${seed}, ${fuzzRounds} rounds)`);
      try {
        fuzzOutcome = await runFuzz(h, check, { seed, rounds: fuzzRounds });
      } catch (e) {
        log(`fuzz threw: ${String(e)}`);
      } finally {
        await h.reclaimCards();
      }
      groupEnd();
    }

    // ---- red team -------------------------------------------------------
    // SIM_SKIP_REDTEAM=1 pairs with SIM_SKIP_SCENARIOS for a fuzz-only pass.
    if (process.env.SIM_SKIP_REDTEAM === '1') {
      log('red-team driver skipped (SIM_SKIP_REDTEAM=1)');
    } else {
      group('red-team driver');
      try {
        redTeam = await runRedTeam(h, check, h.actors);
      } catch (e) {
        log(`red-team driver threw: ${String(e)}`);
      } finally {
        await h.reclaimCards();
      }
      groupEnd();
    }
  } finally {
    // ---- cleanup --------------------------------------------------------
    group('cleanup');
    const td = await h.teardown();
    log(`withdrew ${td.cardsWithdrawn} residual cards, archived ${td.matchesArchived} matches`);
    try {
      residueAfter = await h.boardResidue();
    } catch (e) {
      log(`residue check failed: ${String(e)}`);
    }
    log(`board residue in this run's buckets after cleanup: ${residueAfter}`);
    groupEnd();
  }

  // ---- report -----------------------------------------------------------
  const violations = check?.violations ?? [];
  log('');
  log('#'.repeat(72));
  log('REPORT');
  log('#'.repeat(72));
  log(`schema version (const): ${SCHEMA_VERSION}   server serverInfo.version: ${serverSchema}`);
  log('');
  log('Scenarios:');
  for (const r of scenarioReports) {
    log(`  [${r.status.toUpperCase()}] ${r.name}${r.detail ? ' — ' + r.detail.slice(0, 200) : ''}`);
  }
  log('');
  log('Red-team attempts (each must be correctly refused):');
  for (const r of redTeam) {
    log(`  [${r.refused ? 'REFUSED' : 'GOT THROUGH'}] ${r.id} ${r.attempt}${r.detail ? ' — ' + r.detail : ''}`);
  }
  log('');
  if (fuzzOutcome) {
    const f = fuzzOutcome;
    log(`Fuzz (live matcher): seed=${f.seed} rounds=${f.rounds}`);
    log(`  compatible-and-matched:        ${f.compatibleMatched}`);
    log(`  compatible-but-NO-match:       ${f.compatibleNoMatch}${f.compatibleNoMatch ? '  <-- FINDING' : ''}`);
    log(`  incompatible-and-unmatched:    ${f.incompatibleUnmatched}`);
    log(`  incompatible-but-MATCHED:      ${f.incompatibleMatched}${f.incompatibleMatched ? '  <-- FINDING (false match)' : ''}`);
    log(`  skipped (quota/screening/rl):  ${f.skipped}   channels opened: ${f.channelsOpened}   rate_limited: ${f.rateLimited}`);
    for (const fd of f.findings) {
      if (fd.kind === 'compatible-no-match') {
        log(`  FINDING compatible-but-NO-match (seed ${fd.seed}, round ${fd.round}):`);
        log(`    category=${fd.category}  want=${fd.wantId} have=${fd.haveId}`);
        log(`    want  bucket=${fd.want.bucket} band=${fd.want.band} reach=${fd.want.reach} radius=${fd.want.radius_km}km`);
        log(`    have  bucket=${fd.have.bucket} band=${fd.have.band} reach=${fd.have.reach} radius=${fd.have.radius_km}km`);
      } else {
        log(`  FINDING incompatible-but-MATCHED / FALSE MATCH (seed ${fd.seed}, round ${fd.round}, broke=${fd.reason}):`);
        log(`    intro_id=${fd.matchId}  want=${fd.category} ${fd.wantId}  have=${fd.have.category} ${fd.haveId}`);
        log(`    want bucket=${fd.want.bucket} reach=${fd.want.reach}  have bucket=${fd.have.bucket} reach=${fd.have.reach}`);
      }
    }
    if (fuzzOutcome.firstViolationRepro) {
      log(`  first invariant-violation repro — seed ${fuzzOutcome.firstViolationRepro.seed}, call sequence:`);
      for (const s of fuzzOutcome.firstViolationRepro.sequence) log(`    ${s}`);
    }
    log('');
  }
  log('Invariant violations:');
  if (violations.length === 0) {
    log('  none — all universal properties held across every scenario, red-team probe and fuzz step.');
  } else {
    for (const v of violations) {
      log(`  [${v.invariant}] ${v.detail}`);
      log(`      where: ${v.where}`);
      if (v.payload) log(`      payload: ${v.payload}`);
    }
  }
  log('');
  log('Board cleanliness:');
  log(`  residue before: ${residueBefore}   residue after cleanup: ${residueAfter}`);
  log(`  MCP calls: ${h.mcpCalls}   accounts created: ${h.actors.length}   RATE_LIMITED seen: ${h.rateLimited}`);
  log('#'.repeat(72));

  const scenarioFailed = scenarioReports.some((r) => r.status === 'fail');
  const redTeamGotThrough = redTeam.some((r) => !r.refused);
  const invariantBroke = violations.length > 0;
  const dirtyBoard = residueAfter > 0;
  // A compatible pair the matcher never paired, or an incompatible pair it
  // paired anyway, is a real matcher bug — fail the run.
  const matcherBug = !!fuzzOutcome && (fuzzOutcome.compatibleNoMatch > 0 || fuzzOutcome.incompatibleMatched > 0);
  const ok = !scenarioFailed && !redTeamGotThrough && !invariantBroke && !dirtyBoard && !matcherBug;
  log(ok ? 'RESULT: PASS' : 'RESULT: FAIL (see findings above)');
  return ok ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    // eslint-disable-next-line no-console
    console.error('sim harness crashed:', e);
    process.exit(3);
  });
