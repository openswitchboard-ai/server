/**
 * What the shadow has learned so far: read the jev_shadow table out loud.
 *
 * The trials are in src/shadow/jevTrials.ts and the whole arrangement is
 * described in docs/jev-shadow.md. The short version: an outside model is
 * asked two of this switchboard's own closed questions, its answer is written
 * down beside ours, and NOTHING acts on it. THIS SCRIPT IS THE ONLY THING IN
 * THIS REPOSITORY THAT READS THE TABLE, which is what makes "shadow" a fact
 * about the code rather than an intention.
 *
 * It prints three things:
 *
 *   1. TRIAL A, the door. How often Jev picked the same taxonomy node the
 *      switchboard filed the posting under. That rate is the number the trial
 *      exists to produce.
 *   2. THE DISAGREEMENTS, in full: what we said, what the assistant originally
 *      wrote, what Jev said instead, and how confident it was. An agreement
 *      rate on its own cannot tell you whether the disagreements are the
 *      model's mistakes or ours, and only reading them can.
 *   3. TRIAL B, the pairs. Our score and decision beside Jev's "is this the
 *      same thing" and its fit level. The interesting rows are the corners:
 *      a high score Jev says is a different thing, and a low score it says is
 *      exactly what was wanted.
 *
 * Read-only, and it REFUSES to run against prod — where the table exists and
 * is permanently empty, because the shadow is dev-only and never switched on
 * there.
 *
 *   AWS_PROFILE=openswitchboard npm run jev-report
 *   AWS_PROFILE=openswitchboard npm run jev-report -- --days 30 --limit 40
 */
import { ExecuteStatementCommand, RDSDataClient } from '@aws-sdk/client-rds-data';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const envName = arg('env', 'dev');
const days = Number(arg('days', '14'));
const limit = Number(arg('limit', '25'));
const region = process.env.AWS_REGION ?? 'us-east-1';

if (envName === 'prod') {
  console.error('refusing to run against prod: the shadow is dev-only and prod has no rows');
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
const arns = { resourceArn: cluster.Parameter!.Value!, secretArn: secret.Parameter!.Value! };

/** Every column is cast to text in the statements below, so one reader does. */
async function sql(statement: string): Promise<(string | null)[][]> {
  const r = await rds.send(
    new ExecuteStatementCommand({ ...arns, database: 'osb', sql: statement }),
  );
  return (r.records ?? []).map((row) =>
    row.map((f: any) =>
      f.isNull ? null : String(f.stringValue ?? f.longValue ?? f.doubleValue ?? f.booleanValue),
    ),
  );
}

/** The window, written once and pasted into each statement. `days` has been
 *  checked to be a small integer above, which is why it can be interpolated. */
const WINDOW = `created_at > now() - interval '${days} days'`;

function pad(s: string | null, n: number): string {
  const v = (s ?? '—').slice(0, n);
  return v + ' '.repeat(Math.max(0, n - v.length));
}

console.log(`jev shadow, ${envName}, last ${days} days\n`);

// ---------------------------------------------------------------------------
// Trial A: the door.
// ---------------------------------------------------------------------------

const [counts] = await sql(`
  SELECT count(*)::text,
         count(*) FILTER (WHERE jev->>'choice' = ours->>'category')::text,
         count(*) FILTER (WHERE ours->>'category' IS DISTINCT FROM ours->>'category_as_posted')::text,
         count(*) FILTER (WHERE (jev->>'decided')::boolean)::text,
         count(*) FILTER (WHERE (jev->>'decided')::boolean
                            AND jev->>'choice' = ours->>'category')::text,
         count(*) FILTER (WHERE jev->>'choice' = 'none_of_these')::text,
         round(avg(latency_ms))::text,
         coalesce(sum(input_tokens), 0)::text,
         coalesce(sum(output_tokens), 0)::text
    FROM jev_shadow WHERE trial = 'category' AND ${WINDOW}
`);
const total = Number(counts?.[0] ?? 0);
const agreed = Number(counts?.[1] ?? 0);
const snapped = Number(counts?.[2] ?? 0);
const decided = Number(counts?.[3] ?? 0);
const decidedAgreed = Number(counts?.[4] ?? 0);
const noneOfThese = Number(counts?.[5] ?? 0);

const pct = (n: number, of: number) => (of ? `${((n / of) * 100).toFixed(1)}%` : '—');

console.log('TRIAL A — category at the door');
if (!total) {
  console.log('  no rows yet\n');
} else {
  const uncertain = total - decided;
  console.log(`  postings asked about   ${total}`);
  console.log(`  Jev picked our node    ${agreed}  (${pct(agreed, total)})`);
  // Split by TypeSafe's application policy: an answer whose top probability
  // cleared 0.60 is one they would act on, and one that did not is noise as
  // far as any future use of this is concerned. The two rates are different
  // numbers and reporting only the blend would hide which.
  console.log(
    `    of the ${decided} decided (top p >= 0.60)   ${decidedAgreed}  (${pct(decidedAgreed, decided)})`,
  );
  console.log(
    `    of the ${uncertain} uncertain                ${agreed - decidedAgreed}  (${pct(agreed - decidedAgreed, uncertain)})`,
  );
  console.log(`  Jev said none of the options fitted    ${noneOfThese}`);
  console.log(`  of all rows, we had snapped the assistant's own path on ${snapped}`);
  console.log(
    `  mean latency ${counts?.[6] ?? '—'} ms, tokens in ${counts?.[7] ?? '0'} / out ${counts?.[8] ?? '0'}\n`,
  );

  const rows = await sql(`
    SELECT to_char(created_at, 'MM-DD HH24:MI'),
           card_id::text,
           ours->>'category',
           ours->>'category_as_posted',
           jev->>'choice',
           round((jev->>'confidence')::numeric, 2)::text
      FROM jev_shadow
     WHERE trial = 'category' AND ${WINDOW}
       AND jev->>'choice' IS DISTINCT FROM ours->>'category'
     ORDER BY (jev->>'confidence')::numeric DESC NULLS LAST, created_at DESC
     LIMIT ${limit}
  `);
  if (rows.length) {
    // Most confident first: a disagreement the model was sure about is the one
    // worth a human's attention, and an unsure one is mostly noise.
    console.log('  disagreements, most confident first');
    console.log(
      `  ${pad('when', 12)}${pad('card', 10)}${pad('ours', 30)}${pad('as posted', 30)}${pad('jev', 30)}conf`,
    );
    for (const r of rows) {
      console.log(
        `  ${pad(r[0], 12)}${pad(r[1]?.slice(0, 8) ?? null, 10)}${pad(r[2], 30)}${pad(r[3], 30)}${pad(r[4], 30)}${r[5] ?? '—'}`,
      );
    }
    console.log('');
  }
}

// ---------------------------------------------------------------------------
// Trial B: the pairs.
// ---------------------------------------------------------------------------

const pairs = await sql(`
  SELECT to_char(created_at, 'MM-DD HH24:MI'),
         card_id::text,
         other_card_id::text,
         round((ours->>'score')::numeric, 3)::text,
         ours->>'decision',
         jev->'same_kind_of_thing'->>'band',
         jev->'compatible'->>'band',
         jev->'same_specific_item'->>'band',
         jev->>'fit_score',
         jev->>'fit_legend'
    FROM jev_shadow
   WHERE trial = 'pair' AND ${WINDOW}
   ORDER BY (ours->>'score')::numeric DESC
   LIMIT ${limit}
`);

console.log('TRIAL B — want against have');
if (!pairs.length) {
  console.log('  no rows yet');
} else {
  // The bands, not the raw nouls: 0.71 and 0.94 are the same answer under
  // TypeSafe's own reading, and a column of two-decimal numbers invites
  // somebody to treat the difference as meaning something.
  console.log(
    `  ${pad('when', 12)}${pad('want', 10)}${pad('have', 10)}${pad('ours', 8)}${pad('decision', 12)}${pad('kind', 11)}${pad('compat', 11)}${pad('specific', 11)}${pad('fit', 5)}level`,
  );
  for (const r of pairs) {
    console.log(
      `  ${pad(r[0], 12)}${pad(r[1]?.slice(0, 8) ?? null, 10)}${pad(r[2]?.slice(0, 8) ?? null, 10)}` +
        `${pad(r[3], 8)}${pad(r[4], 12)}${pad(r[5], 11)}${pad(r[6], 11)}${pad(r[7], 11)}${pad(r[8], 5)}${r[9] ?? '—'}`,
    );
  }
  // The two corners the trial is actually about, counted rather than
  // eyeballed, and read through the bands for the same reason.
  const [corners] = await sql(`
    SELECT count(*) FILTER (WHERE (ours->>'score')::numeric >= 0.75
                              AND jev->'same_kind_of_thing'->>'band' = 'no')::text,
           count(*) FILTER (WHERE (ours->>'score')::numeric < 0.75
                              AND jev->'same_kind_of_thing'->>'band' = 'yes'
                              AND jev->'compatible'->>'band' = 'yes')::text,
           count(*) FILTER (WHERE jev->'compatible'->>'band' = 'uncertain')::text,
           round(avg(latency_ms))::text,
           coalesce(sum(input_tokens), 0)::text,
           coalesce(sum(output_tokens), 0)::text
      FROM jev_shadow WHERE trial = 'pair' AND ${WINDOW}
  `);
  console.log('');
  console.log(`  we introduced, Jev says a different kind of thing:   ${corners?.[0] ?? '0'}`);
  console.log(`  we did not introduce, Jev says same kind and compatible: ${corners?.[1] ?? '0'}`);
  console.log(`  compatibility Jev could not call either way:         ${corners?.[2] ?? '0'}`);
  console.log(
    `  mean latency ${corners?.[3] ?? '—'} ms, tokens in ${corners?.[4] ?? '0'} / out ${corners?.[5] ?? '0'}`,
  );
}
