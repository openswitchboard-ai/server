/**
 * Internal ops CLI — sends messages to the env's IAM-gated ops queue.
 * Phase 0.C stand-in for interfaces that arrive in later phases:
 *   create-match  (0.F matching engine)  : --card-want <id> --card-have <id> [--score 0.9]
 *   ttl-expiry                           : trigger an expiry sweep now
 *   backfill-geo  (0.3.0 locations)      : place cards written before 0.3.0
 *                                          [--rematch false to skip requeue]
 *   snap-categories (0.4.0 taxonomy)     : move cards off categories the
 *                                          taxonomy does not have, onto their
 *                                          nearest open node [--dry-run true]
 *                                          [--rematch false to skip requeue]
 */
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  if (fallback !== undefined) return fallback;
  console.error(`missing --${name}`);
  process.exit(1);
}

const cmd = process.argv[2];
const envName = arg('env', 'dev');
const region = process.env.AWS_REGION ?? 'us-east-1';

let body: any;
switch (cmd) {
  case 'create-match':
    body = {
      op: 'create-match',
      card_want: arg('card-want'),
      card_have: arg('card-have'),
      score: Number(arg('score', '0.9')),
    };
    break;
  case 'accept-offer':
    // Gone (N4, 30 September 2026): an accept is only ever the human's own
    // press on their page, and the ops queue refuses the op.
    console.error('accept-offer is not an ops command: only the human can accept, from their own page.');
    process.exit(2);
  case 'ttl-expiry':
    body = { op: 'ttl-expiry' };
    break;
  case 'snap-categories':
    // Move pre-taxonomy-v2 cards onto their nearest open node and hand them
    // back to the matcher. --dry-run true logs what would move and changes
    // nothing.
    body = {
      op: 'snap-categories',
      dry_run: arg('dry-run', 'false') === 'true',
      rematch: arg('rematch', 'true') !== 'false',
      ...(process.argv.includes('--min-embedding-score')
        ? { min_score: { embedding: Number(arg('min-embedding-score')) } }
        : {}),
    };
    break;
  case 'backfill-geo':
    // Place cards written before 0.3.0 and hand them back to the matcher.
    body = { op: 'backfill-geo', rematch: arg('rematch', 'true') !== 'false' };
    break;
  case 'reviewer-sign-in': {
    // A directory reviewer's account signs in with a passphrase instead of an
    // emailed code (src/counter/reviewerSignIn.ts). The account must already
    // exist. --disable ends it. Otherwise a fresh passphrase is made HERE,
    // written to --out (owner-only) and never printed; only its argon2id hash
    // is sent. Re-running renews it with a new passphrase.
    //   ops.ts reviewer-sign-in --env prod --email reviewer@example.com --out ~/reviewer.txt [--days 30] [--label "OpenAI review"]
    //   ops.ts reviewer-sign-in --env prod --email reviewer@example.com --disable
    const email = arg('email');
    if (process.argv.includes('--disable')) {
      body = { op: 'reviewer-sign-in', action: 'disable', email };
      break;
    }
    const days = Number(arg('days', '30'));
    if (!Number.isInteger(days) || days < 1 || days > 60) {
      console.error('--days must be a whole number from 1 to 60');
      process.exit(1);
    }
    if (!/@openswitchboard\.ai$/i.test(email) && envName === 'prod') {
      console.error('on prod a reviewer address must be on openswitchboard.ai');
      process.exit(1);
    }
    const out = arg('out');
    const { randomBytes } = await import('node:crypto');
    const { writeFileSync } = await import('node:fs');
    const argon2 = (await import('argon2')).default;
    const passphrase = `osb-rv-${randomBytes(24).toString('base64url')}`;
    const passphrase_hash = await argon2.hash(passphrase, {
      type: argon2.argon2id,
      memoryCost: 19456,
      timeCost: 2,
      parallelism: 1,
    });
    writeFileSync(out, passphrase + '\n', { mode: 0o600, flag: 'wx' });
    console.log(`passphrase written to ${out} (owner-only); it is not printed here`);
    console.log('the switchboard confirms in its own log; try the address at the sign-in page to check it is on');
    body = {
      op: 'reviewer-sign-in',
      action: 'enable',
      email,
      passphrase_hash,
      label: arg('label', 'directory review'),
      days,
    };
    break;
  }
  default:
    console.error(
      'usage: ops.ts <create-match|ttl-expiry|backfill-geo|snap-categories|reviewer-sign-in> [--env dev] ...',
    );
    process.exit(1);
}

const ssm = new SSMClient({ region });
const sqs = new SQSClient({ region });
const p = await ssm.send(new GetParameterCommand({ Name: `/osb/${envName}/sqs/ops-queue-url` }));
await sqs.send(
  new SendMessageCommand({ QueueUrl: p.Parameter!.Value!, MessageBody: JSON.stringify(body) }),
);
console.log(`${cmd} op sent to ${envName} ops queue`);
