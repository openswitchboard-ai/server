/**
 * The shelf gap log, read out loud: where the catalogue is missing a shelf.
 *
 * Every time the posting door was unsure which shelf a thing belonged on, it
 * wrote a row to shelf_gaps, and one more when the human's answer came back
 * (src/domain/shelfGaps.ts, migrations/049). This prints the last N days of
 * them two ways:
 *
 *   1. BY THE POSTERS' OWN WORDS, folded so "Sim racing pedals" and
 *      "sim-racing pedal" land together:
 *        sim racing pedal: 14 times, picked console accessories 6, none of these 5
 *   2. BY THE PATH THE ASSISTANT SENT, which says where assistants reach for a
 *      branch the catalogue does not have.
 *
 * Read-only. No account ids exist in the table to print, and nothing but the
 * poster's words, the path and the shelves is in a row.
 *
 *   AWS_PROFILE=openswitchboard npm run shelf-gaps
 *   AWS_PROFILE=openswitchboard npm run shelf-gaps -- --days 30 --env prod --limit 40
 */
import { ExecuteStatementCommand, RDSDataClient } from '@aws-sdk/client-rds-data';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import {
  SHELF_GAP_OUTCOMES,
  shelfGapLine,
  summariseShelfGaps,
  type ShelfGapRow,
} from '../../src/domain/shelfGaps.js';
import { shelfInWords } from '../../src/domain/shelfPick.js';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const envName = arg('env', 'dev');
const days = Number(arg('days', '14'));
const limit = Number(arg('limit', '25'));
const region = process.env.AWS_REGION ?? 'us-east-1';

if (!['dev', 'prod'].includes(envName)) {
  console.error(`--env takes dev or prod, got ${envName}`);
  process.exit(1);
}
if (!Number.isInteger(days) || days < 1 || days > 365) {
  console.error(`--days takes 1..365, got ${arg('days', '14')}`);
  process.exit(1);
}
if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
  console.error(`--limit takes 1..500, got ${arg('limit', '25')}`);
  process.exit(1);
}

const ssm = new SSMClient({ region });
const rds = new RDSDataClient({ region });
const [cluster, secret] = await Promise.all([
  ssm.send(new GetParameterCommand({ Name: `/osb/${envName}/db/cluster-arn` })),
  ssm.send(new GetParameterCommand({ Name: `/osb/${envName}/db/secret-arn` })),
]);
const r = await rds.send(
  new ExecuteStatementCommand({
    resourceArn: cluster.Parameter!.Value!,
    secretArn: secret.Parameter!.Value!,
    database: 'osb',
    sql: `SELECT as_posted, kind, outcome, picked FROM shelf_gaps
           WHERE created_at > now() - make_interval(days => CAST(:days AS int))
           ORDER BY created_at`,
    parameters: [{ name: 'days', value: { stringValue: String(days) } }],
  }),
);
const rows: ShelfGapRow[] = (r.records ?? []).map((rec) => {
  const [as_posted, kind, outcome, picked] = rec.map((f: any) => (f.isNull ? null : f.stringValue));
  return { as_posted, kind, outcome, picked } as ShelfGapRow;
});

const words = (category: string) => shelfInWords(category);
const counts = Object.fromEntries(SHELF_GAP_OUTCOMES.map((o) => [o, 0])) as Record<string, number>;
for (const row of rows) counts[row.outcome] = (counts[row.outcome] ?? 0) + 1;

console.log(`shelf gaps on ${envName}, last ${days} days: ${rows.length} rows`);
console.log(
  '  ' +
    SHELF_GAP_OUTCOMES.map((o) => `${o} ${counts[o]}`).join(', '),
);
console.log('\nby the posters’ own words');
for (const g of summariseShelfGaps(rows, 'kind').slice(0, limit)) console.log(`  ${shelfGapLine(g, words)}`);
console.log('\nby the path the assistant sent');
for (const g of summariseShelfGaps(rows, 'as_posted').slice(0, limit)) console.log(`  ${shelfGapLine(g, words)}`);
