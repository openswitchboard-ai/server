/**
 * Send the [SAMPLE] set for visual review / the inbox-placement gate:
 *   dev (sandbox, recipient must be verified):
 *     AWS_PROFILE=openswitchboard npx tsx scripts/send-samples.ts --to you@example.com
 *   prod (production sending from the host account, see infra/host-ses):
 *     AWS_PROFILE=openswitchboard AWS_REGION=ap-southeast-2 \
 *       SES_ASSUME_ROLE_ARN=arn:aws:iam::968431686951:role/osb-prod-email-sender \
 *       npx tsx scripts/send-samples.ts --to you@example.com --env prod --config-set osb-prod-email
 * Sends every sample template through SES with the env's configuration set,
 * the production From/reply-to and the RFC 8058 headers (sample token), each
 * subject prefixed "[SAMPLE]". Prints SES message IDs for the phase report.
 */
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { fromTemporaryCredentials } from '@aws-sdk/credential-providers';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { sampleSet } from './emailSamples.js';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main() {
  const to = arg('to', '');
  if (!to) throw new Error('--to <address> is required (a mailbox you control)');
  const envName = arg('env', 'dev');
  const region = process.env.AWS_REGION ?? 'us-east-1';
  // SSM lives with the stack (us-east-1); SES may be in the host region.
  const ssm = new SSMClient({ region: process.env.OSB_STACK_REGION ?? 'us-east-1' });
  const sesRole = process.env.SES_ASSUME_ROLE_ARN;
  const ses = new SESv2Client({
    region,
    ...(sesRole
      ? {
          credentials: fromTemporaryCredentials({
            params: { RoleArn: sesRole, RoleSessionName: 'osb-email-samples' },
            clientConfig: { region },
          }),
        }
      : {}),
  });
  const configSet =
    arg('config-set', '') ||
    (await ssm.send(new GetParameterCommand({ Name: `/osb/${envName}/ses/configuration-set` })))
      .Parameter!.Value!;

  const unsubUrl = `https://my-${envName}.openswitchboard.ai/email/unsub?t=sample`;
  for (const s of sampleSet()) {
    const r = await ses.send(
      new SendEmailCommand({
        FromEmailAddress: 'OpenSwitchboard <board@openswitchboard.ai>',
        ReplyToAddresses: ['info@openswitchboard.ai'],
        Destination: { ToAddresses: [to] },
        ConfigurationSetName: configSet,
        Content: {
          Simple: {
            Subject: { Data: `[SAMPLE] ${s.content.subject}`, Charset: 'UTF-8' },
            Body: {
              Text: { Data: s.content.text, Charset: 'UTF-8' },
              Html: { Data: s.content.html, Charset: 'UTF-8' },
            },
            Headers: [
              {
                Name: 'List-Unsubscribe',
                Value: `<mailto:unsubscribe@openswitchboard.ai?subject=unsubscribe>, <${unsubUrl}>`,
              },
              { Name: 'List-Unsubscribe-Post', Value: 'List-Unsubscribe=One-Click' },
            ],
          },
        },
      }),
    );
    console.log(`${s.name}\t${r.MessageId}`);
    await new Promise((res) => setTimeout(res, 1200)); // sandbox rate: 1/s
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
