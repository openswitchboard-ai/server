/**
 * Take the integration suites' leftover cards back off a NON-PROD board.
 *
 * Every suite run publishes fixture cards into run-scoped geo buckets
 * ('g_1a2b', 'mx_7f21', …) and, until the teardown in test/integration/
 * helpers.ts existed, left them there for their whole TTL. Dev accumulated
 * hundreds of near-identical cards in one category, and the matching engine
 * reads that board: a fresh card's nearest neighbours were all leftovers at
 * identical similarity, and the card that was genuinely the other half of the
 * pair never made the candidate list. (The prefilter in domain/matcher.ts is
 * the fix for the engine; this is the fix for the board.)
 *
 * Withdrawal, not deletion: the card moves to WITHDRAWN, the same terminal
 * state a person's agent puts it in, so nothing here invents a state the
 * product does not have. Matches, offers and evidence rows are untouched.
 *
 * Run (dry by default):
 *   AWS_PROFILE=openswitchboard npx tsx scripts/withdraw-fixture-cards.ts
 *   AWS_PROFILE=openswitchboard npx tsx scripts/withdraw-fixture-cards.ts --apply
 * Options: --env dev  --older-than '1 hour'
 *
 * REFUSES to run against prod: fixture buckets are a test-harness artefact
 * and there is no reason for this script to touch a real person's card.
 */
import { ExecuteStatementCommand, RDSDataClient } from '@aws-sdk/client-rds-data';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const envName = arg('env', 'dev');
const olderThan = arg('older-than', '1 hour');
const apply = process.argv.includes('--apply');
const region = process.env.AWS_REGION ?? 'us-east-1';

if (envName === 'prod') {
  console.error('refusing to run against prod');
  process.exit(1);
}
if (!/^\d+ (minute|hour|day)s?$/.test(olderThan)) {
  console.error(`--older-than must look like "90 minutes" or "1 hour", got ${olderThan}`);
  process.exit(1);
}

const ssm = new SSMClient({ region });
const rds = new RDSDataClient({ region });
const [cluster, secret] = await Promise.all([
  ssm.send(new GetParameterCommand({ Name: `/osb/${envName}/db/cluster-arn` })),
  ssm.send(new GetParameterCommand({ Name: `/osb/${envName}/db/secret-arn` })),
]);
const arns = { resourceArn: cluster.Parameter!.Value!, secretArn: secret.Parameter!.Value! };

async function sql(statement: string): Promise<any[][]> {
  const r = await rds.send(
    new ExecuteStatementCommand({ ...arns, database: 'osb', sql: statement }),
  );
  return (r.records ?? []).map((row) =>
    row.map((f: any) => (f.isNull ? null : (f.stringValue ?? f.longValue ?? f.doubleValue ?? null))),
  );
}

/**
 * A fixture bucket: a short prefix, an underscore, and hex — 'g_1a2b',
 * 'mx_7f21'. The underscore is what the helpers chose precisely because no
 * real place resolves to it, so nothing a person could have published looks
 * like this.
 */
const FIXTURE_BUCKET = `^[a-z0-9]{1,3}_[0-9a-f]{2,8}$`;
const WHERE = `lifecycle_state = 'PUBLISHED'
   AND geo->>'bucket' ~ '${FIXTURE_BUCKET}'
   AND created_at < now() - interval '${olderThan}'`;

const before = await sql(
  `SELECT split_part(geo->>'bucket', '_', 1) || '_' AS prefix, count(*)::text
     FROM cards WHERE ${WHERE} GROUP BY 1 ORDER BY count(*) DESC`,
);
const total = before.reduce((n, [, c]) => n + Number(c), 0);
console.log(`${envName}: ${total} published fixture cards older than ${olderThan}`);
for (const [prefix, count] of before) console.log(`  ${prefix} ${count}`);

if (!apply) {
  console.log('dry run — pass --apply to withdraw them');
  process.exit(0);
}

const done = await sql(
  `UPDATE cards SET lifecycle_state = 'WITHDRAWN', updated_at = now()
    WHERE ${WHERE} RETURNING id::text`,
);
console.log(`withdrew ${done.length} cards`);
