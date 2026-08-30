/**
 * Counter emails via SES.
 *
 * SES SANDBOX NOTE (phase 0.D): the openswitchboard.ai domain identity is
 * verified (DKIM + MAIL FROM green) but the account is still in the SES
 * sandbox, so sends to UNVERIFIED recipients are rejected by SES with
 * MessageRejected. Every flow still attempts the real send — the full email
 * path is exercised the moment production access lands. In DEV ONLY, a
 * sandbox rejection is logged loudly and the flow continues, because the
 * dev E2E harness reads the (single-use, 15-minute) verification token from
 * the test database instead of an inbox. That is test observability, not a
 * bypass: nothing about token validity, TTL or single-use changes. In prod
 * a send failure is a hard failure.
 */
import { SendEmailCommand } from '@aws-sdk/client-sesv2';
import { sesv2 } from '../aws.js';
import type { Config } from '../config.js';

async function send(
  cfg: Config,
  to: string,
  subject: string,
  text: string,
): Promise<{ sent: boolean; sandboxRejected?: boolean }> {
  try {
    await sesv2.send(
      new SendEmailCommand({
        FromEmailAddress: cfg.sesFrom,
        Destination: { ToAddresses: [to] },
        Content: {
          Simple: {
            Subject: { Data: subject, Charset: 'UTF-8' },
            Body: { Text: { Data: text, Charset: 'UTF-8' } },
          },
        },
      }),
    );
    return { sent: true };
  } catch (e: any) {
    const sandboxRejected =
      e?.name === 'MessageRejected' && /not verified|sandbox/i.test(String(e?.message ?? ''));
    if (cfg.envName === 'dev' && sandboxRejected) {
      // eslint-disable-next-line no-console
      console.error(
        `SES SANDBOX: send to unverified recipient rejected (dev tolerated; see counter/email.ts): ${e.message}`,
      );
      return { sent: false, sandboxRejected: true };
    }
    throw e;
  }
}

export async function sendVerificationEmail(
  cfg: Config,
  to: string,
  code: string,
  linkToken: string,
  purpose: 'register' | 'login',
): Promise<void> {
  const link = `${cfg.counterOrigin}/counter/verify?t=${encodeURIComponent(linkToken)}`;
  const what = purpose === 'register' ? 'finish setting up your account' : 'sign in';
  await send(
    cfg,
    to,
    `${code} is your OpenSwitchboard code`,
    `Your OpenSwitchboard verification code is: ${code}\n\n` +
      `Enter it at the counter to ${what}, or open this link:\n${link}\n\n` +
      `The code and link work once and expire in 15 minutes. ` +
      `If you didn't request this, ignore this email.\n\n— The counter, openswitchboard.ai`,
  );
}

export async function sendApprovalEmail(
  cfg: Config,
  to: string,
  linkToken: string,
  summary: string,
): Promise<void> {
  const link = `${cfg.counterOrigin}/counter/a/${encodeURIComponent(linkToken)}`;
  await send(
    cfg,
    to,
    'OpenSwitchboard: something is waiting for your approval',
    `${summary}\n\nReview and decide at the counter:\n${link}\n\n` +
      `The link works once and expires in 15 minutes; after that, sign in at ` +
      `${cfg.counterOrigin}/counter to review it.\n\nNothing is shared or accepted until you approve it.\n\n— The counter, openswitchboard.ai`,
  );
}

export async function sendKillSwitchEmail(cfg: Config, to: string): Promise<void> {
  await send(
    cfg,
    to,
    'OpenSwitchboard: kill switch activated',
    `The kill switch on your OpenSwitchboard account was just activated.\n\n` +
      `All of your cards are paused and your agents' tokens are suspended. ` +
      `Nothing will match, be disclosed, or be accepted while it is on.\n\n` +
      `To turn things back on, sign in at ${cfg.counterOrigin}/counter and confirm with your PIN.\n\n` +
      `If you did not do this, your account is safe (everything is paused) — ` +
      `sign in when you can and review your ledger.\n\n— The counter, openswitchboard.ai`,
  );
}
