/**
 * ONE-TIME REMEDIATION — stop the eval agent greeting real people on dev.
 *
 * The realism and adversary evals (test/realism/run.ts, test/adversary/run.ts)
 * post real cards on the shared dev board and let the LIVE matcher pair them.
 * The matcher cannot tell an eval from an errand, so it paired the eval agent
 * (Nagatha) against REAL accounts' standing cards, and she greeted those people
 * — once per run, fifteen near-identical messages after fifteen runs.
 *
 * test/realism/outsiderGuard.ts stops that happening from now on. This script
 * clears the RESIDUE: every account Nagatha has already been paired with since
 * 2026-09-03 gets a permanent, pair-level mute in both directions, so nothing
 * either of them posts later can be matched again.
 *
 * WHY THIS SET. There is no way to pick the eval-bootstrapped accounts out by
 * email — addresses are only ever stored as a hash — so the residue is defined
 * by behaviour instead: whoever the eval agent has actually matched with in the
 * window. That set is the union of the throwaway counterpart accounts (harmless
 * to mute; they are single-run and already dead) and the real accounts we are
 * here to protect.
 *
 * WHAT IT WRITES. Rows in `match_mutes` only — the additive hygiene table the
 * matcher's candidate prefilter reads (src/domain/matcher.ts). Nothing in
 * matches, cards, accounts or any consent table is deleted or updated, and no
 * personal field is selected or printed: account ids and counts, nothing else.
 *
 * Run (dry by default):
 *   AWS_PROFILE=openswitchboard npx tsx scripts/mute-eval-outsiders.ts
 *   AWS_PROFILE=openswitchboard npx tsx scripts/mute-eval-outsiders.ts --apply
 * Options: --env dev  --since 2026-09-03  --agent <uuid>
 *
 * REFUSES to run against prod: the eval agent does not exist there, and this
 * script has no business writing mutes for real people's pairings.
 */
import { ExecuteStatementCommand, RDSDataClient } from '@aws-sdk/client-rds-data';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

/** Nagatha, the long-lived agent under test on dev. */
const DEFAULT_AGENT = '411af5b9-b2a9-4126-83f8-73bf4934f5dd';
/** The evals started leaving this residue on the shared board on 2026-09-03. */
const DEFAULT_SINCE = '2026-09-03';

const envName = arg('env', 'dev');
const agent = arg('agent', DEFAULT_AGENT).toLowerCase();
const since = arg('since', DEFAULT_SINCE);
const apply = process.argv.includes('--apply');
const region = process.env.AWS_REGION ?? 'us-east-1';

if (envName === 'prod') {
  console.error('refusing to run against prod');
  process.exit(1);
}
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(agent)) {
  console.error(`--agent must be a uuid, got ${agent}`);
  process.exit(1);
}
if (!/^\d{4}-\d{2}-\d{2}([T ].*)?$/.test(since)) {
  console.error(`--since must look like 2026-09-03, got ${since}`);
  process.exit(1);
}

const ssm = new SSMClient({ region });
const rds = new RDSDataClient({ region });
const [cluster, secret] = await Promise.all([
  ssm.send(new GetParameterCommand({ Name: `/osb/${envName}/db/cluster-arn` })),
  ssm.send(new GetParameterCommand({ Name: `/osb/${envName}/db/secret-arn` })),
]);
const arns = { resourceArn: cluster.Parameter!.Value!, secretArn: secret.Parameter!.Value! };

async function sql(
  statement: string,
  parameters: { name: string; value: string }[] = [],
): Promise<any[][]> {
  const r = await rds.send(
    new ExecuteStatementCommand({
      ...arns,
      database: 'osb',
      sql: statement,
      parameters: parameters.map((p) => ({ name: p.name, value: { stringValue: p.value } })),
    }),
  );
  return (r.records ?? []).map((row) =>
    row.map((f: any) => (f.isNull ? null : (f.stringValue ?? f.longValue ?? f.doubleValue ?? null))),
  );
}

// Who the eval agent has been paired with in the window. Ids only.
const rows = await sql(
  `SELECT DISTINCT CASE WHEN account_want = :agent::uuid THEN account_have ELSE account_want END::text
     FROM matches
    WHERE (account_want = :agent::uuid OR account_have = :agent::uuid)
      AND created_at > :since::timestamptz`,
  [
    { name: 'agent', value: agent },
    { name: 'since', value: since },
  ],
);
const counterparties = [...new Set(rows.map((r) => String(r[0]).toLowerCase()))].filter(
  (id) => id && id !== agent,
);

// Both directions, so the matcher's NOT EXISTS clause catches the pair whichever
// side is the candidate.
const pairs: [string, string][] = counterparties.flatMap(
  (other) => [[agent, other], [other, agent]] as [string, string][],
);

const already = await sql(
  `SELECT count(*)::text FROM match_mutes
    WHERE account_id = :agent::uuid OR muted_account = :agent::uuid`,
  [{ name: 'agent', value: agent }],
);

console.log(`${envName}: eval agent ${agent}`);
console.log(`  accounts paired with it since ${since}: ${counterparties.length}`);
console.log(`  mute rows this would write (both directions): ${pairs.length}`);
console.log(`  mute rows already on file for it: ${already[0]?.[0] ?? '0'}`);

if (!apply) {
  console.log('dry run — pass --apply to write the mutes');
  process.exit(0);
}
if (!pairs.length) {
  console.log('nothing to mute');
  process.exit(0);
}

// One statement per batch; ON CONFLICT DO NOTHING makes a re-run a no-op.
const CHUNK = 200;
let inserted = 0;
for (let i = 0; i < pairs.length; i += CHUNK) {
  const batch = pairs.slice(i, i + CHUNK);
  const values = batch.map((_, n) => `(:a${n}::uuid, :b${n}::uuid)`).join(', ');
  const parameters = batch.flatMap(([a, b], n) => [
    { name: `a${n}`, value: a },
    { name: `b${n}`, value: b },
  ]);
  const written = await sql(
    `INSERT INTO match_mutes (account_id, muted_account)
     VALUES ${values}
     ON CONFLICT DO NOTHING
     RETURNING account_id::text`,
    parameters,
  );
  inserted += written.length;
}

console.log(
  `muted ${counterparties.length} account(s) against the eval agent: ` +
    `${inserted} new mute rows written, ${pairs.length - inserted} already in place`,
);
