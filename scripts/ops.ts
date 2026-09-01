/**
 * Internal ops CLI — sends messages to the env's IAM-gated ops queue.
 * Phase 0.C stand-in for interfaces that arrive in later phases:
 *   create-match  (0.F matching engine)  : --card-want <id> --card-have <id> [--score 0.9]
 *   accept-offer  (0.D counter human UI) : --offer-id <id> --account-id <id>
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
    body = {
      op: 'accept-offer-by-human',
      offer_id: arg('offer-id'),
      account_id: arg('account-id'),
      recorded_via: 'ops-cli',
    };
    break;
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
  default:
    console.error(
      'usage: ops.ts <create-match|accept-offer|ttl-expiry|backfill-geo|snap-categories> [--env dev] ...',
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
