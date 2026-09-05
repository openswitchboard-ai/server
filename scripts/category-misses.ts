/**
 * What the taxonomy was asked for and did not have — the demand digest.
 *
 * Every CATEGORY_PROHIBITED refusal on the taxonomy gate parks a row (see
 * migrations/020_category_misses.sql and domain/categoryMisses.ts). Grouped and
 * ranked, those rows say what the next taxonomy release should contain, in the
 * words the agents actually used.
 *
 * This is a READ, so it does not go through the ops queue the way scripts/
 * ops.ts does — there is nothing to enqueue and nothing to do asynchronously.
 * It reads the env's database directly over the RDS Data API, exactly as
 * scripts/withdraw-fixture-cards.ts does, resolving the cluster and secret ARNs
 * from the same SSM parameters the deployment publishes.
 *
 * Run:
 *   AWS_PROFILE=openswitchboard npx tsx scripts/category-misses.ts
 *   AWS_PROFILE=openswitchboard npx tsx scripts/category-misses.ts --days 30 --env dev
 *
 * Options: --env dev|prod   --days 14   --limit 50
 */
import { ExecuteStatementCommand, RDSDataClient } from '@aws-sdk/client-rds-data';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { CATEGORY_MISS_DIGEST_SQL } from '../src/domain/categoryMisses.js';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const envName = arg('env', 'dev');
const days = Number(arg('days', '14'));
const limit = Number(arg('limit', '50'));
const region = process.env.AWS_REGION ?? 'us-east-1';

if (!Number.isInteger(days) || days < 1) {
  console.error(`--days must be a positive whole number of days, got ${arg('days', '14')}`);
  process.exit(1);
}
if (!Number.isInteger(limit) || limit < 1) {
  console.error(`--limit must be a positive whole number, got ${arg('limit', '50')}`);
  process.exit(1);
}

const ssm = new SSMClient({ region });
const rds = new RDSDataClient({ region });
const [cluster, secret] = await Promise.all([
  ssm.send(new GetParameterCommand({ Name: `/osb/${envName}/db/cluster-arn` })),
  ssm.send(new GetParameterCommand({ Name: `/osb/${envName}/db/secret-arn` })),
]);
const arns = { resourceArn: cluster.Parameter!.Value!, secretArn: secret.Parameter!.Value! };

const r = await rds.send(
  new ExecuteStatementCommand({
    ...arns,
    database: 'osb',
    // The same statement the server's categoryMissDigest() runs, so the CLI and
    // any in-process reader can never drift into answering different questions.
    sql: CATEGORY_MISS_DIGEST_SQL.replace(/\$1/g, ':days'),
    parameters: [{ name: 'days', value: { longValue: days } }],
  }),
);

const rows = (r.records ?? []).map((row: any[]) =>
  row.map((f: any) => (f.isNull ? null : (f.stringValue ?? f.longValue ?? f.doubleValue ?? null))),
);

if (rows.length === 0) {
  console.log(`${envName}: no category misses in the last ${days} days.`);
  process.exit(0);
}

// A plain fixed-width table: the point is that a person can read it.
const header = ['requested', 'count', 'top suggestion', 'last seen'];
const body = rows
  .slice(0, limit)
  .map(([requested, count, top, lastSeen]) => [
    String(requested),
    String(count),
    top === null ? '—' : String(top),
    String(lastSeen ?? '').slice(0, 19).replace('T', ' '),
  ]);
const widths = header.map((h, i) =>
  Math.max(h.length, ...body.map((cells) => cells[i].length)),
);
const line = (cells: string[]) =>
  cells.map((c, i) => (i === 1 ? c.padStart(widths[i]) : c.padEnd(widths[i]))).join('  ');

const total = rows.reduce((n, [, count]) => n + Number(count), 0);
console.log(`${envName}: ${rows.length} distinct categories missed, ${total} refusals, last ${days} days`);
console.log('');
console.log(line(header));
console.log(widths.map((w) => '-'.repeat(w)).join('  '));
for (const cells of body) console.log(line(cells));
if (rows.length > body.length) {
  console.log('');
  console.log(`… ${rows.length - body.length} more (raise --limit to see them)`);
}
