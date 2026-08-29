/**
 * Dev/test account bootstrap (phase 0.C only; replaced by the counter's
 * registration in 0.D). Sends a create-account op to the env's INTERNAL ops
 * queue (IAM-gated; no public route) and prints the generated access code.
 * The code is scrypt-hashed CLIENT-SIDE — only the hash crosses the wire.
 *
 * Usage:
 *   npm run bootstrap-account -- --env dev --email you@example.com \
 *     --first-name Loch --locality "Fremantle"
 */
import { randomBytes, scryptSync } from 'node:crypto';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  if (fallback !== undefined) return fallback;
  console.error(`missing --${name}`);
  process.exit(1);
}

const envName = arg('env', 'dev');
if (envName === 'prod') {
  console.error('prod registration is CLOSED in phase 0.C; refusing to bootstrap a prod account');
  process.exit(1);
}
const email = arg('email');
const firstName = arg('first-name');
const locality = arg('locality');
const region = process.env.AWS_REGION ?? 'us-east-1';

const code = `osb-dev-${randomBytes(18).toString('base64url')}`;
const salt = randomBytes(16);
const hash = `scrypt$${salt.toString('hex')}$${scryptSync(code, salt, 32).toString('hex')}`;

const ssm = new SSMClient({ region });
const sqs = new SQSClient({ region });
const p = await ssm.send(
  new GetParameterCommand({ Name: `/osb/${envName}/sqs/ops-queue-url` }),
);
await sqs.send(
  new SendMessageCommand({
    QueueUrl: p.Parameter!.Value!,
    MessageBody: JSON.stringify({
      op: 'create-account',
      email,
      first_name: firstName,
      locality,
      login_code_hash: hash,
    }),
  }),
);
console.log(`create-account op sent for ${email} (${envName}).`);
console.log(`Access code (shown once, store it now): ${code}`);
