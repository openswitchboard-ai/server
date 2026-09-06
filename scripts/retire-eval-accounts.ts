/**
 * Take the eval harnesses' abandoned accounts off a NON-PROD board.
 *
 * THE PROBLEM. Every duet, realism, adversary and sim run provisions fresh
 * accounts and abandons them when it ends — that is deliberate, and
 * test/duet/actors.ts says so out loud. What was not deliberate is that their
 * LISTINGS stayed up. Each run's teardown withdrew the cards it remembered
 * publishing, and a driven agent publishes cards the runner never saw, so dev
 * accumulated roughly sixty dead accounts still advertising. The matcher reads
 * that board: a later run's card meets a crowd of last week's ghosts at
 * near-identical similarity, and the card that was genuinely the other half of
 * the pair never makes the candidate list.
 *
 * The teardowns themselves are fixed in test/integration/helpers.ts
 * (retireAccountCards, wired into all four harnesses). This script is for the
 * residue that is already there.
 *
 * WHO COUNTS AS EVAL-CREATED. Account emails are stored only as a sha256 hash
 * (migrations/001_init.sql), so there is no pattern to match on and no way to
 * ask "was this address a simulator address". The set is therefore built from
 * evidence that is in the database in plain text, and an account is retired
 * only when at least one of these is true of it:
 *
 *   harness-client  It authenticated through an OAuth client the harness
 *                   registers by name — 'osb-integration-suite'
 *                   (test/integration/helpers.ts), 'e2e-agent' (Playwright),
 *                   or 'probe'. No human's agent registers under those names.
 *   fixture-bucket  It owns a card in a run-scoped opaque bucket: a short
 *                   prefix, an underscore and hex — 'g_1a2b', 'sm_4d1d74',
 *                   'cd_e2d3cf'. The underscore is exactly why the helpers
 *                   chose that shape: no real place resolves to it.
 *   fixture-category It owns a card filed under 'intg-email.<hex>', a category
 *                   that is not in the taxonomy and could not have been
 *                   published by anything but the email fixtures.
 *   met-nagatha     It was matched with the standing agent under test since
 *                   --since (default 2026-09-03). Realism and adversary
 *                   bootstrap a counterpart for exactly that purpose.
 *   duet-key        It holds an agent key labelled 'duet-…', which
 *                   test/duet/provision.ts is the only thing that mints.
 *
 * AND WHO IS EXCLUDED, whatever the evidence says.
 *
 *   - Nagatha herself (411af5b9…): her account is real, standing, and her
 *     cards are the harnesses' own business, not this script's.
 *   - Any account that ever authenticated through a client that is NOT one of
 *     the harness names — 'Claude Code (openswitchboard)', 'LM Studio',
 *     'OpenClaw MCP', 'Codex', 'Google Antigravity'. A person's agent
 *     connected to it, so it is a person's account, and the fact that it may
 *     also have met an eval actor changes nothing.
 *   - Anything named in --exclude.
 *
 * WHAT IT DOES. Moves every PUBLISHED and PENDING_SCREENING card owned by
 * those accounts to WITHDRAWN — the same terminal state the owning agent
 * would put it in. Nothing is deleted, no account is touched, and matches,
 * offers and evidence rows are left exactly where they are.
 *
 * Run (dry by default):
 *   AWS_PROFILE=openswitchboard npx tsx scripts/retire-eval-accounts.ts
 *   AWS_PROFILE=openswitchboard npx tsx scripts/retire-eval-accounts.ts --apply
 * Options: --env dev  --since 2026-09-03  --exclude <uuid>[,<uuid>…]
 *
 * REFUSES to run against prod.
 */
import { ExecuteStatementCommand, RDSDataClient } from '@aws-sdk/client-rds-data';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const envName = arg('env', 'dev');
const since = arg('since', '2026-09-03');
const apply = process.argv.includes('--apply');
const region = process.env.AWS_REGION ?? 'us-east-1';

/** The standing agent under test. Never in the set, on any evidence. */
const NAGATHA = '411af5b9-b2a9-4126-83f8-73bf4934f5dd';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const excluded = [
  NAGATHA,
  ...arg('exclude', '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
];

if (envName === 'prod') {
  console.error('refusing to run against prod');
  process.exit(1);
}
if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) {
  console.error(`--since must look like 2026-09-03, got ${since}`);
  process.exit(1);
}
for (const id of excluded) {
  if (!UUID.test(id)) {
    console.error(`--exclude takes account uuids; '${id}' is not one`);
    process.exit(1);
  }
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
    row.map((f: any) =>
      f.isNull ? null : (f.stringValue ?? f.longValue ?? f.doubleValue ?? f.booleanValue ?? null),
    ),
  );
}

/** The OAuth client names only a harness registers. */
const HARNESS_CLIENTS = `('osb-integration-suite','e2e-agent','probe')`;

/** A run-scoped opaque bucket: short prefix, underscore, hex. */
const FIXTURE_BUCKET = `^[a-z0-9]{1,3}_[0-9a-f]{2,10}$`;

const params = [
  { name: 'since', value: since },
  { name: 'nagatha', value: NAGATHA },
  { name: 'excluded', value: excluded.join(',') },
];

/**
 * One row per candidate account, with every piece of evidence spelled out so
 * the dry run can be read rather than trusted.
 */
const CANDIDATES = `
WITH harness_client AS (
  SELECT DISTINCT o.account_id FROM oauth_codes o JOIN oauth_clients c USING (client_id)
   WHERE c.client_name IN ${HARNESS_CLIENTS}
  UNION
  SELECT DISTINCT t.account_id FROM oauth_tokens t JOIN oauth_clients c USING (client_id)
   WHERE c.client_name IN ${HARNESS_CLIENTS}
), real_client AS (
  SELECT DISTINCT o.account_id FROM oauth_codes o JOIN oauth_clients c USING (client_id)
   WHERE c.client_name NOT IN ${HARNESS_CLIENTS}
  UNION
  SELECT DISTINCT t.account_id FROM oauth_tokens t JOIN oauth_clients c USING (client_id)
   WHERE c.client_name NOT IN ${HARNESS_CLIENTS}
), fixture_bucket AS (
  SELECT DISTINCT account_id FROM cards WHERE geo->>'bucket' ~ '${FIXTURE_BUCKET}'
), fixture_category AS (
  SELECT DISTINCT account_id FROM cards WHERE category LIKE 'intg-email.%'
), met_nagatha AS (
  SELECT DISTINCT CASE WHEN account_want = :nagatha::uuid THEN account_have ELSE account_want END
      AS account_id
    FROM matches
   WHERE (account_want = :nagatha::uuid OR account_have = :nagatha::uuid)
     AND created_at >= :since::date
), duet_key AS (
  SELECT DISTINCT account_id FROM oauth_tokens WHERE name LIKE 'duet-%'
), evidence AS (
  SELECT a.id,
         a.created_at,
         (a.id IN (SELECT account_id FROM harness_client))   AS harness_client,
         (a.id IN (SELECT account_id FROM fixture_bucket))   AS fixture_bucket,
         (a.id IN (SELECT account_id FROM fixture_category)) AS fixture_category,
         (a.id IN (SELECT account_id FROM met_nagatha))      AS met_nagatha,
         (a.id IN (SELECT account_id FROM duet_key))         AS duet_key,
         (a.id IN (SELECT account_id FROM real_client))      AS real_client
    FROM accounts a
)
SELECT e.id::text, e.created_at::date::text,
       e.harness_client, e.fixture_bucket, e.fixture_category, e.met_nagatha, e.duet_key,
       (SELECT count(*)::int FROM cards c
         WHERE c.account_id = e.id AND c.lifecycle_state IN ('PUBLISHED','PENDING_SCREENING'))
    AS live_cards
  FROM evidence e
 WHERE (e.harness_client OR e.fixture_bucket OR e.fixture_category OR e.met_nagatha OR e.duet_key)
   AND NOT e.real_client
   AND e.id <> :nagatha::uuid
   AND NOT (e.id::text = ANY(string_to_array(:excluded, ',')))
 ORDER BY live_cards DESC, e.created_at ASC`;

const rows = await sql(CANDIDATES, params);
const REASONS = ['harness-client', 'fixture-bucket', 'fixture-category', 'met-nagatha', 'duet-key'];

interface Candidate {
  id: string;
  createdAt: string;
  reasons: string[];
  liveCards: number;
}
const candidates: Candidate[] = rows.map((r) => ({
  id: String(r[0]),
  createdAt: String(r[1]),
  reasons: REASONS.filter((_, i) => r[2 + i] === true),
  liveCards: Number(r[7]),
}));

const withCards = candidates.filter((c) => c.liveCards > 0);
const cardTotal = withCards.reduce((n, c) => n + c.liveCards, 0);

console.log(`env: ${envName}   since: ${since}   mode: ${apply ? 'APPLY' : 'dry run'}`);
console.log(
  `eval-created accounts: ${candidates.length}` +
    `   holding live cards: ${withCards.length}   live cards: ${cardTotal}`,
);
console.log('');
console.log('accounts holding live listings:');
for (const c of withCards) {
  console.log(`  ${c.id}  created ${c.createdAt}  ${String(c.liveCards).padStart(3)} card(s)  [${c.reasons.join(', ')}]`);
}
console.log('');
console.log('evidence tally (an account can carry more than one):');
for (const reason of REASONS) {
  const all = candidates.filter((c) => c.reasons.includes(reason));
  const live = all.filter((c) => c.liveCards > 0);
  console.log(
    `  ${reason.padEnd(17)} ${String(all.length).padStart(5)} account(s), ` +
      `${String(live.length).padStart(4)} of them still advertising`,
  );
}
console.log('');

if (!withCards.length) {
  console.log('nothing to retire.');
  process.exit(0);
}

if (!apply) {
  console.log(
    `dry run — pass --apply to move ${cardTotal} card(s) across ` +
      `${withCards.length} account(s) to WITHDRAWN`,
  );
  process.exit(0);
}

const retired = await sql(
  `UPDATE cards SET lifecycle_state = 'WITHDRAWN', updated_at = now()
    WHERE account_id = ANY(string_to_array(:ids, ',')::uuid[])
      AND lifecycle_state IN ('PUBLISHED','PENDING_SCREENING')
    RETURNING id`,
  [{ name: 'ids', value: withCards.map((c) => c.id).join(',') }],
);
console.log(`retired ${retired.length} card(s) across ${withCards.length} eval account(s)`);

const left = await sql(
  `SELECT count(*)::int FROM cards WHERE lifecycle_state IN ('PUBLISHED','PENDING_SCREENING')`,
);
console.log(`live cards left on the ${envName} board: ${left[0]?.[0]}`);
